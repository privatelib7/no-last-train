import type { GameLine, Station, Vehicle } from './api/game'

export type RenderedVehicleMotion = {
  fromStation: Station | null
  toStation: Station | null
  arrivedStationIds: string[]
  direction: number
  segmentDurationMinutes: number
  segmentProgressMinutes: number
  dwellRemainingMinutes: number
  isDwelling: boolean
  /** 차고지에서 종점으로 빠져나오는 중 */
  isPullingOut: boolean
  progress: number
  x: number | null
  y: number | null
}

const MODE_SPEED: Record<GameLine['mode'], number> = {
  SUBWAY: 1.05,
  BUS: 1.0,
}

const MODE_DURATION_LIMITS: Record<GameLine['mode'], { min: number; max: number }> = {
  SUBWAY: { min: 4, max: 28 },
  BUS: { min: 4, max: 28 },
}

const MODE_DWELL_MINUTES: Record<GameLine['mode'], number> = {
  SUBWAY: 1.5,
  BUS: 2.0,
}

const MODE_DEPOT_PULLOUT_MINUTES: Record<GameLine['mode'], number> = {
  SUBWAY: 1.2,
  BUS: 1.8,
}

// 서버 vehicle-motion.ts와 같은 계산식이어야 한다.
export function segmentTravelMinutes(from: Station, to: Station, mode: GameLine['mode']): number {
  const distance = Math.hypot(to.posX - from.posX, to.posY - from.posY)
  const limits = MODE_DURATION_LIMITS[mode]
  const rawMinutes = distance / MODE_SPEED[mode]
  const clamped = Math.max(limits.min, Math.min(limits.max, rawMinutes))
  return Math.round(clamped * 2) / 2
}

export function stationDwellMinutes(mode: GameLine['mode']): number {
  return MODE_DWELL_MINUTES[mode]
}

export function depotPulloutMinutes(mode: GameLine['mode']): number {
  return MODE_DEPOT_PULLOUT_MINUTES[mode]
}

function orderedStations(line: GameLine) {
  return line.lineStations.slice().sort((a, b) => a.order - b.order).map(item => item.station)
}

export function depotTerminusOf(line: GameLine): Station | null {
  const stations = orderedStations(line)
  if (stations.length === 0) return null
  if (stations.length === 1) return stations[0]
  const first = stations[0]
  const last = stations[stations.length - 1]
  const distFirst = Math.hypot(first.posX - line.depotX, first.posY - line.depotY)
  const distLast = Math.hypot(last.posX - line.depotX, last.posY - line.depotY)
  return distFirst <= distLast ? first : last
}

function nextStation(stations: Station[], currentIndex: number, currentDirection: number) {
  let direction = currentDirection >= 0 ? 1 : -1
  let nextIndex = currentIndex + direction
  if (nextIndex < 0 || nextIndex >= stations.length) {
    direction *= -1
    nextIndex = currentIndex + direction
  }
  return { direction, nextIndex }
}

function idleMotion(
  partial: Partial<RenderedVehicleMotion> & { x: number | null; y: number | null },
): RenderedVehicleMotion {
  return {
    fromStation: null,
    toStation: null,
    arrivedStationIds: [],
    direction: 1,
    segmentDurationMinutes: 0,
    segmentProgressMinutes: 0,
    dwellRemainingMinutes: 0,
    isDwelling: false,
    isPullingOut: false,
    progress: 0,
    ...partial,
  }
}

