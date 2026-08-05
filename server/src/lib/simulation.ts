import { db } from './db'
import { evaluatePolicies } from './policy-engine'
import { SIM, TIME_DEMAND_MULTIPLIER } from '@/types/game'
import type { SimResult, TickHighlight, StationSnapshot } from '@/types/game'
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

export async function simulateTicks(cityId: string, count: number): Promise<SimResult> {
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
  let peakCongestion = 0
  const allActionLogs: Awaited<ReturnType<typeof evaluatePolicies>> = []

  for (let i = 0; i < count; i++) {
    const tickNumber = city.currentTick + i + 1
    const gameTimeHour = (tickNumber / SIM.TICKS_PER_GAME_HOUR) % 24
    const demandMult = TIME_DEMAND_MULTIPLIER[Math.floor(gameTimeHour)] ?? 1.0

    // 1. 사건 활성화
    const activeEvents = activateEvents(city.events, tickNumber)

    // 2. 승객 생성
    const newPassengers = generatePassengers(city.stations, tickNumber, demandMult, activeEvents, rng)
    if (newPassengers.length > 0) {
      await db.passenger.createMany({ data: newPassengers })
    }

    // 3. 역별 대기 승객 조회
    const stationSnapshots = await buildStationSnapshots(city.stations, cityId)

    // 4. 차량 이동 + 승하차
    const transported = await moveVehiclesAndBoard(city.lines, stationSnapshots, tickNumber)
    totalTransported += transported

    // 5. AI 정책 평가 및 실행
    const tickRecord = await db.simTick.create({
      data: {
        cityId,
        tickNumber,
        gameTimeHour,
        passengersTransported: transported,
        avgCongestion: avgOf(stationSnapshots.map(s => s.congestion)),
        serviceScore: calcServiceScore(stationSnapshots),
      },
    })

    const policyActions = await evaluatePolicies(city.lines, stationSnapshots, tickRecord.id)
    allActionLogs.push(...policyActions)

    // 6. 혼잡 최고치 추적
    const maxCongestion = Math.max(...stationSnapshots.map(s => s.congestion))
    if (maxCongestion > peakCongestion) peakCongestion = maxCongestion

    // 7. 하이라이트 수집
    collectHighlights(highlights, stationSnapshots, policyActions, tickNumber, gameTimeHour)
  }

  // 도시 틱 카운터 업데이트
  await db.city.update({
    where: { id: cityId },
    data: { currentTick: city.currentTick + count, lastTickAt: new Date() },
  })

  const lastTick = await db.simTick.findFirst({
    where: { cityId },
    orderBy: { tickNumber: 'desc' },
  })

  return {
    ticksProcessed: count,
    totalTransported,
    peakCongestion,
    serviceScore: lastTick?.serviceScore ?? 100,
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
  activeEvents: GameEvent[],
  rng: () => number,
): Array<{
  cityId: string; originStationId: string; destStationId: string
  type: 'COMMUTER' | 'TOURIST' | 'WORKER'; createdAtTick: number
}> {
  const passengers = []
  const eventStations = new Set(activeEvents.map(e => e.affectedStationId).filter(Boolean))

  for (const station of stations) {
    let rate = SIM.BASE_PASSENGER_RATE * demandMult * typeMultiplier(station.type, demandMult)

    if (eventStations.has(station.id)) {
      const ev = activeEvents.find(e => e.affectedStationId === station.id)
      rate *= ev?.demandMultiplier ?? 1.5
    }

    const count = Math.round(rate * (0.7 + rng() * 0.6))  // ±30% 랜덤
    for (let i = 0; i < count; i++) {
      const dest = stations[Math.floor(rng() * stations.length)]
      if (dest.id === station.id) continue
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

function typeMultiplier(stationType: string, hourMult: number): number {
  if (stationType === 'RESIDENTIAL') return hourMult > 1.5 ? 1.4 : 0.8
  if (stationType === 'COMMERCIAL') return hourMult > 1.5 ? 0.9 : 1.2
  if (stationType === 'TOURIST') return 1.1
  return 1.0
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
  lines: Array<{ id: string; lineStations: Array<{ station: Station; order: number }>; vehicles: Vehicle[] }>,
  snapshots: StationSnapshot[],
  tick: number,
): Promise<number> {
  let transported = 0
  const snapshotMap = new Map(snapshots.map(s => [s.station.id, s]))

  for (const line of lines) {
    const stationOrder = line.lineStations.map(ls => ls.station)
    if (stationOrder.length < 2) continue

    for (const vehicle of line.vehicles) {
      if (vehicle.status !== 'OPERATING' || vehicle.isSpare) continue

      // 간단한 순환 이동: tick 기반으로 현재 역 결정
      const stationIndex = tick % stationOrder.length
      const nextStation = stationOrder[stationIndex]

      // 승하차 처리
      const snap = snapshotMap.get(nextStation.id)
      if (snap && snap.waitingCount > 0) {
        const boarding = Math.min(snap.waitingCount, vehicle.capacity)
        await db.passenger.updateMany({
          where: { originStationId: nextStation.id, boardedAtTick: null },
          data: { boardedAtTick: tick },
        })
        transported += boarding
      }

      await db.vehicle.update({
        where: { id: vehicle.id },
        data: { currentStationId: nextStation.id },
      })
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
