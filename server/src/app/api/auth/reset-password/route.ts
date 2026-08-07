import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { z } from 'zod'

const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, '비밀번호는 8자 이상이어야 합니다.').max(72),
})

// POST /api/auth/reset-password — 재설정 토큰을 검증하고 새 비밀번호로 교체
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = ResetPasswordSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? '입력값을 확인해주세요.' }, { status: 400 })
  }

  const { token, password } = parsed.data

  const record = await db.passwordResetToken.findUnique({ where: { token } })
  if (!record || record.expiresAt < new Date()) {
    return NextResponse.json({ error: '재설정 링크가 만료되었거나 올바르지 않습니다.' }, { status: 400 })
  }

  const passwordHash = await hashPassword(password)

  await db.$transaction([
    db.player.update({ where: { id: record.playerId }, data: { passwordHash } }),
    db.passwordResetToken.deleteMany({ where: { playerId: record.playerId } }),
  ])

  return NextResponse.json({ message: '비밀번호가 재설정되었습니다. 이제 새 비밀번호로 로그인할 수 있습니다.' })
}
