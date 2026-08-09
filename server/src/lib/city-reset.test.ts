import assert from 'node:assert/strict'
import test from 'node:test'
import type { Prisma } from '@prisma/client'
import { ECONOMY } from './economy'
import { resetCityForNewGame } from './city-reset'

test('같은 도시 재시작은 지원 기록부터 정리하고 모든 노선과 역을 삭제한다', async () => {
  const calls: string[] = []
  let supportWhere: unknown
  let cityUpdate: unknown
  const resetAt = new Date('2026-08-09T00:00:00.000Z')
  const tx = {
    line: {
      findMany: async () => {
        calls.push('line.findMany')
        return [{ id: 'line-a' }, { id: 'line-b' }]
      },
      deleteMany: async () => {
        calls.push('line.deleteMany')
        return { count: 2 }
      },
    },
    support: {
      deleteMany: async (args: { where: unknown }) => {
        calls.push('support.deleteMany')
        supportWhere = args.where
        return { count: 1 }
      },
    },
    passenger: {
      deleteMany: async () => {
        calls.push('passenger.deleteMany')
        return { count: 3 }
      },
    },
    gameEvent: {
      deleteMany: async () => {
        calls.push('gameEvent.deleteMany')
        return { count: 1 }
      },
    },
    station: {
      deleteMany: async () => {
        calls.push('station.deleteMany')
        return { count: 5 }
      },
    },
    simTick: {
      deleteMany: async () => {
        calls.push('simTick.deleteMany')
        return { count: 4 }
      },
    },
    city: {
      update: async (args: unknown) => {
        calls.push('city.update')
        cityUpdate = args
        return { id: 'city-1' }
      },
    },
  } as unknown as Prisma.TransactionClient

  await resetCityForNewGame(tx, 'city-1', resetAt)

  assert.deepEqual(calls, [
    'line.findMany',
    'support.deleteMany',
    'line.deleteMany',
    'passenger.deleteMany',
    'gameEvent.deleteMany',
    'station.deleteMany',
    'simTick.deleteMany',
    'city.update',
  ])
  assert.deepEqual(supportWhere, {
    OR: [
      { fromLineId: { in: ['line-a', 'line-b'] } },
      { toLineId: { in: ['line-a', 'line-b'] } },
    ],
  })
  assert.deepEqual(cityUpdate, {
    where: { id: 'city-1' },
    data: {
      status: 'ACTIVE',
      currentTick: 0,
      lastTickAt: resetAt,
      cashBalance: ECONOMY.INITIAL_CASH,
      totalRevenue: 0,
      revenueGoal: ECONOMY.REVENUE_GOAL,
      happiness: ECONOMY.INITIAL_HAPPINESS,
      score: 0,
      insolvencyTicks: 0,
      unhappyTicks: 0,
      gameOverReason: null,
      goalReachedAtTick: null,
    },
  })
})
