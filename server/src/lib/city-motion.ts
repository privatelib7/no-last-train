import { db } from './db'
import {
  advanceVehicleMotion,
  depotPulloutMinutes,
  getTransitMotionPhysics,
  stationDwellMinutes,
  type TransitMotionPhysics,
} from './vehicle-motion'
import { safeRedisCall } from './redis-client'
import { SIM } from '@/types/game'

/** Redis는 순수 보조 캐시 — PostgreSQL이 여전히 유일한 진실 공급원(source of truth)이다 */
const REDIS_BASE_KEY_PREFIX = 'nlt:motion:base:'
const REDIS_BASE_TTL_SEC = 15
export const REDIS_MOTION_UPDATE_CHANNEL = 'nlt:motion:updates'

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
  /** 역별 대기 승객 수 — city state(2500ms)보다 훨씬 자주(sync 주기) 갱신된다 */
  stationStats: CityMotionStationStat[]
}

export type CityMotionStationStat = { stationId: string; waitingCount: number }

/**
 * 역별 대기 승객 수(탑승 전) — city-state.ts의 stationStats와 같은 질의를 공유한다.
 * cityId+boardedAtTick 인덱스가 있어야 이 빈도(수백ms)로 불러도 부담이 없다.
 */
export async function loadStationWaitingCounts(cityId: string): Promise<CityMotionStationStat[]> {
  const rows = await db.passenger.groupBy({
    by: ['originStationId'],
    where: { cityId, boardedAtTick: null },
    _count: { id: true },
  })
  return rows.map(row => ({ stationId: row.originStationId, waitingCount: row._count.id }))
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
  stationStats: CityMotionStationStat[]
  loadedAt: number
}

const motionBaseCache = new Map<string, CityMotionBase>()

export function invalidateCityMotionCache(cityId?: string) {
  if (cityId) {
    motionBaseCache.delete(cityId)
    void safeRedisCall(client => client.del(REDIS_BASE_KEY_PREFIX + cityId))
  } else {
    motionBaseCache.clear()
  }
}

/**
 * Redis pub/sub으로 받은(또는 이미 계산해둔) base를 로컬 메모리에 바로 반영한다.
 * DB/Redis 왕복 없이 즉시 다음 push부터 새 상태로 그린다.
 */
export function setCachedMotionBase(base: CityMotionBase) {
  motionBaseCache.set(base.cityId, base)
}

/** 로컬 메모리에 없을 때 PostgreSQL을 치기 전에 먼저 확인하는 보조 캐시 조회 */
async function readMotionBaseFromRedis(cityId: string): Promise<CityMotionBase | null> {
  const raw = await safeRedisCall(client => client.get(REDIS_BASE_KEY_PREFIX + cityId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as CityMotionBase
  } catch {
    return null
  }
}

/** DB에서 새로 읽은 base를 Redis에 채워두고(TTL) 구독자들에게 즉시 알린다 */
function publishMotionBase(base: CityMotionBase) {
  const payload = JSON.stringify(base)
  void safeRedisCall(client => client.set(REDIS_BASE_KEY_PREFIX + base.cityId, payload, 'EX', REDIS_BASE_TTL_SEC))
  void safeRedisCall(client => client.publish(REDIS_MOTION_UPDATE_CHANNEL, payload))
}

/**
 * 캐시를 비우지 않고 DB에서 읽어 원자적으로 교체한다.
 * (invalidate → load 사이에 push가 캐시 미스로 DB를 치면 끊김이 난다)
 */
export async function refreshCityMotionBase(cityId: string): Promise<CityMotionBase | null> {
  return loadCityMotionBase(cityId)
}

export async function loadCityMotionBase(cityId: string): Promise<CityMotionBase | null> {
  const [city, stationStats] = await Promise.all([
    db.city.findUnique({
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
    }),
    loadStationWaitingCounts(cityId),
  ])
  if (!city) return null

  const base: CityMotionBase = {
    cityId: city.id,
    status: city.status,
    currentTick: city.currentTick,
    lastTickAtMs: city.lastTickAt.getTime(),
    stationStats,
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
  publishMotionBase(base)
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
    stationStats: base.stationStats,
  }
}

/**
 * push 경로: 로컬 메모리 → (미스 시) Redis 보조 캐시 → (그마저 없으면) PostgreSQL 순으로
 * 찾는다. 어느 단계든 DB를 직접 치지 않고도 답이 나오면 그걸로 렌더하므로,
 * 다중 realtime-server 인스턴스로 늘어나도 각자 PostgreSQL을 반복해서 두드리지 않는다.
 * sync/구독 경로: forceRefresh로 PostgreSQL에서 베이스를 갱신한 뒤 렌더.
 */
export async function buildCityMotionSnapshot(
  cityId: string,
  options?: { forceRefresh?: boolean },
): Promise<CityMotionSnapshot | null> {
  const forceRefresh = options?.forceRefresh ?? false
  let base = motionBaseCache.get(cityId) ?? null
  if (!forceRefresh && !base) {
    base = await readMotionBaseFromRedis(cityId)
    if (base) motionBaseCache.set(cityId, base)
  }
  if (forceRefresh || !base) {
    base = await loadCityMotionBase(cityId)
  }
  if (!base) {
    motionBaseCache.delete(cityId)
    return null
  }
  return renderCityMotionSnapshot(base)
}
