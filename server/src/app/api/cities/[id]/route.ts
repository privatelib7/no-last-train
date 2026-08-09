import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { SIM } from '@/types/game'
import { syncCityClock } from '@/lib/simulation'
import { authorizeCityAccess, authorizeCityOwner } from '@/lib/access'
import { ECONOMY, resolveManagementGoal } from '@/lib/economy'
import { z } from 'zod'

const UpdateCitySchema = z.object({
  roomTitle: z.string().trim().min(1, '방제목을 입력해주세요.').max(24, '방제목은 24자까지입니다.'),
})

// GET /api/cities/[id] — 도시 현재 상태 전체 조회
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const auth = await authorizeCityAccess(req, id)
  if (auth.error) return auth.error

  // 여러 화면이 동시에 열려 있어도 서버 시계 하나만 틱을 진행한다.
  // 시계 동기화 실패가 도시 조회 자체를 막지 않게 한다.
  try {
    await syncCityClock(id)
  } catch (err) {
    console.error(`[cities/${id}] syncCityClock failed`, err)
  }

  const city = await db.city.findUnique({
    where: { id },
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
  const isOwner = city.ownerPlayerId === auth.player.id
  const managementGoal = resolveManagementGoal(city.revenueGoal, city.goalReachedAtTick)

  return NextResponse.json({
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
      },
      buildDebtLimit: ECONOMY.BUILD_DEBT_LIMIT,
      bankruptLimit: ECONOMY.BANKRUPT_LIMIT,
      criticalHappiness: ECONOMY.CRITICAL_HAPPINESS,
      gameOverGraceTicks: ECONOMY.GAME_OVER_GRACE_TICKS,
      goalRewardCash: ECONOMY.GOAL_REWARD_CASH,
    },
  })
}

// PATCH /api/cities/[id] — 방제목 변경 (관제장만)
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const auth = await authorizeCityOwner(req, id)
  if (auth.error) return auth.error

  const body = await req.json().catch(() => null)
  const parsed = UpdateCitySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? '방제목을 확인해주세요.' },
      { status: 400 },
    )
  }

  const city = await db.city.update({
    where: { id },
    data: { roomTitle: parsed.data.roomTitle },
    select: { id: true, name: true, roomTitle: true },
  })

  return NextResponse.json(city)
}
