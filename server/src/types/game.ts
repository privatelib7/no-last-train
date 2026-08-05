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
  peakCongestion: number
  serviceScore: number
  actionsFired: Array<{ description: string; actionType: string }>
  highlights: TickHighlight[]  // 주요 순간 최대 3개
}

export interface TickHighlight {
  tickNumber: number
  gameTimeHour: number
  type: 'CONGESTION' | 'AI_ACTION' | 'EVENT' | 'SUPPORT'
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
  TICKS_PER_GAME_HOUR: 6,       // 10분 실게임 = 1 게임시간
  GAME_HOURS_PER_DAY: 24,
  DEMO_TICK_MS: 1000,            // 데모 모드: 1틱 = 1초
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
