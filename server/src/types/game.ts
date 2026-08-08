import type { City, Line, Station, Vehicle, Passenger, Policy, GameEvent, SimTick, ActionLog } from '@prisma/client'

// ─── 시뮬레이션 상태 스냅샷 ──────────────────────────────────────────────

export interface CitySnapshot {
  city: City
  lines: LineSnapshot[]
  stations: StationSnapshot[]
  activeEvents: GameEvent[]
  lastTick: SimTick | null
}

export interface LineSnapshot {
  line: Line
  stations: Station[]
  vehicles: Vehicle[]
  activePolicies: Policy[]
  recentActions: ActionLog[]
}

export interface StationSnapshot {
  station: Station
  waitingCount: number
  congestion: number  // 0.0 ~ 1.0
  vehiclesPresent: number
}

// ─── 시뮬레이션 결과 ─────────────────────────────────────────────────────

export interface SimResult {
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
  gameOverReason: 'BANKRUPT' | 'HAPPINESS' | null
  actionsFired: Array<{ description: string; actionType: string }>
  highlights: TickHighlight[]  // 주요 순간 최대 3개
}

export interface TickHighlight {
  tickNumber: number
  gameTimeHour: number
  type: 'CONGESTION' | 'AI_ACTION' | 'EVENT' | 'SUPPORT' | 'GOAL'
  description: string
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
}

// ─── 정책 파싱 ───────────────────────────────────────────────────────────

export interface ParsedPolicy {
  type: 'CONGESTION_RESPONSE' | 'PASSENGER_PRIORITY' | 'SUPPORT_CONDITION'
  conditionStationId?: string
  conditionThreshold?: number
  conditionTimeStart?: number
  conditionTimeEnd?: number
  actionType: 'DEPLOY_SPARE' | 'ADJUST_HEADWAY' | 'LEND_VEHICLE'
  actionTargetLineId?: string
  resourceLimit: number
  parsedSummary: string
}

export type PolicyParseResult =
  | { ok: true; policy: ParsedPolicy }
  | { ok: false; reason: string; suggestion: string }

// ─── 복귀 리포트 ─────────────────────────────────────────────────────────

export interface ReturnReport {
  offlineTicks: number
  offlineGameHours: number
  totalTransported: number
  peakCongestion: number
  serviceScore: number
  supportsGiven: number
  supportsReceived: number
  topActions: ActionLog[]         // AI 핵심 행동 3개
  highlights: TickHighlight[]     // 주요 장면 3개
  recommendations: string[]       // AI 추천 정책 변경
}

// ─── 승객 경로 ───────────────────────────────────────────────────────────

export interface Route {
  segments: RouteSegment[]
  totalTransfers: number
  estimatedTicks: number
}

export interface RouteSegment {
  lineId: string
  fromStationId: string
  toStationId: string
}

// ─── 시뮬레이션 파라미터 ─────────────────────────────────────────────────

export const SIM = {
  TICKS_PER_GAME_HOUR: 6,       // 틱당 게임 10분, 6틱 = 게임 1시간
  GAME_HOURS_PER_DAY: 24,
  GAME_MINUTES_PER_TICK: 10,    // 경제 집계 틱과 별개로 차량은 이 시간을 연속 이동한다
  LIVE_TICK_MS: 3000,            // 실시간 웹 운행: 3초마다 1틱
  MAX_OFFLINE_HOURS: 12,         // 오프라인 보상 최대 12시간
  BASE_PASSENGER_RATE: 10,       // 기본 승객 생성 (틱당 역당)
  CONGESTION_DEPLOY_DEFAULT: 0.8, // 기본 혼잡 대응 임계값
} as const

export const TIME_DEMAND_MULTIPLIER: Record<number, number> = {
  // 게임 시간대별 수요 배율
  6: 1.2, 7: 2.0, 8: 2.5, 9: 2.0,   // 출근
  10: 1.0, 11: 1.0, 12: 1.2,          // 낮
  13: 1.0, 14: 0.9, 15: 0.9,
  16: 1.2, 17: 2.0, 18: 2.5, 19: 1.8, // 퇴근
  20: 1.3, 21: 1.0, 22: 0.6,           // 저녁
  23: 0.3, 0: 0.2, 1: 0.1, 2: 0.1,    // 심야
  3: 0.1, 4: 0.2, 5: 0.5,
}

// ─── 시간대·요일 기반 승객 이동 패턴 ─────────────────────────────────────

export type DayPeriod = 'MORNING' | 'DAY' | 'EVENING' | 'NIGHT'

