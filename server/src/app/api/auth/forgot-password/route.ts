import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sendPasswordResetEmail } from '@/lib/mailer'
import { z } from 'zod'
import { randomUUID } from 'crypto'

const RESET_TTL_MS = 60 * 60 * 1000

const ForgotPasswordSchema = z.object({ identifier: z.string().min(1) })

// POST /api/auth/forgot-password — 비밀번호 재설정 메일 발송
// 계정 존재 여부를 노출하지 않기 위해 항상 동일한 메시지를 반환한다.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = ForgotPasswordSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: '아이디 또는 이메일을 입력해주세요.' }, { status: 400 })
  }

  const player = await db.player.findFirst({
    where: { OR: [{ username: parsed.data.identifier }, { email: parsed.data.identifier }] },
  })
  let resetUrl: string | undefined

  if (player && player.email && player.passwordHash) {
    const resetToken = randomUUID()
    await db.passwordResetToken.deleteMany({ where: { playerId: player.id } })
    await db.passwordResetToken.create({
      data: { playerId: player.id, token: resetToken, expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    })
    resetUrl = await sendPasswordResetEmail(player.email, resetToken).catch((err) => {
      console.error('비밀번호 재설정 메일 발송 실패:', err)
      return undefined
    })
  }

  return NextResponse.json({
    message: '해당 계정이 있다면 비밀번호 재설정 메일을 보냈습니다. 스팸함도 확인해보세요.',
    ...(process.env.NODE_ENV !== 'production' && resetUrl ? { resetUrl } : {}),
  })
}
