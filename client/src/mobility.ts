import type { GameLine, Station, StationType } from './api/game'
import type { CityMapDef } from './maps'

export type CitizenTravelMode = 'WALK' | 'WAIT' | 'BOARDING'
export type StationAccessMode = 'SUBWAY' | 'BUS' | 'INTERCHANGE' | 'CITY'

type Point = { x: number; y: number }

type JourneyLeg = {
  from: Point
  to: Point
  mode: CitizenTravelMode
  duration: number
}

export type CitizenJourney = {
  id: string
  targetStationId: string
  targetStationName: string
  accessMode: StationAccessMode
  legs: JourneyLeg[]
  totalDuration: number
  timeOffset: number
  radius: number
  opacity: number
  warm: boolean
  landSafe: boolean
}

export type CitizenPosition = {
  x: number
  y: number
  mode: CitizenTravelMode
  progress: number
  opacityScale: number
  radiusScale: number
}

type DayPeriod = 'MORNING' | 'DAY' | 'EVENING' | 'NIGHT'
type DayKind = 'WEEKDAY' | 'WEEKEND'
type StationWeights = Record<StationType, number>

// 서버의 승객 출발 수요와 같은 시간대 방향성을 사용한다.
const STATION_DEMAND_WEIGHTS: Record<DayKind, Record<DayPeriod, StationWeights>> = {
  WEEKDAY: {
    MORNING: { RESIDENTIAL: 1.6, COMMERCIAL: 0.5, INDUSTRIAL: 0.4, TOURIST: 0.6, HUB: 1.0 },
    DAY: { RESIDENTIAL: 0.6, COMMERCIAL: 1.2, INDUSTRIAL: 0.8, TOURIST: 1.2, HUB: 1.0 },
    EVENING: { RESIDENTIAL: 0.5, COMMERCIAL: 1.2, INDUSTRIAL: 1.5, TOURIST: 0.9, HUB: 1.2 },
    NIGHT: { RESIDENTIAL: 0.4, COMMERCIAL: 1.0, INDUSTRIAL: 0.3, TOURIST: 0.8, HUB: 0.7 },
  },
  WEEKEND: {
    MORNING: { RESIDENTIAL: 1.0, COMMERCIAL: 0.5, INDUSTRIAL: 0.05, TOURIST: 1.0, HUB: 0.8 },
    DAY: { RESIDENTIAL: 0.9, COMMERCIAL: 1.4, INDUSTRIAL: 0.05, TOURIST: 1.5, HUB: 1.0 },
    EVENING: { RESIDENTIAL: 0.7, COMMERCIAL: 1.3, INDUSTRIAL: 0.05, TOURIST: 1.3, HUB: 1.0 },
    NIGHT: { RESIDENTIAL: 0.5, COMMERCIAL: 0.9, INDUSTRIAL: 0.05, TOURIST: 0.7, HUB: 0.7 },
  },
}

function periodOfHour(hour: number): DayPeriod {
  const normalized = ((Math.floor(hour) % 24) + 24) % 24
  if (normalized >= 6 && normalized <= 9) return 'MORNING'
  if (normalized >= 10 && normalized <= 15) return 'DAY'
  if (normalized >= 16 && normalized <= 19) return 'EVENING'
  return 'NIGHT'
}

function randomUnit(seed: number, index: number, salt: number) {
  let value = Math.imul(seed + index * 374761393 + salt * 668265263, 1274126177)
  value ^= value >>> 13
  value = Math.imul(value, 2246822519)
  return (value >>> 0) / 4294967296
}

function distanceBetween(from: Point, to: Point) {
  return Math.hypot(to.x - from.x, to.y - from.y)
}

// 두 지점 사이를 촘촘히 표본화해 강·바다·도시 경계 밖을 한 번이라도 지나면 거부한다.
export function pathStaysOnLand(from: Point, to: Point, map: CityMapDef) {
  const distance = distanceBetween(from, to)
  const steps = Math.max(2, Math.ceil(distance / 0.22))
  for (let step = 0; step <= steps; step++) {
    const progress = step / steps
    const x = from.x + (to.x - from.x) * progress
    const y = from.y + (to.y - from.y) * progress
    if (!map.isLand(x, y)) return false
  }
  return true
}

