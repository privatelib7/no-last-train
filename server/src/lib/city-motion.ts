import { db } from './db'
import {
  advanceVehicleMotion,
  depotPulloutMinutes,
  getTransitMotionPhysics,
  stationDwellMinutes,
  type TransitMotionPhysics,
} from './vehicle-motion'
import { SIM } from '@/types/game'

/**
 * 마지막 DB 틱 이후 벽시계로 미리 보여줄 수 있는 최대 틱.
 * sync가 잠깐 늦어도(수 초) 화면 차량이 멈추지 않게 여유를 둔다.
 * 승차는 여전히 DB 틱에서만 확정되므로, 시각만 조금 앞설 수 있다.
 */
export const MOTION_MAX_PREVIEW_TICKS = 4

export type CityMotionVehicle = {
  id: string
  lineId: string
  mode: 'SUBWAY' | 'BUS' | string
  status: string
  isSpare: boolean
  /** DB 원본 — 클라이언트가 syncTick에 맞춰 추가 보간할 때 사용 */
  currentStationId: string | null
  direction: number
  segmentProgressMinutes: number
  /** syncTick 시점의 렌더 좌표/상태 */
  fromStationId: string | null
  toStationId: string | null
  x: number | null
  y: number | null
  progress: number
  dwellRemainingMinutes: number
  isDwelling: boolean
  isPullingOut: boolean
  segmentDurationMinutes: number
  renderSegmentProgressMinutes: number
}

export type CityMotionSnapshot = {
  cityId: string
  status: string
  serverNow: number
  currentTick: number
  lastTickAt: string
  liveTickMs: number
  gameMinutesPerTick: number
  /** 벽시계 1초당 게임 분 — 클라이언트 coast 속도를 서버 틱과 맞출 때 사용 */
  gameMinutesPerWallSecond: number
  maxPreviewTicks: number
  /** 클라이언트가 맞춰야 하는 연속 틱 (currentTick + preview) */
  syncTick: number
  previewTicks: number
  /** 버스/지하철 속도·정차 등 — 서버 시뮬과 동일 값 */
  physics: TransitMotionPhysics
  vehicles: CityMotionVehicle[]
}

type CachedStation = { id: string; posX: number; posY: number }

type CachedVehicle = {
  id: string
  status: string
  isSpare: boolean
  currentStationId: string | null
  direction: number
  segmentProgressMinutes: number
}

type CachedLine = {
  id: string
  mode: string
  status: string
  depotX: number
  depotY: number
  stations: CachedStation[]
  vehicles: CachedVehicle[]
}

/** DB에서 읽은 고정 상태 — 벽시계만 바꿔 여러 번 렌더할 수 있다 */
export type CityMotionBase = {
  cityId: string
  status: string
  currentTick: number
  lastTickAtMs: number
  lines: CachedLine[]
  loadedAt: number
}

const motionBaseCache = new Map<string, CityMotionBase>()

export function invalidateCityMotionCache(cityId?: string) {
  if (cityId) motionBaseCache.delete(cityId)
  else motionBaseCache.clear()
}

/**
 * 캐시를 비우지 않고 DB에서 읽어 원자적으로 교체한다.
 * (invalidate → load 사이에 push가 캐시 미스로 DB를 치면 끊김이 난다)
 */
export async function refreshCityMotionBase(cityId: string): Promise<CityMotionBase | null> {
  return loadCityMotionBase(cityId)
}

export async function loadCityMotionBase(cityId: string): Promise<CityMotionBase | null> {
  const city = await db.city.findUnique({
    where: { id: cityId },
    select: {
      id: true,
      status: true,
      currentTick: true,
      lastTickAt: true,
      lines: {
        include: {
          lineStations: {
            include: { station: true },
            orderBy: { order: 'asc' },
          },
          vehicles: { orderBy: { id: 'asc' } },
        },
      },
    },
  })
  if (!city) return null

  const base: CityMotionBase = {
    cityId: city.id,
    status: city.status,
    currentTick: city.currentTick,
    lastTickAtMs: city.lastTickAt.getTime(),
    loadedAt: Date.now(),
    lines: city.lines.map(line => ({
      id: line.id,
      mode: line.mode,
      status: line.status,
      depotX: line.depotX,
      depotY: line.depotY,
      stations: line.lineStations.map(ls => ({
        id: ls.station.id,
        posX: ls.station.posX,
        posY: ls.station.posY,
      })),
      vehicles: line.vehicles.map(vehicle => ({
        id: vehicle.id,
        status: vehicle.status,
        isSpare: vehicle.isSpare,
        currentStationId: vehicle.currentStationId,
        direction: vehicle.direction,
        segmentProgressMinutes: vehicle.segmentProgressMinutes,
      })),
    })),
  }
  motionBaseCache.set(cityId, base)
  return base
}

/**
 * 캐시된 DB 상태 + 현재 시각으로 차량 좌표를 계산한다 (DB I/O 없음).
 * 같은 베이스로 100ms마다 호출해도 preview만 전진해 부드럽게 이어진다.
 */
