import { db } from './db'
import { evaluatePolicies } from './policy-engine'
import { calculateTickEconomy, isManagementGoalDeadlineMissed, resolveManagementGoal } from './economy'
import { advanceVehicleMotion } from './vehicle-motion'
import { isVehicleInService } from './vehicle-service'
import { SIM, TIME_DEMAND_MULTIPLIER, ORIGIN_WEIGHT, DEST_WEIGHT, periodOfHour, isWeekendTick } from '@/types/game'
import type { SimResult, TickHighlight, StationSnapshot, DayPeriod } from '@/types/game'
import type { Passenger, Vehicle, Station, Line, GameEvent } from '@prisma/client'

// ─── 결정론적 RNG (seeded) ───────────────────────────────────────────────

function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// ─── 메인 시뮬레이션 진입점 ──────────────────────────────────────────────

const citySimulationQueues = new Map<string, Promise<unknown>>()

export async function simulateTicks(cityId: string, count: number): Promise<SimResult> {
  return enqueueCitySimulation(cityId, () => simulateTicksUnlocked(cityId, count))
}

export async function syncCityClock(cityId: string): Promise<SimResult | null> {
  return enqueueCitySimulation(cityId, async () => {
    const city = await db.city.findUnique({
      where: { id: cityId },
      select: { lastTickAt: true, status: true },
    })
    if (!city || city.status !== 'ACTIVE') return null

    const elapsedMs = Date.now() - city.lastTickAt.getTime()
    // 한 요청에서 너무 많이 따라잡으면 초기 로딩/폴링이 수 초씩 막힌다.
    // 나머지는 이후 폴링에서 조금씩 따라잡는다.
    const pendingTicks = Math.min(Math.floor(elapsedMs / SIM.LIVE_TICK_MS), 3)
    if (pendingTicks < 1) return null
    return simulateTicksUnlocked(cityId, pendingTicks)
  })
}

function enqueueCitySimulation<T>(cityId: string, task: () => Promise<T>): Promise<T> {
  const previous = citySimulationQueues.get(cityId) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(task)

  citySimulationQueues.set(cityId, next)

  return next.finally(() => {
    if (citySimulationQueues.get(cityId) === next) citySimulationQueues.delete(cityId)
  })
}

