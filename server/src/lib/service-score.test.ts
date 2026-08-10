import assert from 'node:assert/strict'
import test from 'node:test'
import { calcServiceScore, collectServedStationIds } from './service-score'
import { calculateTickEconomy, ECONOMY } from './economy'

function station(id: string, congestion: number) {
  return { station: { id }, congestion }
}

function operatingLine(stationIds: string[]) {
  return {
    status: 'OPERATING',
    lineStations: stationIds.map(stationId => ({ stationId })),
    vehicles: [{ status: 'OPERATING', isSpare: false }],
  }
}

test('역이 하나도 없는 도시는 서비스 점수가 0이다', () => {
  assert.equal(calcServiceScore([], []), 0)
})

test('노선이 닿지 않는 역은 혼잡도가 0이어도 서비스 점수가 0이다', () => {
  assert.equal(calcServiceScore([station('a', 0), station('b', 0)], []), 0)
})

test('운행 노선이 지나는 역은 혼잡도에 따라 점수가 매겨진다', () => {
  const lines = [operatingLine(['a', 'b'])]
  assert.equal(calcServiceScore([station('a', 0), station('b', 0)], lines), 100)
  assert.equal(calcServiceScore([station('a', 0.5), station('b', 0.5)], lines), 60)
  assert.equal(calcServiceScore([station('a', 1), station('b', 1)], lines), 20)
})

test('일부 역만 노선에 연결되면 연결되지 않은 역이 평균을 끌어내린다', () => {
  const lines = [operatingLine(['a', 'b'])]
  const score = calcServiceScore([station('a', 0), station('b', 0), station('c', 0)], lines)
  assert.equal(Math.round(score), 67)
})

test('중단된 노선·예비 차량뿐인 노선·역 1개 노선은 서비스로 치지 않는다', () => {
  assert.equal(collectServedStationIds([
    { ...operatingLine(['a', 'b']), status: 'SUSPENDED' },
  ]).size, 0)

  assert.equal(collectServedStationIds([
    { ...operatingLine(['a', 'b']), vehicles: [{ status: 'SPARE', isSpare: true }] },
  ]).size, 0)

  assert.equal(collectServedStationIds([operatingLine(['a'])]).size, 0)

  assert.deepEqual(
    [...collectServedStationIds([operatingLine(['a', 'b'])])].sort(),
    ['a', 'b'],
  )
})

test('아무것도 짓지 않고 방치하면 시민 행복도가 계속 떨어진다', () => {
  let happiness: number = ECONOMY.INITIAL_HAPPINESS
  const serviceScore = calcServiceScore([], [])

  for (let tick = 1; tick <= 10; tick++) {
    const before = happiness
    happiness = calculateTickEconomy({
      transported: 0,
      serviceScore,
      cashBalance: ECONOMY.INITIAL_CASH,
      totalRevenue: 0,
      revenueGoal: ECONOMY.REVENUE_GOAL,
      happiness,
      score: 0,
      insolvencyTicks: 0,
      unhappyTicks: 0,
      goalReachedAtTick: null,
      tickNumber: tick,
      lines: [],
    }).happiness
    assert.ok(happiness < before, `${tick}틱에서 행복도가 떨어지지 않았다`)
  }

  assert.ok(happiness < ECONOMY.INITIAL_HAPPINESS - 2)
})
