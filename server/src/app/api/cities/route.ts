import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { z } from 'zod'

const CreateCitySchema = z.object({
  name: z.string().min(1).max(20),
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
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400, headers: corsHeaders() })
  }

  const player = await db.player.findUnique({ where: { token: parsed.data.playerToken } })
  if (!player) {
    return NextResponse.json({ error: '플레이어를 찾을 수 없습니다.' }, { status: 404, headers: corsHeaders() })
  }

  const seed = Math.floor(Math.random() * 1_000_000)

  const city = await db.$transaction(async (tx) => {
    const city = await tx.city.create({
      data: { name: parsed.data.name, seed },
    })

    const stationDefs = [
      { name: '중앙역', type: 'HUB' as const, posX: 400, posY: 300 },
      { name: '북부역', type: 'RESIDENTIAL' as const, posX: 300, posY: 150 },
      { name: '남부역', type: 'COMMERCIAL' as const, posX: 500, posY: 450 },
      { name: '동부역', type: 'INDUSTRIAL' as const, posX: 600, posY: 280 },
      { name: '서부역', type: 'RESIDENTIAL' as const, posX: 200, posY: 320 },
      { name: '공원역', type: 'TOURIST' as const, posX: 350, posY: 420 },
      { name: '대학역', type: 'COMMERCIAL' as const, posX: 480, posY: 180 },
      { name: '외곽역', type: 'RESIDENTIAL' as const, posX: 650, posY: 420 },
    ]

    const stations = await Promise.all(
      stationDefs.map((s) => tx.station.create({ data: { ...s, cityId: city.id } })),
    )
    const [central, north, south, east, west, park, univ, outer] = stations

    const redLine = await tx.line.create({
      data: {
        cityId: city.id,
        playerId: player.id,
        color: parsed.data.lineColor,
        name: `${player.nickname ?? '플레이어'} 노선`,
      },
    })
    const redStations = [west, north, central, univ, east]
    await tx.lineStation.createMany({
      data: redStations.map((s, i) => ({ lineId: redLine.id, stationId: s.id, order: i })),
    })
    await tx.vehicle.createMany({
      data: [
        { lineId: redLine.id, capacity: 120, status: 'OPERATING', currentStationId: central.id },
        { lineId: redLine.id, capacity: 120, status: 'SPARE', isSpare: true },
      ],
    })

    const blueLine = await tx.line.create({
      data: { cityId: city.id, color: 'BLUE', name: 'AI 파랑 노선' },
    })
    const blueStations = [north, central, park, south, outer]
    await tx.lineStation.createMany({
      data: blueStations.map((s, i) => ({ lineId: blueLine.id, stationId: s.id, order: i })),
    })
    await tx.vehicle.createMany({
      data: [
        { lineId: blueLine.id, capacity: 120, status: 'OPERATING', currentStationId: south.id },
        { lineId: blueLine.id, capacity: 120, status: 'SPARE', isSpare: true },
      ],
    })

    await tx.gameEvent.create({
      data: {
        cityId: city.id,
        type: 'CONCERT',
        startsAtTick: 18,
        durationTicks: 18,
        affectedStationId: park.id,
        demandMultiplier: 2.5,
      },
    })

    return city
  })

  return NextResponse.json({ cityId: city.id }, { status: 201, headers: corsHeaders() })
}

// GET /api/cities — 로비용 도시 목록 (노선 수 · 생성일)
// - x-player-token 있으면 해당 플레이어 도시만
// - 없으면 전체 도시 (로비 데모)
export async function GET(req: NextRequest) {
  const token = req.headers.get('x-player-token')

  let playerId: string | undefined
  if (token) {
    const player = await db.player.findUnique({ where: { token } })
    if (!player) {
      return NextResponse.json({ error: '플레이어 없음' }, { status: 404, headers: corsHeaders() })
    }
    playerId = player.id
  }

  const cities = await db.city.findMany({
    where: playerId ? { lines: { some: { playerId } } } : undefined,
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
    seasonDay: city.seasonDay,
    status: city.status,
    lineCount: city._count.lines,
    lines: city.lines.map((l) => LINE_COLOR_MAP[l.color] ?? l.color.toLowerCase()),
    createdAt: city.createdAt.toISOString(),
  }))

  return NextResponse.json({ cities: payload }, { headers: corsHeaders() })
}
