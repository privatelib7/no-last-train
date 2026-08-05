import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { simulateTicks } from '@/lib/simulation'
import { z } from 'zod'
import { SIM } from '@/types/game'

const SimSchema = z.object({
  ticks: z.number().int().min(1).max(500),
  demoMode: z.boolean().default(false),  // true면 6 게임시간 = 36틱 압축
})

// POST /api/cities/[id]/simulate — 시뮬레이션 틱 실행
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const parsed = SimSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const city = await db.city.findUnique({ where: { id } })
  if (!city) return NextResponse.json({ error: '도시 없음' }, { status: 404 })
  if (city.status === 'SEASON_ENDED') {
    return NextResponse.json({ error: '이미 종료된 시즌입니다.' }, { status: 409 })
  }

  // 데모 모드: 6 게임시간 = 6 * TICKS_PER_GAME_HOUR = 36틱
  const tickCount = parsed.data.demoMode
    ? 6 * SIM.TICKS_PER_GAME_HOUR
    : parsed.data.ticks

  const result = await simulateTicks(id, tickCount)

  // 3일 시즌 체크 (3 * 24 * 6 = 432틱)
  const updatedCity = await db.city.findUnique({ where: { id } })
  if (updatedCity && updatedCity.currentTick >= 3 * 24 * SIM.TICKS_PER_GAME_HOUR) {
    await db.city.update({ where: { id }, data: { status: 'SEASON_ENDED' } })
  }

  return NextResponse.json(result)
}
