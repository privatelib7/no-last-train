import { db } from './db'
import type { Line, Policy, Vehicle } from '@prisma/client'
import type { StationSnapshot } from '@/types/game'

type LineWithPolicies = Line & { policies: Policy[]; vehicles: Vehicle[] }

// ─── 정책 평가 및 실행 ───────────────────────────────────────────────────

export async function evaluatePolicies(
  lines: LineWithPolicies[],
  snapshots: StationSnapshot[],
  tickId: string,
): Promise<Array<{ description: string; actionType: string }>> {
  const firedActions: Array<{ description: string; actionType: string }> = []
  const snapshotMap = new Map(snapshots.map(s => [s.station.id, s]))

  for (const line of lines) {
    for (const policy of line.policies) {
      const conditionMet = checkCondition(policy, snapshotMap)
      if (!conditionMet.triggered) continue

      const result = await executeAction(policy, line, tickId, conditionMet.description)
      if (result) firedActions.push(result)
    }
  }
  return firedActions
}

// ─── 조건 평가 ───────────────────────────────────────────────────────────

interface ConditionResult {
  triggered: boolean
  description: string
}

function checkCondition(
  policy: Policy,
  snapshots: Map<string, StationSnapshot>,
): ConditionResult {
  switch (policy.type) {
    case 'CONGESTION_RESPONSE': {
      if (!policy.conditionStationId || !policy.conditionThreshold) {
        return { triggered: false, description: '' }
      }
      const snap = snapshots.get(policy.conditionStationId)
      if (!snap) return { triggered: false, description: '' }
      const congestionPct = snap.congestion * 100
      const triggered = congestionPct >= policy.conditionThreshold
      return {
        triggered,
        description: `${snap.station.name} 혼잡도 ${Math.round(congestionPct)}% (임계값 ${policy.conditionThreshold}%)`,
      }
    }

    case 'SUPPORT_CONDITION': {
      // 지원 요청 조건: 내 노선 혼잡도가 임계값 이하일 때
      if (!policy.conditionThreshold) return { triggered: false, description: '' }
      const myStations = [...snapshots.values()]
      const myAvgCongestion = myStations.length > 0
        ? myStations.reduce((a, s) => a + s.congestion, 0) / myStations.length * 100
        : 0
      const triggered = myAvgCongestion < policy.conditionThreshold
      return {
        triggered,
        description: `내 노선 평균 혼잡도 ${Math.round(myAvgCongestion)}% (지원 허용 기준 ${policy.conditionThreshold}% 미만)`,
      }
    }

    case 'PASSENGER_PRIORITY':
      return { triggered: true, description: '승객 우선순위 정책 상시 적용' }

    default:
      return { triggered: false, description: '' }
  }
}

// ─── 행동 실행 ───────────────────────────────────────────────────────────

async function executeAction(
  policy: Policy,
  line: LineWithPolicies,
  tickId: string,
  conditionDescription: string,
): Promise<{ description: string; actionType: string } | null> {
  switch (policy.actionType) {
    // 차량의 운행/대기 상태는 관제실의 운행·입고 버튼으로만 바꾼다.
    // 기존 저장 정책은 보존하되 자동 투입·대여로 상태를 덮어쓰지 않는다.
    case 'DEPLOY_SPARE':
    case 'LEND_VEHICLE':
      return null

    case 'ADJUST_HEADWAY': {
      const newHeadway = Math.max(2, Math.round((line.vehicles[0]?.headwayMinutes ?? 5) * 0.7))
      await db.vehicle.updateMany({
        where: { lineId: line.id, status: 'OPERATING' },
        data: { headwayMinutes: newHeadway },
      })
      for (const vehicle of line.vehicles) {
        if (vehicle.status === 'OPERATING') vehicle.headwayMinutes = newHeadway
      }
      const description = `배차 간격을 ${newHeadway}분으로 단축했습니다. 조건: ${conditionDescription}`
      await db.actionLog.create({
        data: {
          lineId: line.id,
          tickId,
          actionType: 'ADJUST_HEADWAY',
          description,
          conditionMet: conditionDescription,
          resourceUsed: 0,
        },
      })
      await db.activityLog.create({
        data: { cityId: line.cityId, playerId: null, message: `[${line.name}] ${description}` },
      })
      return { description, actionType: 'ADJUST_HEADWAY' }
    }

    default:
      return null
  }
}
