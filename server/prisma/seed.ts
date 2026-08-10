import { PrismaClient, LineColor } from '@prisma/client'
import { stationDwellMinutes } from '../src/lib/vehicle-motion'

const db = new PrismaClient()

const BUSAN_LAYOUT = {
  중앙역: { posX: 48, posY: 74 },
  북항역: { posX: 46, posY: 80 },
  서면역: { posX: 52, posY: 58 },
  광안리역: { posX: 62, posY: 62 },
  사상역: { posX: 38, posY: 52 },
  해운대역: { posX: 74, posY: 50 },
  동래역: { posX: 54, posY: 42 },
  센텀역: { posX: 66, posY: 52 },
} as const

const LINE_LAYOUT = {
  '1호선': { depotX: 55, depotY: 37, stations: ['북항역', '중앙역', '서면역', '동래역'] },
  '2호선': { depotX: 79, depotY: 48, stations: ['사상역', '서면역', '광안리역', '센텀역', '해운대역'] },
} as const

const SEOUL_LAYOUT = {
  stations: [
    { name: '서울역', type: 'HUB' as const, capacity: 240, posX: 44, posY: 36 },
    { name: '시청역', type: 'COMMERCIAL' as const, capacity: 200, posX: 43, posY: 29 },
    { name: '홍대입구역', type: 'TOURIST' as const, capacity: 180, posX: 24, posY: 38 },
    { name: '영등포역', type: 'RESIDENTIAL' as const, capacity: 180, posX: 22, posY: 60 },
    { name: '강남역', type: 'COMMERCIAL' as const, capacity: 200, posX: 60, posY: 64 },
    { name: '잠실역', type: 'TOURIST' as const, capacity: 180, posX: 78, posY: 58 },
    { name: '청량리역', type: 'INDUSTRIAL' as const, capacity: 190, posX: 66, posY: 28 },
    { name: '노원역', type: 'RESIDENTIAL' as const, capacity: 180, posX: 70, posY: 14 },
  ],
  lines: [
    {
      color: 'RED' as LineColor, name: '1호선', depotX: 71, depotY: 9,
      stations: ['노원역', '청량리역', '시청역', '서울역', '영등포역'], isPlayer: true,
    },
    {
      color: 'BLUE' as LineColor, name: '2호선', depotX: 82, depotY: 56,
      stations: ['홍대입구역', '시청역', '강남역', '잠실역'], isPlayer: false,
    },
  ],
  concertStation: '잠실역',
}

async function seedSeoul(playerId: string) {
  const existing = await db.city.findFirst({ where: { mapKey: 'SEOUL' } })
  if (existing) {
    // 차고지 좌표를 최신 레이아웃으로 동기화
    for (const lineDef of SEOUL_LAYOUT.lines) {
      await db.line.updateMany({
        where: { cityId: existing.id, name: lineDef.name },
        data: { depotX: lineDef.depotX, depotY: lineDef.depotY },
      })
    }
    await ensureBusLine(existing.id, 'SEOUL')
    console.log('시드 스킵: 서울 도시가 이미 있습니다.', existing.id)
    return
  }

  const city = await db.city.create({
    data: {
      name: '서울',
      mapKey: 'SEOUL',
      seed: 84,
      seasonDay: 1,
      status: 'ACTIVE',
      ownerPlayerId: playerId,
    },
  })
  const stations = await Promise.all(
    SEOUL_LAYOUT.stations.map(station => db.station.create({ data: { ...station, cityId: city.id } })),
  )
  const stationByName = new Map(stations.map(station => [station.name, station]))

  for (const lineDef of SEOUL_LAYOUT.lines) {
    const line = await db.line.create({
      data: {
        cityId: city.id,
        color: lineDef.color,
        name: lineDef.name,
        playerId: lineDef.isPlayer ? playerId : undefined,
        status: 'OPERATING',
        depotX: lineDef.depotX,
        depotY: lineDef.depotY,
      },
    })
    const stationIds = lineDef.stations.map(name => stationByName.get(name)!.id)
    await db.lineStation.createMany({
      data: stationIds.map((stationId, order) => ({ lineId: line.id, stationId, order })),
    })
    await db.vehicle.createMany({
      data: [
        { lineId: line.id, capacity: 120, status: 'OPERATING', currentStationId: stationIds[0], headwayMinutes: 3, segmentProgressMinutes: -stationDwellMinutes('SUBWAY') },
        { lineId: line.id, capacity: 120, status: 'SPARE', isSpare: true, headwayMinutes: 6, direction: -1 },
      ],
    })
  }

  await db.gameEvent.create({
    data: {
      cityId: city.id,
      type: 'CONCERT',
      startsAtTick: 18,
      durationTicks: 18,
      affectedStationId: stationByName.get(SEOUL_LAYOUT.concertStation)!.id,
      demandMultiplier: 2.5,
    },
  })
  await ensureBusLine(city.id, 'SEOUL')
  console.log('서울 시드 완료:', city.id)
}