export function periodOfHour(hour: number): DayPeriod {
  const h = Math.floor(hour)
  if (h >= 6 && h <= 9) return 'MORNING'
  if (h >= 10 && h <= 15) return 'DAY'
  if (h >= 16 && h <= 19) return 'EVENING'
  return 'NIGHT'
}

const TICKS_PER_DAY = SIM.TICKS_PER_GAME_HOUR * SIM.GAME_HOURS_PER_DAY

// 게임 내 7일 주기: 6·7일차 = 주말
export function isWeekendTick(tick: number): boolean {
  return Math.floor(tick / TICKS_PER_DAY) % 7 >= 5
}

type StationTypeKey = 'RESIDENTIAL' | 'COMMERCIAL' | 'TOURIST' | 'INDUSTRIAL' | 'HUB'
type ODTable = Record<'WEEKDAY' | 'WEEKEND', Record<DayPeriod, Record<StationTypeKey, number>>>

// 승객 출발지(역 타입) 가중치 — 아침엔 주거에서 쏟아져 나오고, 저녁엔 산업/상업에서 귀가
export const ORIGIN_WEIGHT: ODTable = {
  WEEKDAY: {
    MORNING: { RESIDENTIAL: 1.6, COMMERCIAL: 0.5, INDUSTRIAL: 0.4, TOURIST: 0.6, HUB: 1.0 },
    DAY:     { RESIDENTIAL: 0.6, COMMERCIAL: 1.2, INDUSTRIAL: 0.8, TOURIST: 1.2, HUB: 1.0 },
    EVENING: { RESIDENTIAL: 0.5, COMMERCIAL: 1.2, INDUSTRIAL: 1.5, TOURIST: 0.9, HUB: 1.2 },
    NIGHT:   { RESIDENTIAL: 0.4, COMMERCIAL: 1.0, INDUSTRIAL: 0.3, TOURIST: 0.8, HUB: 0.7 },
  },
  WEEKEND: {
    MORNING: { RESIDENTIAL: 1.0, COMMERCIAL: 0.5, INDUSTRIAL: 0.05, TOURIST: 1.0, HUB: 0.8 },
    DAY:     { RESIDENTIAL: 0.9, COMMERCIAL: 1.4, INDUSTRIAL: 0.05, TOURIST: 1.5, HUB: 1.0 },
    EVENING: { RESIDENTIAL: 0.7, COMMERCIAL: 1.3, INDUSTRIAL: 0.05, TOURIST: 1.3, HUB: 1.0 },
    NIGHT:   { RESIDENTIAL: 0.5, COMMERCIAL: 0.9, INDUSTRIAL: 0.05, TOURIST: 0.7, HUB: 0.7 },
  },
}

// 승객 목적지(역 타입) 가중치 — 아침 산업행, 저녁 주거·상업행, 밤 주거행, 주말은 산업 소멸
export const DEST_WEIGHT: ODTable = {
  WEEKDAY: {
    MORNING: { RESIDENTIAL: 0.2, COMMERCIAL: 1.0, INDUSTRIAL: 2.0, TOURIST: 0.4, HUB: 1.2 },
    DAY:     { RESIDENTIAL: 0.5, COMMERCIAL: 1.5, INDUSTRIAL: 0.8, TOURIST: 1.2, HUB: 1.0 },
    EVENING: { RESIDENTIAL: 2.0, COMMERCIAL: 1.2, INDUSTRIAL: 0.2, TOURIST: 0.6, HUB: 1.0 },
    NIGHT:   { RESIDENTIAL: 2.5, COMMERCIAL: 0.5, INDUSTRIAL: 0.1, TOURIST: 0.3, HUB: 0.8 },
  },
  WEEKEND: {
    MORNING: { RESIDENTIAL: 0.6, COMMERCIAL: 1.5, INDUSTRIAL: 0.05, TOURIST: 1.5, HUB: 1.0 },
    DAY:     { RESIDENTIAL: 0.6, COMMERCIAL: 1.8, INDUSTRIAL: 0.05, TOURIST: 1.8, HUB: 1.0 },
    EVENING: { RESIDENTIAL: 1.8, COMMERCIAL: 1.0, INDUSTRIAL: 0.05, TOURIST: 0.8, HUB: 1.0 },
    NIGHT:   { RESIDENTIAL: 2.2, COMMERCIAL: 0.5, INDUSTRIAL: 0.05, TOURIST: 0.3, HUB: 0.8 },
  },
}
