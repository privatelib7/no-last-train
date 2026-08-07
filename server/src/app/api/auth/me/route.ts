import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// GET /api/auth/me — 저장된 세션 토큰 검증 (자동 로그인용)
export async function GET(req: NextRequest) {
  const token = req.headers.get('x-player-token')
  if (!token) {
    return NextResponse.json({ error: '토큰이 없습니다.' }, { status: 401 })
  }

  const player = await db.player.findUnique({ where: { token } })
  if (!player) {
    return NextResponse.json({ error: '세션이 만료되었습니다.' }, { status: 401 })
  }

  return NextResponse.json({
    playerId: player.id,
    username: player.username,
    nickname: player.nickname,
  })
}