async function simulateTicksUnlocked(cityId: string, count: number): Promise<SimResult> {
  const city = await db.city.findUniqueOrThrow({
    where: { id: cityId },
    include: {
      lines: {
        include: {
          lineStations: { include: { station: true }, orderBy: { order: 'asc' } },
          vehicles: { orderBy: { id: 'asc' } },
          policies: { where: { isActive: true } },
        },
      },
      stations: true,
      events: { where: { status: { in: ['PENDING', 'ACTIVE'] } } },
    },
  })

  // 중간에 죽은 시뮬레이션으로 SimTick만 앞서 있으면 currentTick을 맞춰 재진입 500을 막는다.
  const latestTick = await db.simTick.findFirst({
    where: { cityId },
    orderBy: { tickNumber: 'desc' },
    select: { tickNumber: true },
  })
  let baseTick = city.currentTick
  if (latestTick && latestTick.tickNumber > baseTick) {
    baseTick = latestTick.tickNumber
    await db.city.update({
      where: { id: cityId },
      data: { currentTick: baseTick },
    })
  }

  const rng = mulberry32(city.seed + baseTick)
  const highlights: TickHighlight[] = []
  let totalTransported = 0
  let revenueEarned = 0
  let operatingCost = 0
  let peakCongestion = 0
  let ticksProcessed = 0
  let cashBalance = city.cashBalance
  let totalRevenue = city.totalRevenue
  let revenueGoal = city.revenueGoal
  const initialGoal = resolveManagementGoal(city.revenueGoal, city.goalReachedAtTick)
  let goalLevel = initialGoal.level
  let goalsCompleted = initialGoal.level - 1
  let happiness = city.happiness
  let score = city.score
  let insolvencyTicks = city.insolvencyTicks
  let unhappyTicks = city.unhappyTicks
  let goalReachedAtTick = city.goalReachedAtTick
  let gameOverReason: 'BANKRUPT' | 'HAPPINESS' | 'GOAL_DEADLINE' | null = null
  const allActionLogs: Awaited<ReturnType<typeof evaluatePolicies>> = []

  for (let i = 0; i < count; i++) {
    const tickNumber = baseTick + ticksProcessed + 1
    const gameTimeHour = (tickNumber / SIM.TICKS_PER_GAME_HOUR) % 24
    const weekend = isWeekendTick(tickNumber)
    const period = periodOfHour(gameTimeHour)
    const baseDemand = TIME_DEMAND_MULTIPLIER[Math.floor(gameTimeHour)] ?? 1.0
    // 주말엔 출퇴근 피크가 없음
    const demandMult = weekend ? Math.min(baseDemand, 1.3) : baseDemand

    // 마감일의 모든 틱이 끝난 뒤 다음 날로 넘어가는 순간 목표 실패를 확정한다.
    // 실패 판정 틱에서는 승객·차량·경제 상태를 더 진행하지 않는다.
    if (isManagementGoalDeadlineMissed({
      tickNumber,
      totalRevenue,
      revenueGoal,
      goalReachedAtTick,
    })) {
      gameOverReason = 'GOAL_DEADLINE'
      highlights.push({
        tickNumber,
        gameTimeHour,
        type: 'GOAL',
        description: `${goalLevel}단계 경영 목표를 기한 안에 달성하지 못해 경영이 종료되었습니다.`,
        severity: 'CRITICAL',
      })
      ticksProcessed += 1
      break
    }

    // 1. 사건 활성화
    const activeEvents = activateEvents(city.events, tickNumber)
    for (const event of activeEvents) {
      if (event.startsAtTick === tickNumber) {
        const station = city.stations.find(item => item.id === event.affectedStationId)
        highlights.push({
          tickNumber,
          gameTimeHour,
          type: 'EVENT',
          description: `${station?.name ?? '관광역'} 콘서트가 시작되어 승객 수요가 급증했습니다.`,
          severity: 'WARNING',
        })
      }
    }

    // 2. 승객 생성
    const newPassengers = generatePassengers(city.stations, tickNumber, demandMult, period, weekend, activeEvents, rng)
    if (newPassengers.length > 0) {
      await db.passenger.createMany({ data: newPassengers })
    }

    // 3. 역별 대기 승객 조회
    const stationSnapshots = await buildStationSnapshots(city.stations, cityId)

    // 4. 차량 이동 + 승하차
    const transported = await moveVehiclesAndBoard(city.lines, stationSnapshots, tickNumber)
    totalTransported += transported

    // 5. AI 정책 평가 및 실행
    const serviceScore = calcServiceScore(stationSnapshots)
    const economy = calculateTickEconomy({
      transported,
      serviceScore,
      cashBalance,
      totalRevenue,
      revenueGoal,
      happiness,
      score,
      insolvencyTicks,
      unhappyTicks,
      goalReachedAtTick,
      tickNumber,
      lines: city.lines,
    })
    revenueEarned += economy.revenue
    operatingCost += economy.operatingCost
    cashBalance = economy.cashBalance
    totalRevenue = economy.totalRevenue
    revenueGoal = economy.revenueGoal
    goalLevel = economy.goalLevel
    goalsCompleted = economy.goalsCompleted
    happiness = economy.happiness
    score = economy.score
    insolvencyTicks = economy.insolvencyTicks
    unhappyTicks = economy.unhappyTicks
    goalReachedAtTick = economy.goalReachedAtTick
    gameOverReason = economy.gameOverReason

    const tickRecord = await db.simTick.create({
      data: {
        cityId,
        tickNumber,
        gameTimeHour,
        passengersTransported: transported,
        avgCongestion: avgOf(stationSnapshots.map(s => s.congestion)),
        serviceScore,
        revenue: economy.revenue,
        operatingCost: economy.operatingCost,
        cashBalance,
        happiness,
        score,
      },
    })

    const policyActions = await evaluatePolicies(city.lines, stationSnapshots, tickRecord.id)
    allActionLogs.push(...policyActions)

    // 6. 혼잡 최고치 추적
    const maxCongestion = Math.max(...stationSnapshots.map(s => s.congestion))
    if (maxCongestion > peakCongestion) peakCongestion = maxCongestion

    // 7. 하이라이트 수집
    collectHighlights(highlights, stationSnapshots, policyActions, tickNumber, gameTimeHour)
    if (economy.goalReachedNow) {
      highlights.push({
        tickNumber,
        gameTimeHour,
        type: 'GOAL',
        description: `${economy.completedGoalLevel}단계 경영 목표를 달성해 지원금 ₵2,000을 받고 ${economy.goalLevel}단계 목표가 설정되었습니다.`,
        severity: 'INFO',
      })
    }

    ticksProcessed += 1
    if (gameOverReason) break
  }

  // 도시 틱 카운터 업데이트. 처리 시각을 현재로 덮지 않고 틱 길이만큼 전진시켜
  // 폴링 사이에 남은 실제 시간이 사라지지 않게 한다.
  const advancedClockMs = city.lastTickAt.getTime() + ticksProcessed * SIM.LIVE_TICK_MS
  const lastTickAt = new Date(Math.max(
    city.lastTickAt.getTime(),
    Math.min(Date.now(), advancedClockMs),
  ))
  await db.city.update({
    where: { id: cityId },
    data: {
      currentTick: baseTick + ticksProcessed,
      lastTickAt,
      cashBalance,
      totalRevenue,
      revenueGoal,
      happiness,
      score,
      insolvencyTicks,
      unhappyTicks,
      goalReachedAtTick,
      status: gameOverReason ? 'GAME_OVER' : city.status,
      gameOverReason,
    },
  })

  const lastTick = await db.simTick.findFirst({
    where: { cityId },
    orderBy: { tickNumber: 'desc' },
  })

  return {
    ticksProcessed,
    totalTransported,
    revenueEarned,
    operatingCost,
    peakCongestion,
    serviceScore: lastTick?.serviceScore ?? 100,
    cashBalance,
    happiness,
    score,
    goalReached: goalsCompleted > 0,
    gameOverReason,
    actionsFired: allActionLogs,
    highlights: highlights.slice(0, 3),
  }
}

