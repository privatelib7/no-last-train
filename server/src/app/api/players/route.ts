import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { z } from 'zod'
import { randomUUID } from 'crypto'

const CreatePlayerSchema = z.object({
  nickname: z.string().max(20).optional(),
})

// POST /api/players — 익명 플레이어 세션 생성
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const parsed = CreatePlayerSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const token = randomUUID()
  const player = await db.player.create({
    data: { token, nickname: parsed.data.nickname },
  })

  return NextResponse.json({ playerId: player.id, token }, { status: 201 })
}
