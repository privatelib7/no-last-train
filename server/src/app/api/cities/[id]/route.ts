import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { SIM } from '@/types/game'

// GET /api/cities/[id] — 도시 현재 상태 전체 조회
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

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

  // 오프라인 시간 계산 (게임시간 기준)
  const elapsedMs = Date.now() - city.lastTickAt.getTime()
  const elapsedGameHours = (elapsedMs / 1000 / 60) * SIM.TICKS_PER_GAME_HOUR  // 실제 분 → 게임 시간

  return NextResponse.json({ city, elapsedGameHours })
}
