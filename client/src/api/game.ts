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
  capacity: number
  status: 'OPERATING' | 'SPARE' | 'LOANED' | 'MAINTENANCE' | 'BROKEN'
  isSpare: boolean
  currentStationId: string | null
  headwayMinutes: number
  direction: number
  segmentProgressMinutes: number
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
  actionLogs?: ActionLog[]
}

export type GameCity = {
  id: string
  name: string
  roomTitle: string
  mapKey: string
  ownerPlayerId: string | null
  seed: number
  seasonDay: number
  status: 'ACTIVE' | 'SEASON_ENDED' | 'GAME_OVER'
  currentTick: number
  lastTickAt: string
  cashBalance: number
  totalRevenue: number
  revenueGoal: number
  goalLevel: number
  goalDeadlineDay: number
  goalsCompleted: number
  happiness: number
  score: number
  insolvencyTicks: number
  unhappyTicks: number
  gameOverReason: 'BANKRUPT' | 'HAPPINESS' | 'GOAL_DEADLINE' | null
  goalReachedAtTick: number | null
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
    revenue: number
    operatingCost: number
    cashBalance: number
    happiness: number
    score: number
  }>
}

export type CityState = {
  city: GameCity
  elapsedGameHours: number
  stationStats: StationStat[]
  isOwner: boolean
  economyRules: {
    buildCosts: {
      station: number
      subwayLine: number
      busLine: number
      subwaySegmentBase: number
      busSegmentBase: number
      subwaySegmentPerMapUnit: number
      busSegmentPerMapUnit: number
      subwayInsert: number
      busInsert: number
      subwayVehicle: number
      busVehicle: number
    }
    buildDebtLimit: number
    bankruptLimit: number
    criticalHappiness: number
    gameOverGraceTicks: number
    goalRewardCash: number
    farePerPassenger: number
  }
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
  type: 'CONGESTION' | 'AI_ACTION' | 'EVENT' | 'SUPPORT' | 'GOAL'
  description: string
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
}

export type SimResult = {
  ticksProcessed: number
  totalTransported: number
  revenueEarned: number
  operatingCost: number
  peakCongestion: number
  serviceScore: number
  cashBalance: number
  happiness: number
  score: number
  goalReached: boolean
  gameOverReason: 'BANKRUPT' | 'HAPPINESS' | 'GOAL_DEADLINE' | null
  actionsFired: Array<{ description: string; actionType: ActionType }>
  highlights: TickHighlight[]
}

// 서버 SIM 상수(server/src/types/game.ts)와 반드시 일치해야 한다
export const TICKS_PER_HOUR = 6
export const TICKS_PER_DAY = TICKS_PER_HOUR * 24

// 혼잡도(waiting/capacity) 표시 기준 — 연웅: 행복도 하락 판정도 서버에서 같은 기준 사용 권장
export const CONGESTION_WARN = 0.7
export const CONGESTION_SATURATED = 1.0

const API_BASE = import.meta.env.VITE_API_URL ?? ''

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(
      body.error?.formErrors?.[0] ?? body.error ?? `요청에 실패했습니다. (${res.status})`,
      res.status,
    )
  }
  return body as T
}

function authHeaders(playerToken?: string): HeadersInit {
  return playerToken ? { 'x-player-token': playerToken } : {}
}

export function fetchCity(cityId: string, playerToken?: string) {
  return request<CityState>(`/api/cities/${cityId}`, { headers: authHeaders(playerToken) })
}

/** 서버가 내려주는 동기화 틱 + 차량 렌더 좌표 */
export type CityMotionVehicle = {
  id: string
  lineId: string
  mode: 'SUBWAY' | 'BUS' | string
  status: string
  isSpare: boolean
  currentStationId: string | null
  direction: number
  segmentProgressMinutes: number
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

export type TransitMotionPhysics = {
  speed: { SUBWAY: number; BUS: number }
  durationLimits: {
    SUBWAY: { min: number; max: number }
    BUS: { min: number; max: number }
  }
  dwellMinutes: { SUBWAY: number; BUS: number }
  depotPulloutMinutes: { SUBWAY: number; BUS: number }
}

export type CityMotionSnapshot = {
  cityId: string
  status: string
  serverNow: number
  currentTick: number
  lastTickAt: string
  liveTickMs: number
  gameMinutesPerTick: number
  gameMinutesPerWallSecond: number
  maxPreviewTicks: number
  syncTick: number
  previewTicks: number
  physics: TransitMotionPhysics
  vehicles: CityMotionVehicle[]
}

export function fetchCityMotion(cityId: string, playerToken?: string) {
  return request<CityMotionSnapshot>(`/api/cities/${cityId}/motion`, {
    headers: authHeaders(playerToken),
  })
}

export function advanceCity(cityId: string, playerToken?: string) {
  return request<SimResult>(`/api/cities/${cityId}/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(playerToken) },
    body: JSON.stringify({ ticks: 1 }),
  })
}

export type CityAction =
  | { type: 'RESET_CITY' }
  | { type: 'BUILD_STATION'; name: string; posX: number; posY: number }
  | { type: 'RENAME_STATION'; stationId: string; name: string }
  | { type: 'MOVE_STATION'; stationId: string; posX: number; posY: number }
  | { type: 'REMOVE_STATION'; stationId: string }
  | { type: 'CREATE_LINE'; mode: 'SUBWAY' | 'BUS' }
  | {
      type: 'CREATE_CONNECTED_LINE'
      mode: 'SUBWAY' | 'BUS'
      fromStationId: string
      toStationId: string
    }
  | { type: 'REMOVE_LINE'; lineId: string }
  | { type: 'DETACH_STATION'; lineId: string; stationId: string }
  | { type: 'INSERT_STATION'; lineId: string; fromStationId: string; toStationId: string; stationId: string }
  | { type: 'BUILD_SEGMENT'; lineId: string; fromStationId: string; toStationId: string }
  | { type: 'SET_LINE_STATUS'; lineId: string; status: 'OPERATING' | 'SUSPENDED' }
  | { type: 'BUY_VEHICLE'; lineId: string; count: number }
  | { type: 'SET_VEHICLE_SERVICE'; lineId: string; vehicleId: string; inService: boolean }
  | { type: 'TRANSFER_VEHICLE'; lineId: string; vehicleId: string; targetLineId: string }
  | { type: 'REMOVE_VEHICLE'; lineId: string; vehicleId: string }

export function executeCityAction(cityId: string, action: CityAction, playerToken?: string) {
  // line/station은 서버가 방금 만든 행(row) 그대로라 GameLine의 lineStations/vehicles/
  // policies 같은 연관 배열은 안 들어있다 — 즉시 반영용 패치에서는 빈 배열로 채워 쓴다.
  return request<{ message: string; line?: GameLine; station?: Station }>(`/api/cities/${cityId}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(playerToken) },
    body: JSON.stringify(action),
  })
}

export type CityCommandPlanResult =
  | { ok: true; summary: string; actions: CityAction[] }
  | { ok: false; reason: string; suggestion: string }

export function planCityCommand(cityId: string, rawInput: string, playerToken?: string) {
  return request<CityCommandPlanResult>(`/api/cities/${cityId}/commands/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(playerToken) },
    body: JSON.stringify({ rawInput }),
  })
}