// 버스 노선이 없는 도시에 버스 전용 정류장 + 버스 A를 추가한다 (모든 시드 경로에서 호출)
const BUS_LAYOUTS: Record<string, {
  stop: { name: string; posX: number; posY: number }
  route: string[]  // stop.name 포함, 순서대로
  depotX: number
  depotY: number
}> = {
  SEOUL: {
    stop: { name: '이태원정류장', posX: 48, posY: 44 },
    route: ['홍대입구역', '이태원정류장', '강남역'],
    depotX: 63, depotY: 69,
  },
  BUSAN: {
    stop: { name: '광복정류장', posX: 44, posY: 76 },
    route: ['사상역', '광복정류장', '중앙역'],
    depotX: 52, depotY: 70,
  },
}

async function ensureBusLine(cityId: string, mapKey: string) {
  const layout = BUS_LAYOUTS[mapKey]
  if (!layout) return
  const existing = await db.line.findFirst({ where: { cityId, mode: 'BUS' } })
  if (existing) {
    // 지형 개편 시 정류장·차고지 좌표를 최신 레이아웃으로 동기화
    await db.line.update({
      where: { id: existing.id },
      data: {
        depotX: layout.depotX,
        depotY: layout.depotY,
        // 예전 "A" 표기를 "A노선"으로 맞춘다
        ...(/^[A-Z]$/.test(existing.name) ? { name: `${existing.name}노선` } : {}),
      },
    })
    await db.station.updateMany({
      where: { cityId, name: layout.stop.name },
      data: { posX: layout.stop.posX, posY: layout.stop.posY },
    })
    return
  }

  let stop = await db.station.findFirst({ where: { cityId, name: layout.stop.name } })
  if (!stop) {
    stop = await db.station.create({
      data: { cityId, name: layout.stop.name, type: 'COMMERCIAL', capacity: 120, ...{ posX: layout.stop.posX, posY: layout.stop.posY } },
    })
  }

  const stations = await db.station.findMany({ where: { cityId } })
  const stationByName = new Map(stations.map(station => [station.name, station]))
  const routeIds = layout.route
    .map(name => stationByName.get(name)?.id)
    .filter((id): id is string => Boolean(id))
  if (routeIds.length < 2) return

  const line = await db.line.create({
    data: {
      cityId,
      color: 'GREEN',
      mode: 'BUS',
      name: 'A노선',
      status: 'OPERATING',
      depotX: layout.depotX,
      depotY: layout.depotY,
    },
  })
  await db.lineStation.createMany({
    data: routeIds.map((stationId, order) => ({ lineId: line.id, stationId, order })),
  })
  await db.vehicle.create({
    data: { lineId: line.id, capacity: 60, status: 'OPERATING', currentStationId: routeIds[0], headwayMinutes: 6, segmentProgressMinutes: -stationDwellMinutes('BUS') },
  })
  console.log(`버스 A노선 추가: ${mapKey}`)
}

