import { SIM } from '@/types/game'
import { isVehicleInService } from './vehicle-service'

export const ECONOMY = {
  INITIAL_CASH: 120_000_000,
  INITIAL_HAPPINESS: 78,
  REVENUE_GOAL: 80_000_000,
  FARE_PER_PASSENGER: 1_600,
  GOAL_REWARD_CASH: 20_000_000,
  GOAL_REWARD_SCORE: 5_000,
  BUILD_DEBT_LIMIT: -25_000_000,
  BANKRUPT_LIMIT: -30_000_000,
  CRITICAL_HAPPINESS: 10,
  GAME_OVER_GRACE_TICKS: SIM.TICKS_PER_GAME_HOUR * SIM.GAME_HOURS_PER_DAY * 2,
  BUILD_COST: {
    STATION: 8_000_000,
    SUBWAY_LINE: 20_000_000,
    BUS_LINE: 6_000_000,
    SUBWAY_SEGMENT_BASE: 2_000_000,
    SUBWAY_SEGMENT_PER_MAP_UNIT: 300_000,
    BUS_SEGMENT_BASE: 500_000,
    BUS_SEGMENT_PER_MAP_UNIT: 80_000,
    SUBWAY_INSERT: 3_000_000,
    BUS_INSERT: 1_000_000,
    SUBWAY_VEHICLE: 7_000_000,
    BUS_VEHICLE: 2_000_000,
  },
  OPERATING_COST: {
    SUBWAY_LINE: 35_000,
    BUS_LINE: 12_000,
    SUBWAY_VEHICLE: 18_000,
    BUS_VEHICLE: 6_000,
  },
} as const

export type EconomyLine = {
  mode: string
  status: string
  vehicles: Array<{ status: string; isSpare: boolean }>
}

export type TickEconomyInput = {
  transported: number
  serviceScore: number
  cashBalance: number
  totalRevenue: number
  revenueGoal: number
  happiness: number
  score: number
  insolvencyTicks: number
  unhappyTicks: number
  goalReachedAtTick: number | null
  tickNumber: number
  lines: EconomyLine[]
}

export type TickEconomyResult = {
  revenue: number
  operatingCost: number
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
  goalReachedAtTick: number | null
  goalReachedNow: boolean
  completedGoalLevel: number | null
  gameOverReason: 'BANKRUPT' | 'HAPPINESS' | 'GOAL_DEADLINE' | null
}

export type ManagementGoal = {
  level: number
  revenueGoal: number
  deadlineDay: number
}

// 목표는 누적 매출 기준으로 커지고, 달성 기한도 단계마다 4일, 5일, 6일…씩 넓어진다.
// 1단계 8,000만/3일 → 2단계 1억 8,000만/7일 → 3단계 3억/12일.
export function managementGoalForLevel(level: number): ManagementGoal {
  const safeLevel = Math.max(1, Math.floor(level))
  return {
    level: safeLevel,
    revenueGoal: 10_000_000 * safeLevel * (safeLevel + 7),
    deadlineDay: safeLevel * (safeLevel + 5) / 2,
  }
}

export function resolveManagementGoal(
  revenueGoal: number,
  lastGoalReachedAtTick: number | null,
): ManagementGoal {
  let level = 1
  while (level < 100 && managementGoalForLevel(level).revenueGoal < revenueGoal) level += 1
  // 단일 목표만 있던 기존 저장 데이터는 이미 받은 1단계 보상을 중복 지급하지 않는다.
  if (level === 1 && lastGoalReachedAtTick !== null) level = 2
  return managementGoalForLevel(level)
}

export function isManagementGoalDeadlineMissed(input: {
  tickNumber: number
  totalRevenue: number
  revenueGoal: number
  goalReachedAtTick: number | null
}): boolean {
  const goal = resolveManagementGoal(input.revenueGoal, input.goalReachedAtTick)
  const deadlineBoundaryTick = goal.deadlineDay * SIM.TICKS_PER_GAME_HOUR * SIM.GAME_HOURS_PER_DAY
  return input.tickNumber >= deadlineBoundaryTick && input.totalRevenue < goal.revenueGoal
}

export function segmentBuildCost(mode: string, distance: number): number {
  const safeDistance = Math.max(0, distance)
  if (mode === 'BUS') {
    return roundToHundredThousand(
      ECONOMY.BUILD_COST.BUS_SEGMENT_BASE + safeDistance * ECONOMY.BUILD_COST.BUS_SEGMENT_PER_MAP_UNIT,
    )
  }
  return roundToHundredThousand(
    ECONOMY.BUILD_COST.SUBWAY_SEGMENT_BASE + safeDistance * ECONOMY.BUILD_COST.SUBWAY_SEGMENT_PER_MAP_UNIT,
  )
}

