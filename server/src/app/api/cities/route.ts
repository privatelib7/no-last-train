import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { z } from 'zod'

const CreateCitySchema = z.object({
  name: z.string().min(1).max(20),
  playerToken: z.string().uuid(),
  lineColor: z.enum(['RED', 'BLUE', 'GREEN', 'YELLOW', 'PURPLE']),
  mapKey: z.enum(['BUSAN', 'SEOUL']).default('BUSAN'),
})

type StationDef = {
  name: string
  type: 'HUB' | 'RESIDENTIAL' | 'COMMERCIAL' | 'TOURIST' | 'INDUSTRIAL'
  posX: number
  posY: number
}

// 맵별 초기 역/노선 배치 (좌표는 클라이언트 viewBox 0~100 기준)
const MAP_LAYOUTS: Record<string, {
  stations: StationDef[]
  playerLine: { stations: string[]; depotX: number; depotY: number }
  aiLine: { name: string; stations: string[]; depotX: number; depotY: number }
  concertStation: string
}> = {
  BUSAN: {
    stations: [
      { name: '중앙역', type: 'HUB', posX: 45, posY: 76 },
      { name: '북항역', type: 'RESIDENTIAL', posX: 43, posY: 82 },
      { name: '서면역', type: 'COMMERCIAL', posX: 49, posY: 57 },
      { name: '광안리역', type: 'TOURIST', posX: 69, posY: 61 },
      { name: '사상역', type: 'RESIDENTIAL', posX: 26, posY: 50 },
      { name: '해운대역', type: 'TOURIST', posX: 86, posY: 56 },
      { name: '동래역', type: 'COMMERCIAL', posX: 57, posY: 35 },
      { name: '센텀역', type: 'INDUSTRIAL', posX: 77, posY: 50 },
    ],
    playerLine: { stations: ['북항역', '중앙역', '서면역', '동래역'], depotX: 61, depotY: 23 },
    aiLine: {
      name: 'AI 2호선',
      stations: ['사상역', '서면역', '광안리역', '센텀역', '해운대역'],
      depotX: 18, depotY: 39,
    },
    concertStation: '해운대역',
  },
  SEOUL: {
    stations: [
      { name: '서울역', type: 'HUB', posX: 44, posY: 36 },
      { name: '시청역', type: 'COMMERCIAL', posX: 43, posY: 29 },
      { name: '홍대입구역', type: 'TOURIST', posX: 24, posY: 38 },
      { name: '영등포역', type: 'RESIDENTIAL', posX: 22, posY: 60 },
      { name: '강남역', type: 'COMMERCIAL', posX: 60, posY: 64 },
      { name: '잠실역', type: 'TOURIST', posX: 78, posY: 58 },
      { name: '청량리역', type: 'INDUSTRIAL', posX: 66, posY: 28 },
      { name: '노원역', type: 'RESIDENTIAL', posX: 70, posY: 14 },
    ],
    playerLine: { stations: ['노원역', '청량리역', '시청역', '서울역', '영등포역'], depotX: 74, depotY: 10 },
    aiLine: {
      name: 'AI 2호선',
      stations: ['홍대입구역', '시청역', '강남역', '잠실역'],
      depotX: 14, depotY: 34,
    },
    concertStation: '잠실역',
  },
}

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
  const layout = MAP_LAYOUTS[parsed.data.mapKey]

  const city = await db.$transaction(async (tx) => {
    const city = await tx.city.create({
      data: { name: parsed.data.name, mapKey: parsed.data.mapKey, seed },
    })

    const stations = await Promise.all(
      layout.stations.map((s) => tx.station.create({ data: { ...s, cityId: city.id } })),
    )
    const stationByName = new Map(stations.map((s) => [s.name, s]))
    const resolve = (names: string[]) => names.map((name) => stationByName.get(name)!)

    const playerStations = resolve(layout.playerLine.stations)
    const playerLine = await tx.line.create({
      data: {
        cityId: city.id,
        playerId: player.id,
        color: parsed.data.lineColor,
        name: '1호선',
        depotX: layout.playerLine.depotX,
        depotY: layout.playerLine.depotY,
      },
    })
    await tx.lineStation.createMany({
      data: playerStations.map((s, i) => ({ lineId: playerLine.id, stationId: s.id, order: i })),
    })
    await tx.vehicle.createMany({
      data: [
        { lineId: playerLine.id, capacity: 120, status: 'OPERATING', currentStationId: playerStations[0].id, headwayMinutes: 3 },
        { lineId: playerLine.id, capacity: 120, status: 'SPARE', isSpare: true, headwayMinutes: 6, direction: -1 },
      ],
    })

    const aiStations = resolve(layout.aiLine.stations)
    const aiColor = parsed.data.lineColor === 'BLUE' ? 'GREEN' : 'BLUE'
    const aiLine = await tx.line.create({
      data: {
        cityId: city.id,
        color: aiColor,
        name: layout.aiLine.name,
        depotX: layout.aiLine.depotX,
        depotY: layout.aiLine.depotY,
      },
    })
    await tx.lineStation.createMany({
      data: aiStations.map((s, i) => ({ lineId: aiLine.id, stationId: s.id, order: i })),
    })
    await tx.vehicle.createMany({
      data: [
        { lineId: aiLine.id, capacity: 120, status: 'OPERATING', currentStationId: aiStations[0].id, headwayMinutes: 3 },
        { lineId: aiLine.id, capacity: 120, status: 'SPARE', isSpare: true, headwayMinutes: 6, direction: -1 },
      ],
    })

    await tx.gameEvent.create({
      data: {
        cityId: city.id,
        type: 'CONCERT',
        startsAtTick: 18,
        durationTicks: 18,
        affectedStationId: stationByName.get(layout.concertStation)!.id,
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
    mapKey: city.mapKey,
    seasonDay: city.seasonDay,
    status: city.status,
    lineCount: city._count.lines,
    lines: city.lines.map((l) => LINE_COLOR_MAP[l.color] ?? l.color.toLowerCase()),
    createdAt: city.createdAt.toISOString(),
  }))

  return NextResponse.json({ cities: payload }, { headers: corsHeaders() })
}
