import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { SIM } from '@/types/game'
import { syncCityClock } from '@/lib/simulation'
import { ECONOMY } from '@/lib/economy'

// GET /api/cities/[id] — 도시 현재 상태 전체 조회
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // 여러 화면이 동시에 열려 있어도 서버 시계 하나만 틱을 진행한다.
  await syncCityClock(id)

  const city = await db.city.findUnique({
    where: { id },
    include: {
      lines: {
        include: {
          lineStations: {
            include: { station: true },
            orderBy: { order: 'asc' },
          },
          vehicles: true,
          policies: { where: { isActive: true } },
          actionLogs: {
            orderBy: { createdAt: 'desc' },
            take: 10,
          },
        },
      },
      stations: true,
      events: true,
      ticks: {
        orderBy: { tickNumber: 'desc' },
        take: 1,
      },
    },
  })

  if (!city) return NextResponse.json({ error: '도시를 찾을 수 없습니다.' }, { status: 404 })

  const waitingCounts = await db.passenger.groupBy({
    by: ['originStationId'],
    where: { cityId: id, boardedAtTick: null },
    _count: { id: true },
  })
  const waitingMap = new Map(waitingCounts.map(item => [item.originStationId, item._count.id]))
  const stationStats = city.stations.map(station => {
    const waitingCount = waitingMap.get(station.id) ?? 0
    return {
      stationId: station.id,
      waitingCount,
      congestion: Math.min(waitingCount / station.capacity, 1),
    }
  })

  // 오프라인 시간 계산 (게임시간 기준)
  const elapsedMs = Date.now() - city.lastTickAt.getTime()
  const elapsedGameHours = elapsedMs / SIM.LIVE_TICK_MS / SIM.TICKS_PER_GAME_HOUR

  return NextResponse.json({
    city,
    elapsedGameHours,
    stationStats,
    economyRules: {
      buildCosts: {
        station: ECONOMY.BUILD_COST.STATION,
        subwayLine: ECONOMY.BUILD_COST.SUBWAY_LINE,
        busLine: ECONOMY.BUILD_COST.BUS_LINE,
        subwaySegmentBase: ECONOMY.BUILD_COST.SUBWAY_SEGMENT_BASE,
        busSegmentBase: ECONOMY.BUILD_COST.BUS_SEGMENT_BASE,
        subwaySegmentPerMapUnit: ECONOMY.BUILD_COST.SUBWAY_SEGMENT_PER_MAP_UNIT,
        busSegmentPerMapUnit: ECONOMY.BUILD_COST.BUS_SEGMENT_PER_MAP_UNIT,
      },
      buildDebtLimit: ECONOMY.BUILD_DEBT_LIMIT,
      bankruptLimit: ECONOMY.BANKRUPT_LIMIT,
      criticalHappiness: ECONOMY.CRITICAL_HAPPINESS,
      gameOverGraceTicks: ECONOMY.GAME_OVER_GRACE_TICKS,
      goalRewardCash: ECONOMY.GOAL_REWARD_CASH,
    },
  })
}