// ─── 사건 활성화 ─────────────────────────────────────────────────────────

function activateEvents(events: GameEvent[], tick: number): GameEvent[] {
  const active: GameEvent[] = []
  for (const ev of events) {
    if (ev.startsAtTick <= tick && tick < ev.startsAtTick + ev.durationTicks) {
      active.push(ev)
    }
  }
  return active
}

// ─── 승객 생성 ───────────────────────────────────────────────────────────

function generatePassengers(
  stations: Station[],
  tick: number,
  demandMult: number,
  period: DayPeriod,
  weekend: boolean,
  activeEvents: GameEvent[],
  rng: () => number,
): Array<{
  cityId: string; originStationId: string; destStationId: string
  type: 'COMMUTER' | 'TOURIST' | 'WORKER'; createdAtTick: number
}> {
  const passengers = []
  const eventStations = new Set(activeEvents.map(e => e.affectedStationId).filter(Boolean))
  const dayKey = weekend ? 'WEEKEND' : 'WEEKDAY'
  const originWeights = ORIGIN_WEIGHT[dayKey][period]
  const destWeights = DEST_WEIGHT[dayKey][period]

  for (const station of stations) {
    let rate = SIM.BASE_PASSENGER_RATE * demandMult * (originWeights[station.type] ?? 1)

    if (eventStations.has(station.id)) {
      const ev = activeEvents.find(e => e.affectedStationId === station.id)
      rate *= ev?.demandMultiplier ?? 1.5
    }

    const count = Math.round(rate * (0.7 + rng() * 0.6))  // ±30% 랜덤
    for (let i = 0; i < count; i++) {
      const dest = pickDestination(stations, station.id, destWeights, rng)
      if (!dest) continue
      passengers.push({
        cityId: station.cityId,
        originStationId: station.id,
        destStationId: dest.id,
        type: pickPassengerType(station.type, demandMult, rng),
        createdAtTick: tick,
      })
    }
  }
  return passengers
}

// 목적지 역 타입 가중 추첨 (출발역 제외)
function pickDestination(
  stations: Station[],
  originId: string,
  weights: Record<string, number>,
  rng: () => number,
): Station | null {
  let total = 0
  for (const station of stations) {
    if (station.id !== originId) total += weights[station.type] ?? 1
  }
  if (total <= 0) return null
  let roll = rng() * total
  for (const station of stations) {
    if (station.id === originId) continue
    roll -= weights[station.type] ?? 1
    if (roll <= 0) return station
  }
  return null
}

function pickPassengerType(
  stationType: string,
  hourMult: number,
  rng: () => number,
): 'COMMUTER' | 'TOURIST' | 'WORKER' {
  if (stationType === 'TOURIST') return 'TOURIST'
  if (stationType === 'INDUSTRIAL') return rng() > 0.3 ? 'WORKER' : 'COMMUTER'
  return hourMult > 1.5 ? 'COMMUTER' : rng() > 0.5 ? 'COMMUTER' : 'TOURIST'
}

// ─── 역 스냅샷 구성 ──────────────────────────────────────────────────────

async function buildStationSnapshots(stations: Station[], cityId: string): Promise<StationSnapshot[]> {
  const waitingCounts = await db.passenger.groupBy({
    by: ['originStationId'],
    where: { cityId, boardedAtTick: null },
    _count: { id: true },
  })
  const countMap = new Map(waitingCounts.map(r => [r.originStationId, r._count.id]))

  const vehicleCounts = await db.vehicle.groupBy({
    by: ['currentStationId'],
    where: { line: { cityId }, status: 'OPERATING', isSpare: false },
    _count: { id: true },
  })
  const vehicleMap = new Map(vehicleCounts.map(r => [r.currentStationId!, r._count.id]))

  return stations.map(station => {
    const waiting = countMap.get(station.id) ?? 0
    const congestion = Math.min(waiting / station.capacity, 1.0)
    return {
      station,
      waitingCount: waiting,
      congestion,
      vehiclesPresent: vehicleMap.get(station.id) ?? 0,
    }
  })
}

