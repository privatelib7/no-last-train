import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { simulateTicks } from '@/lib/simulation'
import { SIM } from '@/types/game'
import type { ReturnReport } from '@/types/game'

// GET /api/cities/[id]/report — 복귀 리포트 (오프라인 시간 누적 + 요약)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const playerToken = req.headers.get('x-player-token')

  const city = await db.city.findUnique({
    where: { id },
    include: {
      lines: {
        include: {
          actionLogs: { orderBy: { createdAt: 'desc' }, take: 20 },
          supportsGiven: { where: { status: 'COMPLETED' } },
          supportsReceived: { where: { status: 'COMPLETED' } },
        },
      },
    },
  })
  if (!city) return NextResponse.json({ error: '도시 없음' }, { status: 404 })

  // 오프라인 경과 시간 → 실행할 틱 수 계산
  const elapsedMs = Date.now() - city.lastTickAt.getTime()
  const elapsedRealMinutes = elapsedMs / 1000 / 60
  // 실제 1분 = 게임 1시간 = 6틱 (데모 설정)
  const pendingTicks = Math.min(
    Math.floor(elapsedRealMinutes * SIM.TICKS_PER_GAME_HOUR),
    SIM.MAX_OFFLINE_HOURS * SIM.TICKS_PER_GAME_HOUR,  // 최대 72틱 (12시간)
  )

  // 오프라인 틱 실행 (없으면 건너뜀)
  let simResult = null
  if (pendingTicks > 0 && city.status === 'ACTIVE') {
    simResult = await simulateTicks(id, pendingTicks)
  }

  // 최근 지표
  const recentTicks = await db.simTick.findMany({
    where: { cityId: id },
    orderBy: { tickNumber: 'desc' },
    take: pendingTicks || 1,
  })

  const totalTransported = recentTicks.reduce((a, t) => a + t.passengersTransported, 0)
  const peakCongestion = Math.max(...recentTicks.map(t => t.avgCongestion), 0)
  const serviceScore = recentTicks[0]?.serviceScore ?? 100

  // 상위 3개 AI 행동 로그
  const playerLine = city.lines.find(l => l.playerId !== null)
  const topActions = playerLine
    ? await db.actionLog.findMany({
        where: { lineId: playerLine.id },
        orderBy: { createdAt: 'desc' },
        take: 3,
      })
    : []

  // 지원 집계
  const supportsGiven = city.lines.reduce((a, l) => a + l.supportsGiven.length, 0)
  const supportsReceived = city.lines.reduce((a, l) => a + l.supportsReceived.length, 0)

  // 정책 추천 (간단한 규칙 기반)
  const recommendations: string[] = []
  if (peakCongestion > 0.85) {
    recommendations.push('혼잡 대응 임계값을 현재보다 10% 낮추는 것을 추천합니다.')
  }
  if (supportsGiven === 0 && supportsReceived > 0) {
    recommendations.push('다른 노선 지원 정책을 추가하면 도시 전체 서비스 점수가 오릅니다.')
  }

  const report: ReturnReport = {
    offlineTicks: pendingTicks,
    offlineGameHours: pendingTicks / SIM.TICKS_PER_GAME_HOUR,
    totalTransported,
    peakCongestion,
    serviceScore,
    supportsGiven,
    supportsReceived,
    topActions,
    highlights: simResult?.highlights ?? [],
    recommendations,
  }

  return NextResponse.json(report)
}
