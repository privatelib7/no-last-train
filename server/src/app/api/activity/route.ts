import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

const DAY_MS = 24 * 60 * 60 * 1000

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-player-token',
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

// GET /api/activity — 로비 "최근 활동" 피드
// 로그인한 플레이어가 소유한 도시(관제장 또는 소유 노선)에서
// 최근 24시간 안에 일어난 활동(플레이어 버튼 액션 + AI 정책 액션)만 반환한다.
export async function GET(req: NextRequest) {
  const token = req.headers.get('x-player-token')
  if (!token) {
    return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401, headers: corsHeaders() })
  }

  const player = await db.player.findUnique({ where: { token } })
  if (!player) {
    return NextResponse.json({ error: '세션이 만료되었습니다. 다시 로그인해주세요.' }, { status: 401, headers: corsHeaders() })
  }

  const since = new Date(Date.now() - DAY_MS)

  const logs = await db.activityLog.findMany({
    where: {
      createdAt: { gte: since },
      city: {
        OR: [
          { ownerPlayerId: player.id },
          { lines: { some: { playerId: player.id } } },
        ],
      },
    },
    include: {
      city: { select: { id: true, name: true, roomTitle: true } },
      player: { select: { nickname: true, username: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  const activity = logs.map((log) => ({
    id: log.id,
    cityId: log.cityId,
    cityName: log.city.name,
    roomTitle: log.city.roomTitle,
    actor: log.player ? (log.player.nickname ?? log.player.username ?? '플레이어') : 'AI',
    message: log.message,
    createdAt: log.createdAt.toISOString(),
  }))

  return NextResponse.json({ activity }, { headers: corsHeaders() })
}