// ─── 차량 이동 및 승하차 ─────────────────────────────────────────────────

async function moveVehiclesAndBoard(
  lines: Array<{ id: string; status: string; mode: string; lineStations: Array<{ station: Station; order: number }>; vehicles: Vehicle[] }>,
  snapshots: StationSnapshot[],
  tick: number,
): Promise<number> {
  let transported = 0
  const snapshotMap = new Map(snapshots.map(s => [s.station.id, s]))

  for (const line of lines) {
    if (line.status !== 'OPERATING') continue
    const stationOrder = line.lineStations.map(ls => ls.station)
    if (stationOrder.length < 2) continue

    const orderedVehicles = line.vehicles.slice().sort((a, b) => a.id.localeCompare(b.id))
    for (const vehicle of orderedVehicles) {
      if (!isVehicleInService(vehicle)) continue

      const motion = advanceVehicleMotion(stationOrder, {
        currentStationId: vehicle.currentStationId ?? stationOrder[0].id,
        direction: vehicle.direction,
        segmentProgressMinutes: vehicle.segmentProgressMinutes,
      }, SIM.GAME_MINUTES_PER_TICK, line.mode)

      // 한 경제 틱 안에 도착한 모든 역에서 승하차를 처리한다.
      for (const arrivedStationId of motion.arrivedStationIds) {
        const snap = snapshotMap.get(arrivedStationId)
        if (!snap || snap.waitingCount <= 0) continue
        const boarding = Math.min(snap.waitingCount, vehicle.capacity)
        const boardingPassengers = await db.passenger.findMany({
          where: { originStationId: arrivedStationId, boardedAtTick: null },
          select: { id: true },
          orderBy: [{ createdAtTick: 'asc' }, { id: 'asc' }],
          take: boarding,
        })
        if (boardingPassengers.length > 0) {
          await db.passenger.updateMany({
            where: { id: { in: boardingPassengers.map(passenger => passenger.id) } },
            data: { boardedAtTick: tick },
          })
          snap.waitingCount -= boardingPassengers.length
          snap.congestion = Math.min(snap.waitingCount / snap.station.capacity, 1)
          transported += boardingPassengers.length
        }
      }

      await db.vehicle.update({
        where: { id: vehicle.id },
        data: {
          currentStationId: motion.currentStationId,
          direction: motion.direction,
          segmentProgressMinutes: motion.segmentProgressMinutes,
        },
      })
      // 오프라인 복귀처럼 여러 틱을 한 번에 처리할 때 다음 반복이 방금 저장한
      // 구간 상태에서 계속 출발하도록 메모리 스냅샷도 함께 갱신한다.
      vehicle.currentStationId = motion.currentStationId
      vehicle.direction = motion.direction
      vehicle.segmentProgressMinutes = motion.segmentProgressMinutes
    }
  }
  return transported
}

// ─── 서비스 점수 계산 ────────────────────────────────────────────────────

function calcServiceScore(snapshots: StationSnapshot[]): number {
  if (snapshots.length === 0) return 100
  const avgCongestion = avgOf(snapshots.map(s => s.congestion))
  // 혼잡도 0 → 100점, 혼잡도 1 → 20점 (선형)
  return Math.max(20, 100 - avgCongestion * 80)
}

// ─── 하이라이트 수집 ─────────────────────────────────────────────────────

function collectHighlights(
  highlights: TickHighlight[],
  snapshots: StationSnapshot[],
  actions: { description: string; actionType: string }[],
  tick: number,
  hour: number,
) {
  const critical = snapshots.filter(s => s.congestion > 0.85)
  if (critical.length > 0) {
    highlights.push({
      tickNumber: tick,
      gameTimeHour: hour,
      type: 'CONGESTION',
      description: `${critical[0].station.name} 혼잡도 ${Math.round(critical[0].congestion * 100)}% 도달`,
      severity: critical[0].congestion > 0.95 ? 'CRITICAL' : 'WARNING',
    })
  }
  for (const action of actions) {
    highlights.push({
      tickNumber: tick,
      gameTimeHour: hour,
      type: 'AI_ACTION',
      description: action.description,
      severity: 'INFO',
    })
  }
}

// ─── 유틸 ────────────────────────────────────────────────────────────────

function avgOf(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}
