import { SIM } from '@/types/game'

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
  happiness: number
  score: number
  insolvencyTicks: number
  unhappyTicks: number
  goalReachedAtTick: number | null
  goalReachedNow: boolean
  gameOverReason: 'BANKRUPT' | 'HAPPINESS' | null
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
    const activeVehicles = line.vehicles.filter(vehicle => vehicle.status === 'OPERATING' && !vehicle.isSpare).length
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
  const goalReachedNow = input.goalReachedAtTick === null && totalRevenue >= input.revenueGoal
  const goalReward = goalReachedNow ? ECONOMY.GOAL_REWARD_CASH : 0
  const cashBalance = input.cashBalance + revenue - operatingCost + goalReward

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
    happiness,
    score,
    insolvencyTicks,
    unhappyTicks,
    goalReachedAtTick: goalReachedNow ? input.tickNumber : input.goalReachedAtTick,
    goalReachedNow,
    gameOverReason,
  }
}

function roundToHundredThousand(value: number): number {
  return Math.round(value / 100_000) * 100_000
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
