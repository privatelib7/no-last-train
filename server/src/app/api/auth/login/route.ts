import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword } from '@/lib/auth'
import { z } from 'zod'
import { randomUUID } from 'crypto'

const LoginSchema = z.object({
  identifier: z.string().min(1, '아이디 또는 이메일을 입력해주세요.'),
  password: z.string().min(1, '비밀번호를 입력해주세요.'),
})

// POST /api/auth/login — 아이디 또는 이메일 + 비밀번호 로그인
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = LoginSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: '아이디 또는 이메일과 비밀번호를 입력해주세요.' }, { status: 400 })
  }

  const { identifier, password } = parsed.data

  const invalidCredentials = () =>
    NextResponse.json({ error: '아이디, 이메일 또는 비밀번호가 올바르지 않습니다.' }, { status: 401 })

  const player = await db.player.findFirst({
    where: { OR: [{ username: identifier }, { email: identifier }] },
  })
  if (!player || !player.passwordHash) {
    return invalidCredentials()
  }

  const valid = await verifyPassword(password, player.passwordHash)
  if (!valid) {
    return invalidCredentials()
  }

  const updated = await db.player.update({
    where: { id: player.id },
    data: { token: randomUUID() },
  })

  return NextResponse.json({
    playerId: updated.id,
    token: updated.token,
    username: updated.username,
    nickname: updated.nickname,
    email: updated.email,
  })
}