export function locateVehicle(
  line: GameLine,
  vehicle: Vehicle,
  elapsedGameMinutes: number,
): RenderedVehicleMotion {
  const stations = orderedStations(line)
  const terminus = depotTerminusOf(line)

  // 차고지 대기: 맵 밖이 아니라 depot 좌표에 세워 둔다
  if (vehicle.isSpare || vehicle.status === 'SPARE' || !vehicle.currentStationId) {
    if (!terminus) return idleMotion({ x: null, y: null })
    return idleMotion({
      fromStation: terminus,
      toStation: terminus,
      direction: vehicle.direction >= 0 ? 1 : -1,
      isDwelling: true,
      x: line.depotX,
      y: line.depotY,
    })
  }

  if (stations.length === 0) {
    return idleMotion({ x: null, y: null })
  }

  let currentIndex = stations.findIndex(station => station.id === vehicle.currentStationId)
  if (currentIndex < 0) currentIndex = 0
  let direction = vehicle.direction >= 0 ? 1 : -1
  const storedProgressMinutes = vehicle.segmentProgressMinutes || 0
  let dwellRemainingMinutes = storedProgressMinutes < 0 ? -storedProgressMinutes : 0
  let segmentProgressMinutes = Math.max(0, storedProgressMinutes)
  let remainingMinutes = Math.max(0, elapsedGameMinutes)
  const arrivedStationIds: string[] = []
  let guard = 0

  if (stations.length === 1) {
    const station = stations[currentIndex]
    if (dwellRemainingMinutes > 0 && remainingMinutes > 0) {
      if (remainingMinutes < dwellRemainingMinutes) {
        dwellRemainingMinutes -= remainingMinutes
        remainingMinutes = 0
      } else {
        remainingMinutes -= dwellRemainingMinutes
        dwellRemainingMinutes = 0
      }
    }
    const baseDwell = stationDwellMinutes(line.mode)
    const pullout = depotPulloutMinutes(line.mode)
    // 단일 역 노선도 출고 연출은 보여 준다
    if (dwellRemainingMinutes > baseDwell && terminus && station.id === terminus.id) {
      const pulloutLeft = Math.min(pullout, dwellRemainingMinutes - baseDwell)
      const t = 1 - pulloutLeft / pullout
      return {
        fromStation: station,
        toStation: station,
        arrivedStationIds,
        direction,
        segmentDurationMinutes: pullout,
        segmentProgressMinutes: -dwellRemainingMinutes,
        dwellRemainingMinutes,
        isDwelling: true,
        isPullingOut: true,
        progress: t,
        x: line.depotX + (station.posX - line.depotX) * t,
        y: line.depotY + (station.posY - line.depotY) * t,
      }
    }
    return {
      fromStation: station,
      toStation: null,
      arrivedStationIds,
      direction,
      segmentDurationMinutes: 0,
      segmentProgressMinutes: dwellRemainingMinutes > 0 ? -dwellRemainingMinutes : 0,
      dwellRemainingMinutes,
      isDwelling: dwellRemainingMinutes > 0,
      isPullingOut: false,
      progress: 0,
      x: station.posX,
      y: station.posY,
    }
  }

  while (remainingMinutes > 0 && guard < 10_000) {
    guard += 1
    if (dwellRemainingMinutes > 0) {
      if (remainingMinutes < dwellRemainingMinutes) {
        dwellRemainingMinutes -= remainingMinutes
        remainingMinutes = 0
        break
      }
      remainingMinutes -= dwellRemainingMinutes
      dwellRemainingMinutes = 0
      if (remainingMinutes === 0) break
    }

    const next = nextStation(stations, currentIndex, direction)
    direction = next.direction
    const from = stations[currentIndex]
    const to = stations[next.nextIndex]
    const duration = segmentTravelMinutes(from, to, line.mode)
    segmentProgressMinutes = Math.min(segmentProgressMinutes, duration)
    const minutesToArrival = duration - segmentProgressMinutes

    if (remainingMinutes < minutesToArrival) {
      segmentProgressMinutes += remainingMinutes
      remainingMinutes = 0
      break
    }

    remainingMinutes -= minutesToArrival
    currentIndex = next.nextIndex
    segmentProgressMinutes = 0
    dwellRemainingMinutes = stationDwellMinutes(line.mode)
    arrivedStationIds.push(stations[currentIndex].id)
    if (remainingMinutes === 0) break
  }

  const next = nextStation(stations, currentIndex, direction)
  direction = next.direction
  const fromStation = stations[currentIndex]
  const toStation = stations[next.nextIndex]
  const segmentDurationMinutes = segmentTravelMinutes(fromStation, toStation, line.mode)
  const isDwelling = dwellRemainingMinutes > 0
  const baseDwell = stationDwellMinutes(line.mode)
  const pullout = depotPulloutMinutes(line.mode)
  const atDepotTerminus = !!terminus && fromStation.id === terminus.id
  // 운행 시작 시에만 dwell > 기본 정차 — 출고 구간으로 해석
  const isPullingOut = isDwelling && atDepotTerminus && dwellRemainingMinutes > baseDwell
  const persistedProgressMinutes = isDwelling ? -dwellRemainingMinutes : segmentProgressMinutes

  if (isPullingOut) {
    const pulloutLeft = Math.min(pullout, dwellRemainingMinutes - baseDwell)
    const t = Math.max(0, Math.min(1, 1 - pulloutLeft / pullout))
    return {
      fromStation,
      toStation: fromStation,
      arrivedStationIds,
      direction,
      segmentDurationMinutes: pullout,
      segmentProgressMinutes: persistedProgressMinutes,
      dwellRemainingMinutes,
      isDwelling: true,
      isPullingOut: true,
      progress: t,
      x: line.depotX + (fromStation.posX - line.depotX) * t,
      y: line.depotY + (fromStation.posY - line.depotY) * t,
    }
  }

  const progress = !isDwelling && segmentDurationMinutes > 0
    ? Math.max(0, Math.min(1, segmentProgressMinutes / segmentDurationMinutes))
    : 0

  return {
    fromStation,
    toStation,
    arrivedStationIds,
    direction,
    segmentDurationMinutes,
    segmentProgressMinutes: persistedProgressMinutes,
    dwellRemainingMinutes,
    isDwelling,
    isPullingOut: false,
    progress,
    x: fromStation.posX + (toStation.posX - fromStation.posX) * progress,
    y: fromStation.posY + (toStation.posY - fromStation.posY) * progress,
  }
}
