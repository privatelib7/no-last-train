export type StationType = 'RESIDENTIAL' | 'COMMERCIAL' | 'TOURIST' | 'INDUSTRIAL' | 'HUB'
export type LineColor = 'RED' | 'BLUE' | 'GREEN' | 'YELLOW' | 'PURPLE'

export type Station = {
  id: string
  name: string
  type: StationType
  capacity: number
  posX: number
  posY: number
}

export type StationStat = {
  stationId: string
  waitingCount: number
  congestion: number
}

export type Vehicle = {
  id: string
  status: 'OPERATING' | 'SPARE' | 'LOANED' | 'MAINTENANCE' | 'BROKEN'
  isSpare: boolean
  currentStationId: string | null
  headwayMinutes: number
  direction: number
}

export type Policy = {
  id: string
  type: PolicyType
  actionType: ActionType
  conditionThreshold?: number | null
  parsedSummary?: string | null
}

export type ActionLog = {
  id: string
  actionType: ActionType
  description: string
  conditionMet: string
  resourceUsed: number
  createdAt: string
}

export type GameLine = {
  id: string
  playerId: string | null
  color: LineColor
  mode: 'SUBWAY' | 'BUS'
  name: string
  status: 'OPERATING' | 'DEGRADED' | 'SUSPENDED'
  depotX: number
  depotY: number
  lineStations: Array<{ stationId: string; order: number; station: Station }>
  vehicles: Vehicle[]
  policies: Policy[]
  actionLogs: ActionLog[]
}

export type GameCity = {
  id: string
  name: string
  mapKey: string
  seed: number
  seasonDay: number
  status: 'ACTIVE' | 'SEASON_ENDED'
  currentTick: number
  lastTickAt: string
  stations: Station[]
  lines: GameLine[]
  events: Array<{
    id: string
    type: 'CONCERT'
    status: 'PENDING' | 'ACTIVE' | 'RESOLVED'
    startsAtTick: number
    durationTicks: number
    affectedStationId: string | null
  }>
  ticks: Array<{
    tickNumber: number
    gameTimeHour: number
    passengersTransported: number
    avgCongestion: number
    serviceScore: number
  }>
}

export type CityState = {
  city: GameCity
  elapsedGameHours: number
  stationStats: StationStat[]
}

export type PolicyType = 'CONGESTION_RESPONSE' | 'PASSENGER_PRIORITY' | 'SUPPORT_CONDITION'
export type ActionType = 'DEPLOY_SPARE' | 'ADJUST_HEADWAY' | 'LEND_VEHICLE'

export type ParsedPolicy = {
  type: PolicyType
  conditionStationId?: string
  conditionThreshold?: number
  conditionTimeStart?: number
  conditionTimeEnd?: number
  actionType: ActionType
  actionTargetLineId?: string
  resourceLimit: number
  parsedSummary: string
}

export type PolicyParseResult =
  | { ok: true; policy: ParsedPolicy }
  | { ok: false; reason: string; suggestion: string }

export type TickHighlight = {
  tickNumber: number
  gameTimeHour: number
  type: 'CONGESTION' | 'AI_ACTION' | 'EVENT' | 'SUPPORT'
  description: string
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
}

export type SimResult = {
  ticksProcessed: number
  totalTransported: number
  peakCongestion: number
  serviceScore: number
  actionsFired: Array<{ description: string; actionType: ActionType }>
  highlights: TickHighlight[]
}

const API_BASE = import.meta.env.VITE_API_URL ?? ''

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.error?.formErrors?.[0] ?? body.error ?? `요청에 실패했습니다. (${res.status})`)
  }
  return body as T
}

export function fetchCity(cityId: string) {
  return request<CityState>(`/api/cities/${cityId}`)
}

export function advanceCity(cityId: string) {
  return request<SimResult>(`/api/cities/${cityId}/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticks: 1 }),
  })
}

export type CityAction =
  | { type: 'BUILD_STATION'; name: string; posX: number; posY: number }
  | { type: 'RENAME_STATION'; stationId: string; name: string }
  | { type: 'BUILD_SEGMENT'; lineId: string; fromStationId: string; toStationId: string }
  | { type: 'SET_LINE_STATUS'; lineId: string; status: 'OPERATING' | 'SUSPENDED' }
  | { type: 'SET_VEHICLE_SERVICE'; lineId: string; vehicleId: string; inService: boolean }
  | { type: 'DEPLOY_VEHICLE'; lineId: string; vehicleId: string; stationId: string }
  | { type: 'TRANSFER_VEHICLE'; lineId: string; vehicleId: string; targetLineId: string }
  | { type: 'REMOVE_VEHICLE'; lineId: string; vehicleId: string }

export function executeCityAction(cityId: string, action: CityAction) {
  return request<{ message: string }>(`/api/cities/${cityId}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  })
}
