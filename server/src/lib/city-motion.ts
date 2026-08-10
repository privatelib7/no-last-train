import { db } from './db'
import {
  advanceVehicleMotion,
  depotPulloutMinutes,
  getTransitMotionPhysics,
  stationDwellMinutes,
  type TransitMotionPhysics,
} from './vehicle-motion'
import { SIM } from '@/types/game'

/** 클라이언트가 따라갈 미리보기 상한 (게임 화면과 동일) */
export const MOTION_MAX_PREVIEW_TICKS = 1.25

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

export async function buildCityMotionSnapshot(cityId: string): Promise<CityMotionSnapshot | null> {
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

  const serverNow = Date.now()
  const lastTickAtMs = city.lastTickAt.getTime()
  const rawLiveTicks = city.status === 'ACTIVE'
    ? Math.max(0, (serverNow - lastTickAtMs) / SIM.LIVE_TICK_MS)
    : 0
  const previewTicks = Math.min(rawLiveTicks, MOTION_MAX_PREVIEW_TICKS)
  const syncTick = city.currentTick + previewTicks
  const elapsedGameMinutes = previewTicks * SIM.GAME_MINUTES_PER_TICK

  const vehicles: CityMotionVehicle[] = []

  for (const line of city.lines) {
    const stations = line.lineStations.map(ls => ls.station)
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
      const base: CityMotionVehicle = {
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
          base.fromStationId = terminus.id
          base.toStationId = terminus.id
          base.x = line.depotX
          base.y = line.depotY
          base.isDwelling = true
        }
        vehicles.push(base)
        continue
      }

      if (line.status !== 'OPERATING' || vehicle.status !== 'OPERATING') {
        const station = stations.find(s => s.id === vehicle.currentStationId) ?? stations[0]
        if (station) {
          base.fromStationId = station.id
          base.x = station.posX
          base.y = station.posY
          base.isDwelling = true
        }
        vehicles.push(base)
        continue
      }

      const storedProgress = vehicle.segmentProgressMinutes || 0
      const baseDwell = stationDwellMinutes(line.mode)
      const pullout = depotPulloutMinutes(line.mode)
      const launchingFromDepot = storedProgress < -baseDwell

      // 출고 중에는 미리보기를 과하게 쓰지 않고 출고 구간만 소비
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
        ...base,
        // currentStationId / direction / segmentProgressMinutes 는 DB 원본 유지
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
    cityId: city.id,
    status: city.status,
    serverNow,
    currentTick: city.currentTick,
    lastTickAt: city.lastTickAt.toISOString(),
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
