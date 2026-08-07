import assert from 'node:assert/strict'
import test from 'node:test'
import { ECONOMY, calculateTickEconomy, segmentBuildCost } from './economy'

const baseInput = {
  transported: 100,
  serviceScore: 80,
  cashBalance: 10_000_000,
  totalRevenue: 0,
  revenueGoal: ECONOMY.REVENUE_GOAL,
  happiness: 78,
  score: 0,
  insolvencyTicks: 0,
  unhappyTicks: 0,
  goalReachedAtTick: null,
  tickNumber: 1,
  lines: [],
}

test('구간 공사비는 버스보다 지하철이 높고 거리에 따라 증가한다', () => {
  assert.equal(segmentBuildCost('BUS', 10), 1_300_000)
  assert.equal(segmentBuildCost('SUBWAY', 10), 5_000_000)
  assert.ok(segmentBuildCost('SUBWAY', 20) > segmentBuildCost('SUBWAY', 10))
})

test('매출 목표를 처음 넘을 때 한 번만 보상한다', () => {
  const result = calculateTickEconomy({
    ...baseInput,
    transported: 100,
    totalRevenue: ECONOMY.REVENUE_GOAL - 100_000,
  })

  assert.equal(result.goalReachedNow, true)
  assert.equal(result.goalReachedAtTick, 1)
  assert.equal(result.cashBalance, 10_000_000 + 160_000 + ECONOMY.GOAL_REWARD_CASH)
  assert.ok(result.score >= ECONOMY.GOAL_REWARD_SCORE)

  const next = calculateTickEconomy({
    ...baseInput,
    cashBalance: result.cashBalance,
    totalRevenue: result.totalRevenue,
    goalReachedAtTick: result.goalReachedAtTick,
    transported: 0,
  })
  assert.equal(next.goalReachedNow, false)
  assert.equal(next.cashBalance, result.cashBalance)
})

test('행복도는 서비스가 나빠도 틱당 최대 0.25만 하락한다', () => {
  const result = calculateTickEconomy({ ...baseInput, serviceScore: 0, happiness: 78 })
  assert.equal(result.happiness, 77.75)
  assert.equal(result.gameOverReason, null)
})

test('파산은 2게임일 유예를 모두 소진한 뒤에만 확정된다', () => {
  const before = calculateTickEconomy({
    ...baseInput,
    transported: 0,
    cashBalance: ECONOMY.BANKRUPT_LIMIT,
    insolvencyTicks: ECONOMY.GAME_OVER_GRACE_TICKS - 2,
  })
  assert.equal(before.gameOverReason, null)

  const final = calculateTickEconomy({
    ...baseInput,
    transported: 0,
    cashBalance: before.cashBalance,
    insolvencyTicks: before.insolvencyTicks,
  })
  assert.equal(final.gameOverReason, 'BANKRUPT')
})
