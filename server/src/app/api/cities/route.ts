import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { CITY_NAMES, isCityName, pickRandomRoomTitle } from '@/lib/city-names'
import { z } from 'zod'

const CreateCitySchema = z.object({
  name: z
    .string()
    .trim()
    .refine(isCityName, `도시 이름은 ${CITY_NAMES.join(', ')} 중 하나여야 합니다.`),
  roomTitle: z.string().trim().min(1).max(24).optional(),
  playerToken: z.string().uuid(),
  lineColor: z.enum(['RED', 'BLUE', 'GREEN', 'YELLOW', 'PURPLE']),
})

const LINE_COLOR_MAP: Record<string, string> = {
  RED: 'red',
  BLUE: 'blue',
  GREEN: 'green',
  YELLOW: 'yellow',
  PURPLE: 'purple',
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-player-token',
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

// POST /api/cities — 새 도시(게임 세션) 생성 + 고정 맵 초기화
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = CreateCitySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? '요청을 확인해주세요.' },
      { status: 400, headers: corsHeaders() },
    )
  }

  const player = await db.player.findUnique({ where: { token: parsed.data.playerToken } })
  if (!player) {
    return NextResponse.json({ error: '플레이어를 찾을 수 없습니다.' }, { status: 404, headers: corsHeaders() })
  }

  const seed = Math.floor(Math.random() * 1_000_000)
  const cityName = parsed.data.name
  const roomTitle = parsed.data.roomTitle ?? pickRandomRoomTitle()
  // 도시 이름이 곧 맵 선택 — 클라이언트는 mapKey를 따로 보내지 않는다.
  // 역·노선·이벤트는 두지 않고 빈 맵으로 시작한다.
  const mapKey = cityName === '서울' ? 'SEOUL' : 'BUSAN'

  const city = await db.city.create({
    data: {
      name: cityName,
      roomTitle,
      mapKey,
      seed,
      ownerPlayerId: player.id,
    },
  })

  return NextResponse.json(
    { cityId: city.id, name: city.name, roomTitle: city.roomTitle },
    { status: 201, headers: corsHeaders() },
  )
}

// GET /api/cities — 로비용 도시 목록 (노선 수 · 생성일)
// - x-player-token 있으면 해당 플레이어 도시만
// - 없으면 전체 도시 (로비 데모)
export async function GET(req: NextRequest) {
  const token = req.headers.get('x-player-token')

  let player: { id: string } | null = null
  if (token) {
    player = await db.player.findUnique({ where: { token }, select: { id: true } })
    if (!player) {
      return NextResponse.json({ error: '플레이어 없음' }, { status: 404, headers: corsHeaders() })
    }
  }

  // 로그인 상태면 관제장 도시 + 소유 노선 도시만 보여준다. (공유 링크 참가는 링크 직접 진입)
  const cities = await db.city.findMany({
    where: player
      ? {
          OR: [
            { ownerPlayerId: player.id },
            { lines: { some: { playerId: player.id } } },
          ],
        }
      : undefined,
    include: {
      lines: {
        select: { color: true },
        orderBy: { color: 'asc' },
      },
      _count: { select: { lines: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const payload = cities.map((city) => ({
    id: city.id,
    name: city.name,
    roomTitle: city.roomTitle,
    mapKey: city.mapKey,
    seasonDay: city.seasonDay,
    status: city.status,
    lineCount: city._count.lines,
    lines: city.lines.map((l) => LINE_COLOR_MAP[l.color] ?? l.color.toLowerCase()),
    createdAt: city.createdAt.toISOString(),
  }))

  return NextResponse.json({ cities: payload }, { headers: corsHeaders() })
}
