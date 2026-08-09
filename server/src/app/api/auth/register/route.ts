import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, USERNAME_PATTERN } from '@/lib/auth'
import { z } from 'zod'
import { randomUUID } from 'crypto'

const RegisterSchema = z.object({
  username: z.string().regex(USERNAME_PATTERN, '아이디는 영문/숫자/밑줄 3~20자여야 합니다.'),
  password: z.string().min(8, '비밀번호는 8자 이상이어야 합니다.').max(72),
  email: z.string().trim().email('올바른 이메일 주소를 입력해주세요.'),
  nickname: z.string().trim().min(1).max(20).optional(),
})

// POST /api/auth/register — 아이디/비밀번호/이메일 회원가입 (데모: 이메일 인증 없이 즉시 가입 완료)
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

  await db.player.create({
    data: {
      token,
      username,
      passwordHash,
      email,
      nickname: nickname ?? username,
      emailVerifiedAt: new Date(),
    },
  })

  return NextResponse.json(
    {
      message: '회원가입이 완료되었습니다. 바로 로그인할 수 있습니다.',
      username,
      email,
    },
    { status: 201 },
  )
}
