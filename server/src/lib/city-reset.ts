import type { Prisma } from '@prisma/client'
import { ECONOMY } from './economy'

export async function resetCityForNewGame(
  tx: Prisma.TransactionClient,
  cityId: string,
  lastTickAt = new Date(),
): Promise<void> {
  const lines = await tx.line.findMany({
    where: { cityId },
    select: { id: true },
  })
  const lineIds = lines.map(line => line.id)

  // Support에는 onDelete Cascade가 없으므로 노선과 차량보다 먼저 정리한다.
  if (lineIds.length > 0) {
    await tx.support.deleteMany({
      where: {
        OR: [
          { fromLineId: { in: lineIds } },
          { toLineId: { in: lineIds } },
        ],
      },
    })
  }

  // 노선 삭제 시 차량·역 연결·정책·행동 로그도 함께 삭제된다.
  await tx.line.deleteMany({ where: { cityId } })
  await tx.passenger.deleteMany({ where: { cityId } })
  await tx.gameEvent.deleteMany({ where: { cityId } })
  await tx.station.deleteMany({ where: { cityId } })
  await tx.simTick.deleteMany({ where: { cityId } })
  await tx.city.update({
    where: { id: cityId },
    data: {
      status: 'ACTIVE',
      currentTick: 0,
      lastTickAt,
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
}
