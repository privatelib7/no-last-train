import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sendVerificationEmail } from '@/lib/mailer'
import { z } from 'zod'
import { randomUUID } from 'crypto'

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000

const ResendSchema = z.object({ identifier: z.string().min(1) })

// POST /api/auth/resend-verification — 인증 메일 재발송
// 계정 존재 여부를 노출하지 않기 위해 항상 동일한 메시지를 반환한다.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = ResendSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: '아이디 또는 이메일을 입력해주세요.' }, { status: 400 })
  }

  const player = await db.player.findFirst({
    where: { OR: [{ username: parsed.data.identifier }, { email: parsed.data.identifier }] },
  })
  let verifyUrl: string | undefined

  if (player && !player.emailVerifiedAt && player.email) {
    const verifyToken = randomUUID()
    await db.emailVerificationToken.deleteMany({ where: { playerId: player.id } })
    await db.emailVerificationToken.create({
      data: { playerId: player.id, token: verifyToken, expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) },
    })
    verifyUrl = await sendVerificationEmail(player.email, verifyToken).catch((err) => {
      console.error('인증 메일 재발송 실패:', err)
      return undefined
    })
  }

  return NextResponse.json({
    message: '해당 계정이 미인증 상태라면 인증 메일을 다시 보냈습니다. 스팸함도 확인해보세요.',
    ...(process.env.NODE_ENV !== 'production' && verifyUrl ? { verifyUrl } : {}),
  })
}