async function main() {
  const player = await db.player.upsert({
    where: { token: '00000000-0000-4000-8000-000000000001' },
    update: { nickname: '데모' },
    create: {
      token: '00000000-0000-4000-8000-000000000001',
      nickname: '데모',
    },
  })

  await seedSeoul(player.id)

  const existing = await db.city.findFirst({
    where: { name: '부산' },
    include: { _count: { select: { stations: true, lines: true } } },
  })

  if (existing && existing._count.stations >= 8 && existing._count.lines >= 2) {
    await db.$transaction([
      db.city.update({
        where: { id: existing.id },
        // 개발 서버 재시작이 GAME OVER 상태를 임의로 되살리지 않도록 시계만 동기화한다.
        data: {
          lastTickAt: new Date(),
          roomTitle: existing.roomTitle === '운영실' ? '데모 운영실' : existing.roomTitle,
        },
      }),
      db.line.updateMany({ where: { cityId: existing.id, color: 'RED' }, data: { name: '1호선' } }),
      db.line.updateMany({ where: { cityId: existing.id, color: 'BLUE' }, data: { name: '2호선' } }),
      db.policy.updateMany({ where: { line: { cityId: existing.id } }, data: { isActive: false } }),
      db.support.updateMany({
        where: { fromLine: { cityId: existing.id }, status: 'ACTIVE' },
        data: { status: 'CANCELLED' },
      }),
      db.vehicle.updateMany({
        where: { line: { cityId: existing.id }, status: 'LOANED' },
        data: { status: 'SPARE', isSpare: true, currentStationId: null, direction: 1, segmentProgressMinutes: 0 },
      }),
    ])

    // 예전에 만들어진 방은 기본 방제목만 있으면 도시명 기준으로 구분 가능하게 채운다.
    const untitled = await db.city.findMany({
      where: { roomTitle: '운영실', NOT: { id: existing.id } },
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    })
    await Promise.all(
      untitled.map((city, index) =>
        db.city.update({
          where: { id: city.id },
          data: { roomTitle: `${city.name} 운영실 ${index + 1}` },
        }),
      ),
    )

    const existingStations = await db.station.findMany({ where: { cityId: existing.id } })
    const existingStationByName = new Map(existingStations.map(station => [station.name, station]))
    await Promise.all(Object.entries(BUSAN_LAYOUT).map(([name, position]) => {
      const station = existingStationByName.get(name)
      return station
        ? db.station.update({ where: { id: station.id }, data: position })
        : Promise.resolve(null)
    }))

    const existingLines = await db.line.findMany({
      where: { cityId: existing.id },
      include: { vehicles: { orderBy: { id: 'asc' } } },
      orderBy: { name: 'asc' },
    })
    // 지형 개편 시 차고지 좌표 동기화
    for (const line of existingLines) {
      const layout = LINE_LAYOUT[line.name as keyof typeof LINE_LAYOUT]
      if (layout && (line.depotX !== layout.depotX || line.depotY !== layout.depotY)) {
        await db.line.update({ where: { id: line.id }, data: { depotX: layout.depotX, depotY: layout.depotY } })
      }
    }
    if (existingLines.some(line => line.depotX === 0 && line.depotY === 0)) {
      for (const line of existingLines) {
        const layout = LINE_LAYOUT[line.name as keyof typeof LINE_LAYOUT]
        if (!layout) continue
        const stationIds = layout.stations
          .map(name => existingStationByName.get(name)?.id)
          .filter((stationId): stationId is string => Boolean(stationId))
        await db.$transaction([
          db.lineStation.deleteMany({ where: { lineId: line.id } }),
          db.lineStation.createMany({
            data: stationIds.map((stationId, order) => ({ lineId: line.id, stationId, order })),
          }),
          db.line.update({
            where: { id: line.id },
            data: { depotX: layout.depotX, depotY: layout.depotY },
          }),
        ])
        await Promise.all(line.vehicles.map((vehicle, index) => db.vehicle.update({
          where: { id: vehicle.id },
          data: {
            direction: index % 2 === 0 ? 1 : -1,
            headwayMinutes: 3 + (index % 3) * 3,
            ...(vehicle.status === 'OPERATING'
              ? { currentStationId: stationIds[Math.min(index, stationIds.length - 1)] }
              : {}),
          },
        })))
      }
    }
    for (const line of existingLines) {
      if (line.vehicles.length > 0) continue
      await db.vehicle.create({
        data: {
          lineId: line.id,
          capacity: 120,
          status: 'SPARE',
          isSpare: true,
          headwayMinutes: 6,
          direction: 1,
        },
      })
    }
    await ensureBusLine(existing.id, 'BUSAN')
    console.log('시드 스킵: 플레이 가능한 부산 도시가 이미 있습니다.', existing.id)
    return
  }

  const city = existing
    ? await db.city.update({
        where: { id: existing.id },
        data: { seed: 42, seasonDay: 1, status: 'ACTIVE', currentTick: 0, lastTickAt: new Date() },
      })
    : await db.city.create({
        data: {
          name: '부산',
          roomTitle: '데모 운영실',
          seed: 42,
          seasonDay: 1,
          status: 'ACTIVE',
          ownerPlayerId: player.id,
        },
      })

  // 이전 와이어프레임용 빈 시드가 남아 있으면 데모 도시만 플레이 가능 상태로 보강한다.
  if (existing) {
    await db.$transaction([
      db.passenger.deleteMany({ where: { cityId: city.id } }),
      db.simTick.deleteMany({ where: { cityId: city.id } }),
      db.gameEvent.deleteMany({ where: { cityId: city.id } }),
      db.line.deleteMany({ where: { cityId: city.id } }),
      db.station.deleteMany({ where: { cityId: city.id } }),
    ])
  }

  const stations = await Promise.all([
    { name: '중앙역', type: 'HUB' as const, capacity: 240, ...BUSAN_LAYOUT.중앙역 },
    { name: '북항역', type: 'RESIDENTIAL' as const, capacity: 180, ...BUSAN_LAYOUT.북항역 },
    { name: '서면역', type: 'COMMERCIAL' as const, capacity: 200, ...BUSAN_LAYOUT.서면역 },
    { name: '광안리역', type: 'TOURIST' as const, capacity: 170, ...BUSAN_LAYOUT.광안리역 },
    { name: '사상역', type: 'RESIDENTIAL' as const, capacity: 180, ...BUSAN_LAYOUT.사상역 },
    { name: '해운대역', type: 'TOURIST' as const, capacity: 180, ...BUSAN_LAYOUT.해운대역 },
    { name: '동래역', type: 'COMMERCIAL' as const, capacity: 190, ...BUSAN_LAYOUT.동래역 },
    { name: '센텀역', type: 'INDUSTRIAL' as const, capacity: 190, ...BUSAN_LAYOUT.센텀역 },
  ].map(station => db.station.create({ data: { ...station, cityId: city.id } })))

  const [central, north, seomyeon, gwangan, sasang, haeundae, dongnae, centum] = stations
  const lineDefs: Array<{
    color: LineColor
    name: string
    playerId?: string
    stations: typeof stations
    depotX: number
    depotY: number
  }> = [
    {
      color: 'RED', name: '1호선', playerId: player.id,
      stations: [north, central, seomyeon, dongnae],
      depotX: LINE_LAYOUT['1호선'].depotX, depotY: LINE_LAYOUT['1호선'].depotY,
    },
    {
      color: 'BLUE', name: '2호선', stations: [sasang, seomyeon, gwangan, centum, haeundae],
      depotX: LINE_LAYOUT['2호선'].depotX, depotY: LINE_LAYOUT['2호선'].depotY,
    },
  ]

  for (const lineDef of lineDefs) {
    const line = await db.line.create({
      data: {
        cityId: city.id,
        color: lineDef.color,
        name: lineDef.name,
        playerId: lineDef.playerId,
        status: 'OPERATING',
        depotX: lineDef.depotX,
        depotY: lineDef.depotY,
      },
    })
    await db.lineStation.createMany({
      data: lineDef.stations.map((station, order) => ({ lineId: line.id, stationId: station.id, order })),
    })
    await db.vehicle.createMany({
      data: [
        { lineId: line.id, capacity: 120, status: 'OPERATING', currentStationId: lineDef.stations[0].id, headwayMinutes: 3, segmentProgressMinutes: -stationDwellMinutes('SUBWAY') },
        { lineId: line.id, capacity: 120, status: 'SPARE', isSpare: true, headwayMinutes: 6, direction: -1 },
      ],
    })
  }

  await db.gameEvent.create({
    data: {
      cityId: city.id,
      type: 'CONCERT',
      startsAtTick: 18,
      durationTicks: 18,
      affectedStationId: haeundae.id,
      demandMultiplier: 2.5,
    },
  })

  await ensureBusLine(city.id, 'BUSAN')
  console.log('시드 완료:', { cityId: city.id, playerToken: player.token, stations: stations.length })
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