/** 노선 유무와 관계없이 모든 역을 목적지로 쓴다 (전역 스폰용). */
function allStationsWithAccess(lines: GameLine[], stations: Station[]) {
  const modesByStation = new Map<string, Set<'SUBWAY' | 'BUS'>>()
  for (const line of lines) {
    for (const item of line.lineStations) {
      if (!modesByStation.has(item.stationId)) modesByStation.set(item.stationId, new Set())
      modesByStation.get(item.stationId)!.add(line.mode)
    }
  }

  return stations.map(station => {
    const modes = modesByStation.get(station.id)
    const accessMode: StationAccessMode = !modes || modes.size === 0
      ? 'SUBWAY'
      : modes.size > 1
        ? 'INTERCHANGE'
        : modes.has('BUS') ? 'BUS' : 'SUBWAY'
    return { station, accessMode }
  })
}

function pickWeightedStation(
  stations: Array<{ station: Station; accessMode: StationAccessMode }>,
  weights: StationWeights,
  roll: number,
) {
  const total = stations.reduce((sum, item) => sum + (weights[item.station.type] ?? 1), 0)
  let cursor = roll * total
  for (const item of stations) {
    cursor -= weights[item.station.type] ?? 1
    if (cursor <= 0) return item
  }
  return stations[stations.length - 1] ?? null
}

function landSafePointNearStation(station: Station, map: CityMapDef, seed: number, index: number): Point {
  const stationPoint = { x: station.posX, y: station.posY }
  for (let attempt = 0; attempt < 48; attempt++) {
    const angle = randomUnit(seed, index, 220 + attempt * 2) * Math.PI * 2
    const radiusBand = attempt < 32 ? 3.8 : 1.8
    const radiusRange = attempt < 32 ? 7.2 : 3.2
    const radius = radiusBand + randomUnit(seed, index, 221 + attempt * 2) * radiusRange
    const point = {
      x: station.posX + Math.cos(angle) * radius,
      y: station.posY + Math.sin(angle) * radius,
    }
    if (map.isLand(point.x, point.y) && pathStaysOnLand(point, stationPoint, map)) return point
  }
  return stationPoint
}

/** 맵 전역 육지에서 스폰 지점을 고른다. 역까지 육로가 있으면 우선, 실패 시 역 근처로 폴백. */
function landSafePointOnMap(station: Station, map: CityMapDef, seed: number, index: number): Point {
  const stationPoint = { x: station.posX, y: station.posY }
  for (let attempt = 0; attempt < 96; attempt++) {
    const point = {
      x: 4 + randomUnit(seed, index, 400 + attempt * 3) * 92,
      y: 4 + randomUnit(seed, index, 501 + attempt * 3) * 88,
    }
    if (!map.isLand(point.x, point.y)) continue
    if (pathStaysOnLand(point, stationPoint, map)) return point
  }
  return landSafePointNearStation(station, map, seed, index)
}

function deterministicLandPoint(map: CityMapDef, seed: number, index: number, salt: number): Point {
  for (let attempt = 0; attempt < 96; attempt++) {
    const point = {
      x: 4 + randomUnit(seed, index, salt + attempt * 2) * 92,
      y: 4 + randomUnit(seed, index, salt + attempt * 2 + 1) * 92,
    }
    if (map.isLand(point.x, point.y)) return point
  }

  const anchor = { x: map.anchor[0], y: map.anchor[1] }
  if (map.isLand(anchor.x, anchor.y)) return anchor

  for (let y = 2; y <= 98; y += 2) {
    for (let x = 2; x <= 98; x += 2) {
      if (map.isLand(x, y)) return { x, y }
    }
  }

  return anchor
}

// 아직 역이 하나도 없을 때 도시가 텅 비어 보이지 않도록, 목적지 없이 배회하는 시민을 채운다.
function createAmbientCitizenJourneys(seed: number, count: number, map: CityMapDef): CitizenJourney[] {
  const journeys: CitizenJourney[] = []

  for (let index = 0; index < count; index++) {
    const start = deterministicLandPoint(map, seed, index, 500)
    let destination = start

    for (let attempt = 0; attempt < 96; attempt++) {
      const candidate = deterministicLandPoint(map, seed, index, 700 + attempt * 193)
      if (distanceBetween(start, candidate) >= 4 && pathStaysOnLand(start, candidate, map)) {
        destination = candidate
        break
      }
    }

    const walkDuration = Math.max(3, distanceBetween(start, destination) / 1.3)
    const pauseDuration = 0.8 + randomUnit(seed, index, 940) * 1.2
    const legs: JourneyLeg[] = [
      { from: start, to: destination, mode: 'WALK', duration: walkDuration },
      { from: destination, to: destination, mode: 'WAIT', duration: pauseDuration },
      { from: destination, to: start, mode: 'WALK', duration: walkDuration },
      { from: start, to: start, mode: 'WAIT', duration: pauseDuration },
    ]
    const totalDuration = legs.reduce((sum, leg) => sum + leg.duration, 0)

    journeys.push({
      id: `ambient-citizen-${index}`,
      targetStationId: 'city-ambient',
      targetStationName: map.name,
      accessMode: 'CITY',
      legs,
      totalDuration,
      timeOffset: randomUnit(seed, index, 941) * totalDuration,
      radius: 0.28 + randomUnit(seed, index, 942) * 0.12,
      opacity: 0.72 + randomUnit(seed, index, 943) * 0.24,
      warm: randomUnit(seed, index, 944) > 0.76,
      landSafe: pathStaysOnLand(start, destination, map),
    })
  }

  return journeys
}