export function lineBuildCost(mode: string): number {
  return mode === 'BUS' ? ECONOMY.BUILD_COST.BUS_LINE : ECONOMY.BUILD_COST.SUBWAY_LINE
}

export function stationInsertCost(mode: string): number {
  return mode === 'BUS' ? ECONOMY.BUILD_COST.BUS_INSERT : ECONOMY.BUILD_COST.SUBWAY_INSERT
}

export function vehiclePurchaseCost(mode: string): number {
  return mode === 'BUS' ? ECONOMY.BUILD_COST.BUS_VEHICLE : ECONOMY.BUILD_COST.SUBWAY_VEHICLE
}

export function calculateOperatingCost(lines: EconomyLine[]): number {
  return lines.reduce((total, line) => {
    if (line.status !== 'OPERATING') return total
    const isBus = line.mode === 'BUS'
    const lineCost = isBus
      ? ECONOMY.OPERATING_COST.BUS_LINE
      : ECONOMY.OPERATING_COST.SUBWAY_LINE
    const activeVehicles = line.vehicles.filter(isVehicleInService).length
    const vehicleCost = isBus
      ? ECONOMY.OPERATING_COST.BUS_VEHICLE
      : ECONOMY.OPERATING_COST.SUBWAY_VEHICLE
    return total + lineCost + activeVehicles * vehicleCost
  }, 0)
}

export function calculateTickEconomy(input: TickEconomyInput): TickEconomyResult {
  const revenue = input.transported * ECONOMY.FARE_PER_PASSENGER
  const operatingCost = calculateOperatingCost(input.lines)
  const totalRevenue = input.totalRevenue + revenue

  const currentGoal = resolveManagementGoal(input.revenueGoal, input.goalReachedAtTick)
  let goalLevel = currentGoal.level
  let goalsCompleted = goalLevel - 1
  let revenueGoal = currentGoal.revenueGoal
  let goalDeadlineDay = currentGoal.deadlineDay

  const completedGoalLevel = totalRevenue >= revenueGoal ? goalLevel : null
  const goalReachedNow = completedGoalLevel !== null
  const goalReward = goalReachedNow ? ECONOMY.GOAL_REWARD_CASH : 0
  const cashBalance = input.cashBalance + revenue - operatingCost + goalReward

  if (goalReachedNow) {
    goalsCompleted += 1
    goalLevel += 1
    const nextGoal = managementGoalForLevel(goalLevel)
    revenueGoal = nextGoal.revenueGoal
    goalDeadlineDay = nextGoal.deadlineDay
  }

  // 행복도는 서비스 품질을 천천히 따라간다. 최악의 상황에서도 틱당 0.25만 하락한다.
  const happinessDelta = clamp((input.serviceScore - input.happiness) * 0.02, -0.25, 0.18)
  const happiness = clamp(input.happiness + happinessDelta, 0, 100)
  const scoreGain = input.transported * 2 + Math.round(happiness)
  const score = input.score + scoreGain + (goalReachedNow ? ECONOMY.GOAL_REWARD_SCORE : 0)

  // 위험 상태에서 벗어나면 카운터가 두 배 속도로 회복되어 잠깐의 적자를 관대하게 처리한다.
  const insolvencyTicks = cashBalance <= ECONOMY.BANKRUPT_LIMIT
    ? input.insolvencyTicks + 1
    : Math.max(0, input.insolvencyTicks - 2)
  const unhappyTicks = happiness <= ECONOMY.CRITICAL_HAPPINESS
    ? input.unhappyTicks + 1
    : Math.max(0, input.unhappyTicks - 2)

  let gameOverReason: TickEconomyResult['gameOverReason'] = null
  if (insolvencyTicks >= ECONOMY.GAME_OVER_GRACE_TICKS) gameOverReason = 'BANKRUPT'
  else if (unhappyTicks >= ECONOMY.GAME_OVER_GRACE_TICKS) gameOverReason = 'HAPPINESS'

  return {
    revenue,
    operatingCost,
    cashBalance,
    totalRevenue,
    revenueGoal,
    goalLevel,
    goalDeadlineDay,
    goalsCompleted,
    happiness,
    score,
    insolvencyTicks,
    unhappyTicks,
    goalReachedAtTick: goalReachedNow ? input.tickNumber : input.goalReachedAtTick,
    goalReachedNow,
    completedGoalLevel,
    gameOverReason,
  }
}

function roundToHundredThousand(value: number): number {
  return Math.round(value / 100_000) * 100_000
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
