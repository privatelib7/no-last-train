import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { CITY_NAMES, isCityName, pickRandomRoomTitle } from '@/lib/city-names'
import { stationDwellMinutes } from '@/lib/vehicle-motion'
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

type StationDef = {
  name: string
  type: 'HUB' | 'RESIDENTIAL' | 'COMMERCIAL' | 'TOURIST' | 'INDUSTRIAL'
  posX: number
  posY: number
}

// 맵별 초기 역/노선 배치 (좌표는 클라이언트 viewBox 0~100 기준)
const MAP_LAYOUTS: Record<'BUSAN' | 'SEOUL', {
  stations: StationDef[]
  playerLine: { stations: string[]; depotX: number; depotY: number }
  aiLine: { name: string; stations: string[]; depotX: number; depotY: number }
  busLine: { stations: string[]; depotX: number; depotY: number }
  concertStation: string
}> = {
  BUSAN: {
    stations: [
      { name: '중앙역', type: 'HUB', posX: 48, posY: 74 },
      { name: '북항역', type: 'RESIDENTIAL', posX: 46, posY: 80 },
      { name: '서면역', type: 'COMMERCIAL', posX: 52, posY: 58 },
      { name: '광안리역', type: 'TOURIST', posX: 62, posY: 62 },
      { name: '사상역', type: 'RESIDENTIAL', posX: 38, posY: 52 },
      { name: '해운대역', type: 'TOURIST', posX: 74, posY: 50 },
      { name: '동래역', type: 'COMMERCIAL', posX: 54, posY: 42 },
      { name: '센텀역', type: 'INDUSTRIAL', posX: 66, posY: 52 },
      { name: '광복정류장', type: 'COMMERCIAL', posX: 44, posY: 76 },
    ],
    playerLine: { stations: ['북항역', '중앙역', '서면역', '동래역'], depotX: 55, depotY: 37 },
    aiLine: {
      name: '2호선',
      stations: ['사상역', '서면역', '광안리역', '센텀역', '해운대역'],
      depotX: 79, depotY: 48,
    },
    busLine: { stations: ['사상역', '광복정류장', '중앙역'], depotX: 52, depotY: 70 },
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
      { name: '이태원정류장', type: 'COMMERCIAL', posX: 48, posY: 44 },
    ],
    playerLine: { stations: ['노원역', '청량리역', '시청역', '서울역', '영등포역'], depotX: 71, depotY: 9 },
    aiLine: {
      name: '2호선',
      stations: ['홍대입구역', '시청역', '강남역', '잠실역'],
      depotX: 82, depotY: 56,
    },
    busLine: { stations: ['홍대입구역', '이태원정류장', '강남역'], depotX: 63, depotY: 69 },
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
  // 도시 이름이 곧 맵 선택 — 클라이언트는 mapKey를 따로 보내지 않는다
  const mapKey = cityName === '서울' ? 'SEOUL' : 'BUSAN'
  const layout = MAP_LAYOUTS[mapKey]

  const city = await db.$transaction(async (tx) => {
    const city = await tx.city.create({
      data: {
        name: cityName,
        roomTitle,
        mapKey,
        seed,
        ownerPlayerId: player.id,
      },
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
        { lineId: playerLine.id, capacity: 120, status: 'OPERATING', currentStationId: playerStations[0].id, headwayMinutes: 3, segmentProgressMinutes: -stationDwellMinutes('SUBWAY') },
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
        { lineId: aiLine.id, capacity: 120, status: 'OPERATING', currentStationId: aiStations[0].id, headwayMinutes: 3, segmentProgressMinutes: -stationDwellMinutes('SUBWAY') },
        { lineId: aiLine.id, capacity: 120, status: 'SPARE', isSpare: true, headwayMinutes: 6, direction: -1 },
      ],
    })

    const busStations = resolve(layout.busLine.stations)
    // 플레이어·AI 노선과 겹치지 않는 색을 고른다
    const usedColors = [parsed.data.lineColor, aiColor]
    const busColor = (['GREEN', 'YELLOW', 'PURPLE', 'RED', 'BLUE'] as const)
      .find(candidate => !usedColors.includes(candidate)) ?? 'GREEN'
    const busLine = await tx.line.create({
      data: {
        cityId: city.id,
        color: busColor,
        mode: 'BUS',
        name: 'A',
        depotX: layout.busLine.depotX,
        depotY: layout.busLine.depotY,
      },
    })
    await tx.lineStation.createMany({
      data: busStations.map((s, i) => ({ lineId: busLine.id, stationId: s.id, order: i })),
    })
    await tx.vehicle.create({
      data: { lineId: busLine.id, capacity: 60, status: 'OPERATING', currentStationId: busStations[0].id, headwayMinutes: 6, segmentProgressMinutes: -stationDwellMinutes('BUS') },
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

  let player: { id: string; email: string | null } | null = null
  if (token) {
    player = await db.player.findUnique({ where: { token }, select: { id: true, email: true } })
    if (!player) {
      return NextResponse.json({ error: '플레이어 없음' }, { status: 404, headers: corsHeaders() })
    }
  }

  // 로그인 상태면 관제장 도시 + 소유 노선 도시 + 초대받은 도시만 보여준다.
  const cities = await db.city.findMany({
    where: player
      ? {
          OR: [
            { ownerPlayerId: player.id },
            { lines: { some: { playerId: player.id } } },
            ...(player.email ? [{ invites: { some: { email: player.email } } }] : []),
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
