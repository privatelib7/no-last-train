import { db } from './db'
import { evaluatePolicies } from './policy-engine'
import { calculateTickEconomy } from './economy'
import { SIM, TIME_DEMAND_MULTIPLIER, ORIGIN_WEIGHT, DEST_WEIGHT, periodOfHour, isWeekendTick } from '@/types/game'
import type { SimResult, TickHighlight, StationSnapshot, DayPeriod } from '@/types/game'
import type { Passenger, Vehicle, Station, Line, GameEvent } from '@/generated/prisma/client'

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
    const pendingTicks = Math.min(Math.floor(elapsedMs / SIM.LIVE_TICK_MS), 12)
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
          vehicles: true,
          policies: { where: { isActive: true } },
        },
      },
      stations: true,
      events: { where: { status: { in: ['PENDING', 'ACTIVE'] } } },
    },
  })

  const rng = mulberry32(city.seed + city.currentTick)
  const highlights: TickHighlight[] = []
  let totalTransported = 0
  let revenueEarned = 0
  let operatingCost = 0
  let peakCongestion = 0
  let ticksProcessed = 0
  let cashBalance = city.cashBalance
  let totalRevenue = city.totalRevenue
  let happiness = city.happiness
  let score = city.score
  let insolvencyTicks = city.insolvencyTicks
  let unhappyTicks = city.unhappyTicks
  let goalReachedAtTick = city.goalReachedAtTick
  let gameOverReason: 'BANKRUPT' | 'HAPPINESS' | null = null
  const allActionLogs: Awaited<ReturnType<typeof evaluatePolicies>> = []

  for (let i = 0; i < count; i++) {
    const tickNumber = city.currentTick + ticksProcessed + 1
    const gameTimeHour = (tickNumber / SIM.TICKS_PER_GAME_HOUR) % 24
    const weekend = isWeekendTick(tickNumber)
    const period = periodOfHour(gameTimeHour)
    const baseDemand = TIME_DEMAND_MULTIPLIER[Math.floor(gameTimeHour)] ?? 1.0
    // 주말엔 출퇴근 피크가 없음
    const demandMult = weekend ? Math.min(baseDemand, 1.3) : baseDemand

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
      revenueGoal: city.revenueGoal,
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
        description: '첫 매출 목표를 달성해 운영 지원금 2천만 원을 받았습니다.',
        severity: 'INFO',
      })
    }

    ticksProcessed += 1
    if (gameOverReason) break
  }

  // 도시 틱 카운터 업데이트
  await db.city.update({
    where: { id: cityId },
    data: {
      currentTick: city.currentTick + ticksProcessed,
      lastTickAt: new Date(),
      cashBalance,
      totalRevenue,
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
    goalReached: goalReachedAtTick !== null,
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
    where: { line: { cityId }, status: 'OPERATING' },
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
      if (vehicle.status !== 'OPERATING' || vehicle.isSpare) continue
      if (!shouldVehicleMove(vehicle.id, tick, line.mode)) continue

      // 차량마다 3~9초의 서로 다른 운행 주기를 가지며, 끝역에서는 방향을 바꾼다.
      const currentIndex = stationOrder.findIndex(station => station.id === vehicle.currentStationId)
      let direction = vehicle.direction >= 0 ? 1 : -1
      let nextIndex = currentIndex >= 0 ? currentIndex + direction : 0
      if (nextIndex < 0 || nextIndex >= stationOrder.length) {
        direction *= -1
        nextIndex = Math.max(0, Math.min(stationOrder.length - 1, currentIndex + direction))
      }
      const nextStation = stationOrder[nextIndex]

      // 승하차 처리
      const snap = snapshotMap.get(nextStation.id)
      if (snap && snap.waitingCount > 0) {
        const boarding = Math.min(snap.waitingCount, vehicle.capacity)
        const boardingPassengers = await db.passenger.findMany({
          where: { originStationId: nextStation.id, boardedAtTick: null },
          select: { id: true },
          orderBy: [{ createdAtTick: 'asc' }, { id: 'asc' }],
          take: boarding,
        })
        await db.passenger.updateMany({
          where: { id: { in: boardingPassengers.map(passenger => passenger.id) } },
          data: { boardedAtTick: tick },
        })
        transported += boarding
      }

      await db.vehicle.update({
        where: { id: vehicle.id },
        data: { currentStationId: nextStation.id, direction },
      })
    }
  }
  return transported
}

function vehicleTiming(vehicleId: string, mode: string = 'SUBWAY') {
  let hash = 2166136261
  for (let index = 0; index < vehicleId.length; index++) {
    hash ^= vehicleId.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  const unsigned = hash >>> 0
  // 버스는 지하철보다 한 단계 느림 (2~4틱)
  const interval = 1 + (unsigned % 3) + (mode === 'BUS' ? 1 : 0)
  const phase = Math.floor(unsigned / 3) % interval
  return { interval, phase }
}

function shouldVehicleMove(vehicleId: string, tick: number, mode: string = 'SUBWAY') {
  const { interval, phase } = vehicleTiming(vehicleId, mode)
  return tick % interval === phase
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
