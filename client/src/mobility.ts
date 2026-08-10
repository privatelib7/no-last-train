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
  /** 시민 슬롯 번호 — 여정이 새로 뽑혀도 유지되어 화면상 같은 점으로 이어진다. */
  index: number
  /** 이 슬롯이 몇 번째 여정인지 — 매번 다른 목적지를 뽑기 위한 salt. */
  generation: number
  /** 이 여정이 시작된 journeyTime. 여정은 반복되지 않고 끝나면 새로 뽑는다. */
  startTime: number
  targetStationId: string
  targetStationName: string
  accessMode: StationAccessMode
  legs: JourneyLeg[]
  totalDuration: number
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

// 역 주변 링을 먼 쪽부터 훑는다. 역 코앞에서 사람이 솟아나는 것처럼 보이지 않게 하기 위함.
const STATION_SPAWN_RINGS = [24, 18, 13, 9, 6]

function landSafePointNearStation(
  station: Station,
  map: CityMapDef,
  seed: number,
  index: number,
  salt: number,
): Point {
  const stationPoint = { x: station.posX, y: station.posY }
  for (const [ring, radiusBand] of STATION_SPAWN_RINGS.entries()) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const step = ring * 16 + attempt
      const angle = randomUnit(seed, index, salt + step * 2) * Math.PI * 2
      const radius = radiusBand * (0.78 + randomUnit(seed, index, salt + step * 2 + 1) * 0.32)
      const point = {
        x: station.posX + Math.cos(angle) * radius,
        y: station.posY + Math.sin(angle) * radius,
      }
      if (map.isLand(point.x, point.y) && pathStaysOnLand(point, stationPoint, map)) return point
    }
  }
  return stationPoint
}

