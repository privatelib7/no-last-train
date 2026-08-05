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

      const result = await executeAction(policy, line, lines, tickId, conditionMet.description)
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
  allLines: LineWithPolicies[],
  tickId: string,
  conditionDescription: string,
): Promise<{ description: string; actionType: string } | null> {
  switch (policy.actionType) {
    case 'DEPLOY_SPARE': {
      const spare = line.vehicles.find(v => v.status === 'SPARE' && v.isSpare)
      if (!spare) return null

      await db.vehicle.update({
        where: { id: spare.id },
        data: { status: 'OPERATING' },
      })
      const description = `예비 차량 1대를 투입했습니다. 조건: ${conditionDescription}`
      await db.actionLog.create({
        data: {
          lineId: line.id,
          tickId,
          actionType: 'DEPLOY_SPARE',
          description,
          conditionMet: conditionDescription,
          resourceUsed: 1,
        },
      })
      return { description, actionType: 'DEPLOY_SPARE' }
    }

    case 'LEND_VEHICLE': {
      if (!policy.actionTargetLineId) return null
      const targetLine = allLines.find(l => l.id === policy.actionTargetLineId)
      if (!targetLine) return null

      const spare = line.vehicles.find(v => v.status === 'SPARE' && v.isSpare)
      if (!spare) return null

      await db.$transaction([
        db.vehicle.update({ where: { id: spare.id }, data: { status: 'LOANED' } }),
        db.support.create({
          data: {
            fromLineId: line.id,
            toLineId: targetLine.id,
            vehicleId: spare.id,
            durationTicks: policy.resourceLimit * 12, // 기본 2시간 (12틱)
          },
        }),
      ])
      const description = `${targetLine.name ?? targetLine.color} 노선에 예비 차량 1대를 ${policy.resourceLimit * 2}시간 대여했습니다. 조건: ${conditionDescription}`
      await db.actionLog.create({
        data: {
          lineId: line.id,
          tickId,
          actionType: 'LEND_VEHICLE',
          description,
          conditionMet: conditionDescription,
          resourceUsed: 1,
        },
      })
      return { description, actionType: 'LEND_VEHICLE' }
    }

    case 'ADJUST_HEADWAY': {
      const newHeadway = Math.max(2, Math.round((line.vehicles[0]?.headwayMinutes ?? 5) * 0.7))
      await db.vehicle.updateMany({
        where: { lineId: line.id, status: 'OPERATING' },
        data: { headwayMinutes: newHeadway },
      })
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
      return { description, actionType: 'ADJUST_HEADWAY' }
    }

    default:
      return null
  }
}
