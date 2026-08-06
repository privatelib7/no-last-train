import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { syncCityClock } from '@/lib/simulation'
import { z } from 'zod'

const SimSchema = z.object({
  ticks: z.number().int().min(1).max(12),
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

  const result = await syncCityClock(id)

  return NextResponse.json(result ?? {
    ticksProcessed: 0,
    totalTransported: 0,
    peakCongestion: 0,
    serviceScore: 100,
    actionsFired: [],
    highlights: [],
  })
}