/** 맵 전역 육지에서 스폰 지점을 고른다. 역까지 육로가 있으면 우선, 실패 시 역에서 먼 링부터 폴백. */
function landSafePointOnMap(
  station: Station,
  map: CityMapDef,
  seed: number,
  index: number,
  salt: number,
): Point {
  const stationPoint = { x: station.posX, y: station.posY }
  for (let attempt = 0; attempt < 96; attempt++) {
    const point = {
      x: 4 + randomUnit(seed, index, salt + attempt * 3) * 92,
      y: 4 + randomUnit(seed, index, salt + 1 + attempt * 3) * 88,
    }
    if (!map.isLand(point.x, point.y)) continue
    if (pathStaysOnLand(point, stationPoint, map)) return point
  }
  return landSafePointNearStation(station, map, seed, index, salt + 977)
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

type CitizenAppearance = {
  radius: number
  opacity: number
  warm: boolean
}

function citizenAppearance(seed: number, index: number): CitizenAppearance {
  // 외형은 슬롯마다 고정 — 여정이 새로 뽑혀도 같은 사람으로 보이게 한다.
  return {
    radius: 0.4 + randomUnit(seed, index, 341) * 0.14,
    opacity: 0.72 + randomUnit(seed, index, 342) * 0.24,
    warm: randomUnit(seed, index, 343) > 0.76,
  }
}

// 아직 역이 하나도 없을 때 도시가 텅 비어 보이지 않도록, 목적지 없이 배회하는 시민을 만든다.
function createAmbientJourney(
  seed: number,
  index: number,
  generation: number,
  map: CityMapDef,
): CitizenJourney {
  const salt = 500 + generation * 6151
  // 배회 시민의 "집"은 슬롯마다 고정 — 다음 여정을 받아도 살던 자리에서 다시 나선다.
  const start = deterministicLandPoint(map, seed, index, 500)
  let destination = start

  for (let attempt = 0; attempt < 96; attempt++) {
    const candidate = deterministicLandPoint(map, seed, index, salt + 200 + attempt * 193)
    if (distanceBetween(start, candidate) >= 4 && pathStaysOnLand(start, candidate, map)) {
      destination = candidate
      break
    }
  }

  const walkDuration = Math.max(3, distanceBetween(start, destination) / 1.3)
  const pauseDuration = 0.8 + randomUnit(seed, index, salt + 440) * 1.2
  const legs: JourneyLeg[] = [
    { from: start, to: destination, mode: 'WALK', duration: walkDuration },
    { from: destination, to: destination, mode: 'WAIT', duration: pauseDuration },
    { from: destination, to: start, mode: 'WALK', duration: walkDuration },
    { from: start, to: start, mode: 'WAIT', duration: pauseDuration },
  ]

  return {
    id: `citizen-${index}`,
    index,
    generation,
    startTime: 0,
    targetStationId: 'city-ambient',
    targetStationName: map.name,
    accessMode: 'CITY',
    legs,
    totalDuration: legs.reduce((sum, leg) => sum + leg.duration, 0),
    ...citizenAppearance(seed, index),
    landSafe: pathStaysOnLand(start, destination, map),
  }
}

function createStationJourney(
  seed: number,
  index: number,
  generation: number,
  map: CityMapDef,
  availableStations: Array<{ station: Station; accessMode: StationAccessMode }>,
  busStops: Array<{ station: Station; accessMode: StationAccessMode }>,
  weights: StationWeights,
): CitizenJourney | null {
  const salt = 120 + generation * 7919
  // 운행 중인 버스 정류장이 있으면 일부 시민은 버스 정류장으로 향하게 한다.
  const forcedBusStop = busStops.length > 0 && (index + generation) % 12 === 0
    ? busStops[(index + generation) % busStops.length]
    : null
  const target = forcedBusStop ?? pickWeightedStation(
    availableStations,
    weights,
    randomUnit(seed, index, salt),
  )
  if (!target) return null

  const stationPoint = { x: target.station.posX, y: target.station.posY }
  // 노선 근처가 아니라 맵 전역 육지에서 리스폰한 뒤 역으로 걸어온다.
  const outsidePoint = landSafePointOnMap(target.station, map, seed, index, salt + 280)
  const walkDuration = Math.max(2.4, distanceBetween(outsidePoint, stationPoint) / 1.8)
  const legs: JourneyLeg[] = [
    { from: outsidePoint, to: stationPoint, mode: 'WALK', duration: walkDuration },
    { from: stationPoint, to: stationPoint, mode: 'WAIT', duration: 1.45 },
    { from: stationPoint, to: stationPoint, mode: 'BOARDING', duration: 0.9 },
  ]

  return {
    id: `citizen-${index}`,
    index,
    generation,
    startTime: 0,
    targetStationId: target.station.id,
    targetStationName: target.station.name,
    accessMode: target.accessMode,
    legs,
    totalDuration: legs.reduce((sum, leg) => sum + leg.duration, 0),
    ...citizenAppearance(seed, index),
    landSafe: pathStaysOnLand(outsidePoint, stationPoint, map),
  }
}

export type CitizenWorldOptions = {
  seed: number
  waitingCount: number
  gameHour: number
  weekend: boolean
  stations: Station[]
  lines: GameLine[]
  map: CityMapDef
}

/**
 * 이미 이동 중인 시민은 그대로 두고, 여정을 끝낸 시민만 새 여정을 받는다.
 * 역을 짓거나 노선을 바꿔도 화면 위의 사람들이 한꺼번에 순간이동하지 않게 하기 위함.
 */
export function advanceCitizenJourneys(
  options: CitizenWorldOptions & {
    previous: CitizenJourney[]
    journeyTime: number
    /** 한 프레임에 새로 뽑을 여정 수 상한 — 여정 생성은 육지 탐색이라 비싸다. */
    maxRespawns?: number
  },
): CitizenJourney[] {
  const { seed, waitingCount, gameHour, weekend, stations, lines, map, previous, journeyTime } = options
  // 렌더 비용이 커서 상한을 낮춘다(예전 64~128 → 24~48).
  const count = Math.min(48, Math.max(24, Math.round(20 + Math.log10(waitingCount + 10) * 10)))
  // 역이 하나도 없으면(노선 유무와 무관) 배회 시민으로 도시가 비어 보이지 않게 한다.
  const availableStations = allStationsWithAccess(lines, stations)
  const busStops = availableStations.filter(item => item.accessMode === 'BUS')
  const dayKind: DayKind = weekend ? 'WEEKEND' : 'WEEKDAY'
  const weights = STATION_DEMAND_WEIGHTS[dayKind][periodOfHour(gameHour)]

  const remaining = new Map(previous.map(journey => [journey.index, journey]))
  let respawnBudget = options.maxRespawns ?? 12
  const journeys: CitizenJourney[] = []

  for (let index = 0; index < count; index++) {
    const current = remaining.get(index)
    remaining.delete(index)
    // 아직 걷는 중이면 목적지·경로를 절대 건드리지 않는다.
    if (current && journeyTime < current.startTime + current.totalDuration) {
      journeys.push(current)
      continue
    }
    // 예산을 넘겼으면 다음 프레임에 뽑는다. 여정을 끝낸 시민은 이미 투명해 보이지 않는다.
    if (respawnBudget <= 0) {
      if (current) journeys.push(current)
      continue
    }
    respawnBudget -= 1

    const generation = (current?.generation ?? -1) + 1
    const next = availableStations.length === 0
      ? createAmbientJourney(seed, index, generation, map)
      : createStationJourney(seed, index, generation, map, availableStations, busStops, weights)
    if (!next) {
      if (current) journeys.push(current)
      continue
    }

    // 처음 들어오는 시민은 서로 다른 위상에서 시작시켜 한 줄로 몰려다니지 않게 한다.
    // (바로 여정이 끝나버리지 않도록 0.85 주기까지만 밀어 둔다)
    const stagger = current ? 0 : randomUnit(seed, index, 340) * next.totalDuration * 0.85
    const chained = current ? current.startTime + current.totalDuration : journeyTime - stagger
    // 탭이 오래 멈춰 여러 주기가 밀렸거나 시계가 되감긴 경우엔 현재 시각에 맞춘다.
    const drifted = chained > journeyTime || journeyTime - chained > next.totalDuration
    next.startTime = drifted ? journeyTime - stagger : chained
    journeys.push(next)
  }

  // 정원이 줄어든 슬롯도 진행 중인 여정은 끝까지 걷게 둔다 (도중에 사라지지 않도록).
  for (const leftover of remaining.values()) {
    if (journeyTime < leftover.startTime + leftover.totalDuration) journeys.push(leftover)
  }

  return journeys.sort((a, b) => a.index - b.index)
}

/** 도시를 처음 열 때의 초기 채움. */
export function createCitizenJourneys(options: CitizenWorldOptions): CitizenJourney[] {
  return advanceCitizenJourneys({ ...options, previous: [], journeyTime: 0, maxRespawns: Infinity })
}

export function locateCitizen(journey: CitizenJourney, journeyTime: number): CitizenPosition {
  const elapsed = Math.min(journey.totalDuration, Math.max(0, journeyTime - journey.startTime))
  let cursor = elapsed
  let leg = journey.legs[journey.legs.length - 1]

  for (const candidate of journey.legs) {
    if (cursor <= candidate.duration) {
      leg = candidate
      break
    }
    cursor -= candidate.duration
  }

  const progress = leg.duration > 0 ? Math.min(1, cursor / leg.duration) : 1
  // 여정 앞뒤를 페이드로 감싼다 — 다음 여정을 받을 때 다른 자리에서 튀어나오지 않도록.
  const fadeSpan = Math.min(1.1, journey.totalDuration * 0.1)
  const envelope = fadeSpan > 0
    ? Math.min(1, elapsed / fadeSpan, (journey.totalDuration - elapsed) / fadeSpan)
    : 1
  const opacityScale = (leg.mode === 'BOARDING' ? 1 - progress : 1) * envelope
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
