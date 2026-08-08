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
  progress: number
  x: number | null
  y: number | null
}

const MODE_SPEED: Record<GameLine['mode'], number> = {
  SUBWAY: 1.05,
  BUS: 0.72,
}

const MODE_DURATION_LIMITS: Record<GameLine['mode'], { min: number; max: number }> = {
  SUBWAY: { min: 4, max: 28 },
  BUS: { min: 5.5, max: 35 },
}

const MODE_DWELL_MINUTES: Record<GameLine['mode'], number> = {
  SUBWAY: 1.5,
  BUS: 2.5,
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

function orderedStations(line: GameLine) {
  return line.lineStations.slice().sort((a, b) => a.order - b.order).map(item => item.station)
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

export function locateVehicle(
  line: GameLine,
  vehicle: Vehicle,
  elapsedGameMinutes: number,
): RenderedVehicleMotion {
  const stations = orderedStations(line)
  if (stations.length === 0 || !vehicle.currentStationId) {
    return {
      fromStation: null,
      toStation: null,
      arrivedStationIds: [],
      direction: vehicle.direction >= 0 ? 1 : -1,
      segmentDurationMinutes: 0,
      segmentProgressMinutes: 0,
      dwellRemainingMinutes: 0,
      isDwelling: false,
      progress: 0,
      x: null,
      y: null,
    }
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
    return {
      fromStation: station,
      toStation: null,
      arrivedStationIds,
      direction,
      segmentDurationMinutes: 0,
      segmentProgressMinutes: 0,
      dwellRemainingMinutes: 0,
      isDwelling: false,
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
  const progress = !isDwelling && segmentDurationMinutes > 0
    ? Math.max(0, Math.min(1, segmentProgressMinutes / segmentDurationMinutes))
    : 0
  const persistedProgressMinutes = isDwelling ? -dwellRemainingMinutes : segmentProgressMinutes

  return {
    fromStation,
    toStation,
    arrivedStationIds,
    direction,
    segmentDurationMinutes,
    segmentProgressMinutes: persistedProgressMinutes,
    dwellRemainingMinutes,
    isDwelling,
    progress,
    x: fromStation.posX + (toStation.posX - fromStation.posX) * progress,
    y: fromStation.posY + (toStation.posY - fromStation.posY) * progress,
  }
}
