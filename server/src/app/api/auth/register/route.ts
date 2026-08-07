import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, USERNAME_PATTERN } from '@/lib/auth'
import { sendVerificationEmail } from '@/lib/mailer'
import { z } from 'zod'
import { randomUUID } from 'crypto'

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000

const RegisterSchema = z.object({
  username: z.string().regex(USERNAME_PATTERN, '아이디는 영문/숫자/밑줄 3~20자여야 합니다.'),
  password: z.string().min(8, '비밀번호는 8자 이상이어야 합니다.').max(72),
  email: z.string().trim().email('올바른 이메일 주소를 입력해주세요.'),
  nickname: z.string().trim().min(1).max(20).optional(),
})

// POST /api/auth/register — 아이디/비밀번호/이메일 회원가입 (이메일 인증 전까지 로그인 불가)
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = RegisterSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? '입력값을 확인해주세요.' }, { status: 400 })
  }

  const { username, password, email, nickname } = parsed.data

  const [existingUsername, existingEmail] = await Promise.all([
    db.player.findUnique({ where: { username } }),
    db.player.findUnique({ where: { email } }),
  ])
  if (existingUsername) {
    return NextResponse.json({ error: '이미 사용 중인 아이디입니다.' }, { status: 409 })
  }
  if (existingEmail) {
    return NextResponse.json({ error: '이미 사용 중인 이메일입니다.' }, { status: 409 })
  }

  const passwordHash = await hashPassword(password)
  const token = randomUUID()
  const verifyToken = randomUUID()

  const player = await db.player.create({
    data: {
      token,
      username,
      passwordHash,
      email,
      nickname: nickname ?? username,
      verificationTokens: {
        create: { token: verifyToken, expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) },
      },
    },
  })

  let verifyUrl: string | undefined
  try {
    verifyUrl = await sendVerificationEmail(email, verifyToken)
  } catch (err) {
    await db.player.delete({ where: { id: player.id } })
    console.error('인증 메일 발송 실패:', err)
    return NextResponse.json({ error: '인증 메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.' }, { status: 502 })
  }

  return NextResponse.json(
    {
      message: '인증 메일을 보냈습니다. 메일함을 확인해주세요.',
      username,
      email,
      // 로컬에서 메일이 안 보일 때 바로 인증할 수 있게 개발 환경에서만 링크를 내려준다.
      ...(process.env.NODE_ENV !== 'production' ? { verifyUrl } : {}),
    },
    { status: 201 },
  )
}
