import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { z } from 'zod'

const VerifySchema = z.object({ token: z.string().min(1) })

// POST /api/auth/verify-email — 이메일 인증 링크의 토큰을 검증하고 계정을 활성화
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = VerifySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: '인증 토큰이 없습니다.' }, { status: 400 })
  }

  const record = await db.emailVerificationToken.findUnique({ where: { token: parsed.data.token } })
  if (!record || record.expiresAt < new Date()) {
    return NextResponse.json({ error: '인증 링크가 만료되었거나 올바르지 않습니다.' }, { status: 400 })
  }

  await db.$transaction([
    db.player.update({ where: { id: record.playerId }, data: { emailVerifiedAt: new Date() } }),
    db.emailVerificationToken.deleteMany({ where: { playerId: record.playerId } }),
  ])

  return NextResponse.json({ message: '이메일 인증이 완료되었습니다. 이제 로그인할 수 있습니다.' })
}