export function renderCityMotionSnapshot(
  base: CityMotionBase,
  serverNow = Date.now(),
): CityMotionSnapshot {
  const rawLiveTicks = base.status === 'ACTIVE'
    ? Math.max(0, (serverNow - base.lastTickAtMs) / SIM.LIVE_TICK_MS)
    : 0
  const previewTicks = Math.min(rawLiveTicks, MOTION_MAX_PREVIEW_TICKS)
  const syncTick = base.currentTick + previewTicks
  const elapsedGameMinutes = previewTicks * SIM.GAME_MINUTES_PER_TICK

  const vehicles: CityMotionVehicle[] = []

  for (const line of base.lines) {
    const stations = line.stations
    const terminus = (() => {
      if (stations.length === 0) return null
      if (stations.length === 1) return stations[0]
      const first = stations[0]
      const last = stations[stations.length - 1]
      const distFirst = Math.hypot(first.posX - line.depotX, first.posY - line.depotY)
      const distLast = Math.hypot(last.posX - line.depotX, last.posY - line.depotY)
      return distLast <= distFirst ? last : first
    })()

    for (const vehicle of line.vehicles) {
      const baseVehicle: CityMotionVehicle = {
        id: vehicle.id,
        lineId: line.id,
        mode: line.mode,
        status: vehicle.status,
        isSpare: vehicle.isSpare,
        currentStationId: vehicle.currentStationId,
        direction: vehicle.direction,
        segmentProgressMinutes: vehicle.segmentProgressMinutes,
        fromStationId: vehicle.currentStationId,
        toStationId: null,
        x: null,
        y: null,
        progress: 0,
        dwellRemainingMinutes: 0,
        isDwelling: false,
        isPullingOut: false,
        segmentDurationMinutes: 0,
        renderSegmentProgressMinutes: vehicle.segmentProgressMinutes,
      }

      if (vehicle.isSpare || vehicle.status === 'SPARE' || !vehicle.currentStationId) {
        if (terminus) {
          baseVehicle.fromStationId = terminus.id
          baseVehicle.toStationId = terminus.id
          baseVehicle.x = line.depotX
          baseVehicle.y = line.depotY
          baseVehicle.isDwelling = true
        }
        vehicles.push(baseVehicle)
        continue
      }

      if (line.status !== 'OPERATING' || vehicle.status !== 'OPERATING') {
        const station = stations.find(s => s.id === vehicle.currentStationId) ?? stations[0]
        if (station) {
          baseVehicle.fromStationId = station.id
          baseVehicle.x = station.posX
          baseVehicle.y = station.posY
          baseVehicle.isDwelling = true
        }
        vehicles.push(baseVehicle)
        continue
      }

      const storedProgress = vehicle.segmentProgressMinutes || 0
      const baseDwell = stationDwellMinutes(line.mode)
      const pullout = depotPulloutMinutes(line.mode)
      const launchingFromDepot = storedProgress < -baseDwell

      const stepMinutes = launchingFromDepot
        ? Math.min(elapsedGameMinutes, Math.max(0, -storedProgress - 0.05))
        : elapsedGameMinutes

      const motion = advanceVehicleMotion(stations, {
        currentStationId: vehicle.currentStationId,
        direction: vehicle.direction,
        segmentProgressMinutes: vehicle.segmentProgressMinutes,
      }, stepMinutes, line.mode)

      const atDepotTerminus = !!terminus
        && motion.currentStationId === terminus.id
        && motion.isDwelling
        && motion.dwellRemainingMinutes > baseDwell

      let x = motion.x
      let y = motion.y
      let progress = motion.progress
      let isPullingOut = false

      if (atDepotTerminus) {
        const pulloutLeft = Math.min(pullout, motion.dwellRemainingMinutes - baseDwell)
        const t = Math.max(0, Math.min(1, 1 - pulloutLeft / pullout))
        x = line.depotX + (terminus.posX - line.depotX) * t
        y = line.depotY + (terminus.posY - line.depotY) * t
        progress = t
        isPullingOut = true
      }

      vehicles.push({
        ...baseVehicle,
        fromStationId: motion.currentStationId,
        toStationId: motion.nextStationId,
        x,
        y,
        progress,
        dwellRemainingMinutes: motion.dwellRemainingMinutes,
        isDwelling: motion.isDwelling,
        isPullingOut,
        segmentDurationMinutes: motion.segmentDurationMinutes,
        renderSegmentProgressMinutes: motion.segmentProgressMinutes,
      })
    }
  }

  return {
    cityId: base.cityId,
    status: base.status,
    serverNow,
    currentTick: base.currentTick,
    lastTickAt: new Date(base.lastTickAtMs).toISOString(),
    liveTickMs: SIM.LIVE_TICK_MS,
    gameMinutesPerTick: SIM.GAME_MINUTES_PER_TICK,
    gameMinutesPerWallSecond: SIM.GAME_MINUTES_PER_TICK / (SIM.LIVE_TICK_MS / 1000),
    maxPreviewTicks: MOTION_MAX_PREVIEW_TICKS,
    syncTick,
    previewTicks,
    physics: getTransitMotionPhysics(),
    vehicles,
  }
}

/**
 * push 경로: 캐시가 있으면 무조건 캐시로 렌더(DB 금지).
 * sync/구독 경로: forceRefresh로 베이스를 갱신한 뒤 렌더.
 */
export async function buildCityMotionSnapshot(
  cityId: string,
  options?: { forceRefresh?: boolean },
): Promise<CityMotionSnapshot | null> {
  const forceRefresh = options?.forceRefresh ?? false
  let base = motionBaseCache.get(cityId) ?? null
  if (forceRefresh || !base) {
    base = await loadCityMotionBase(cityId)
  }
  if (!base) {
    motionBaseCache.delete(cityId)
    return null
  }
  return renderCityMotionSnapshot(base)
}
