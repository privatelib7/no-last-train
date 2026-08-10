import { db } from './db'
import { SIM } from '@/types/game'
import { ECONOMY, resolveManagementGoal } from './economy'

// /api/cities/[id] GET과 WebSocket 실시간 브로드캐스트가 공유하는 "도시 전체 상태" 조합 로직.
// 폴링(HTTP)과 push(WS) 양쪽에서 같은 모양의 페이로드를 만들기 위해 한 곳에 둔다.
export async function buildCityStateSnapshot(cityId: string, playerId: string | null) {
  const city = await db.city.findUnique({
    where: { id: cityId },
    include: {
      lines: {
        include: {
          lineStations: {
            include: { station: true },
            orderBy: { order: 'asc' },
          },
          vehicles: { orderBy: { id: 'asc' } },
          policies: { where: { isActive: true } },
        },
      },
      stations: true,
      events: { where: { status: { in: ['PENDING', 'ACTIVE'] } } },
      ticks: {
        orderBy: { tickNumber: 'desc' },
        take: 1,
      },
    },
  })

  if (!city) return null

  const waitingCounts = await db.passenger.groupBy({
    by: ['originStationId'],
    where: { cityId, boardedAtTick: null },
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
  const isOwner = playerId != null && city.ownerPlayerId === playerId
  const managementGoal = resolveManagementGoal(city.revenueGoal, city.goalReachedAtTick)

  return {
    city: {
      ...city,
      goalLevel: managementGoal.level,
      goalDeadlineDay: managementGoal.deadlineDay,
      goalsCompleted: managementGoal.level - 1,
    },
    elapsedGameHours,
    stationStats,
    isOwner,
    economyRules: {
      buildCosts: {
        station: ECONOMY.BUILD_COST.STATION,
        subwayLine: ECONOMY.BUILD_COST.SUBWAY_LINE,
        busLine: ECONOMY.BUILD_COST.BUS_LINE,
        subwaySegmentBase: ECONOMY.BUILD_COST.SUBWAY_SEGMENT_BASE,
        busSegmentBase: ECONOMY.BUILD_COST.BUS_SEGMENT_BASE,
        subwaySegmentPerMapUnit: ECONOMY.BUILD_COST.SUBWAY_SEGMENT_PER_MAP_UNIT,
        busSegmentPerMapUnit: ECONOMY.BUILD_COST.BUS_SEGMENT_PER_MAP_UNIT,
        subwayInsert: ECONOMY.BUILD_COST.SUBWAY_INSERT,
        busInsert: ECONOMY.BUILD_COST.BUS_INSERT,
        subwayVehicle: ECONOMY.BUILD_COST.SUBWAY_VEHICLE,
        busVehicle: ECONOMY.BUILD_COST.BUS_VEHICLE,
      },
      buildDebtLimit: ECONOMY.BUILD_DEBT_LIMIT,
      bankruptLimit: ECONOMY.BANKRUPT_LIMIT,
      criticalHappiness: ECONOMY.CRITICAL_HAPPINESS,
      gameOverGraceTicks: ECONOMY.GAME_OVER_GRACE_TICKS,
      goalRewardCash: ECONOMY.GOAL_REWARD_CASH,
      farePerPassenger: ECONOMY.FARE_PER_PASSENGER,
    },
  }
}

export type CityStateSnapshot = NonNullable<Awaited<ReturnType<typeof buildCityStateSnapshot>>>