export function createCitizenJourneys(options: {
  seed: number
  waitingCount: number
  gameHour: number
  weekend: boolean
  stations: Station[]
  lines: GameLine[]
  map: CityMapDef
}): CitizenJourney[] {
  const { seed, waitingCount, gameHour, weekend, stations, lines, map } = options
  const count = Math.min(128, Math.max(64, Math.round(48 + Math.log10(waitingCount + 10) * 14)))
  // 역이 하나도 없으면(노선 유무와 무관) 배회 시민으로 도시가 비어 보이지 않게 한다.
  const availableStations = allStationsWithAccess(lines, stations)
  if (availableStations.length === 0) return createAmbientCitizenJourneys(seed, count, map)

  const busStops = availableStations.filter(item => item.accessMode === 'BUS')
  const dayKind: DayKind = weekend ? 'WEEKEND' : 'WEEKDAY'
  const weights = STATION_DEMAND_WEIGHTS[dayKind][periodOfHour(gameHour)]
  const journeys: CitizenJourney[] = []

  for (let index = 0; index < count; index++) {
    // 운행 중인 버스 정류장이 있으면 일부 시민은 버스 정류장으로 향하게 한다.
    const forcedBusStop = busStops.length > 0 && index % 12 === 0
      ? busStops[index % busStops.length]
      : null
    const target = forcedBusStop ?? pickWeightedStation(
      availableStations,
      weights,
      randomUnit(seed, index, 120),
    )
    if (!target) continue

    const stationPoint = { x: target.station.posX, y: target.station.posY }
    // 노선 근처가 아니라 맵 전역 육지에서 리스폰한 뒤 역으로 걸어온다.
    const outsidePoint = landSafePointOnMap(target.station, map, seed, index)
    const landSafe = pathStaysOnLand(outsidePoint, stationPoint, map)
    const walkDuration = Math.max(2.4, distanceBetween(outsidePoint, stationPoint) / 1.8)
    const legs: JourneyLeg[] = [
      { from: outsidePoint, to: stationPoint, mode: 'WALK', duration: walkDuration },
      { from: stationPoint, to: stationPoint, mode: 'WAIT', duration: 1.45 },
      { from: stationPoint, to: stationPoint, mode: 'BOARDING', duration: 0.9 },
    ]
    const totalDuration = legs.reduce((sum, leg) => sum + leg.duration, 0)

    journeys.push({
      id: `citizen-${index}`,
      targetStationId: target.station.id,
      targetStationName: target.station.name,
      accessMode: target.accessMode,
      legs,
      totalDuration,
      timeOffset: randomUnit(seed, index, 340) * totalDuration,
      radius: 0.28 + randomUnit(seed, index, 341) * 0.12,
      opacity: 0.72 + randomUnit(seed, index, 342) * 0.24,
      warm: randomUnit(seed, index, 343) > 0.76,
      landSafe,
    })
  }

  return journeys
}

export function locateCitizen(journey: CitizenJourney, journeyTime: number): CitizenPosition {
  let cursor = ((journeyTime + journey.timeOffset) % journey.totalDuration + journey.totalDuration) % journey.totalDuration
  let leg = journey.legs[journey.legs.length - 1]
  let legIndex = journey.legs.length - 1

  for (const [index, candidate] of journey.legs.entries()) {
    if (cursor <= candidate.duration) {
      leg = candidate
      legIndex = index
      break
    }
    cursor -= candidate.duration
  }

  const progress = leg.duration > 0 ? Math.min(1, cursor / leg.duration) : 1
  const opacityScale = leg.mode === 'BOARDING'
    ? 1 - progress
    : leg.mode === 'WALK' && legIndex === 0 ? Math.min(1, progress / 0.12) : 1
  const radiusScale = leg.mode === 'BOARDING' ? Math.max(0.35, 1 - progress * 0.65) : 1

  return {
    x: leg.from.x + (leg.to.x - leg.from.x) * progress,
    y: leg.from.y + (leg.to.y - leg.from.y) * progress,
    mode: leg.mode,
    progress,
    opacityScale,
    radiusScale,
  }
}
