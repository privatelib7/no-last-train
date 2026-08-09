import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authorizeCityAccess } from '@/lib/access'
import { ECONOMY, lineBuildCost, segmentBuildCost, stationInsertCost } from '@/lib/economy'

function formatCash(value: number) {
  return `₵${Math.round(value / 10_000).toLocaleString('ko-KR')}`
}
import { reconcileVehicleForInsertedStation, stationDwellMinutes } from '@/lib/vehicle-motion'
import { isVehicleInService, vehicleServiceUpdate } from '@/lib/vehicle-service'
import { resetCityForNewGame } from '@/lib/city-reset'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'

const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('RESET_CITY') }),
  z.object({
    type: z.literal('BUILD_STATION'),
    name: z.string().trim().min(1).max(12),
    posX: z.number().min(4).max(96),
    posY: z.number().min(4).max(92),
  }),
  z.object({
    type: z.literal('RENAME_STATION'),
    stationId: z.string(),
    name: z.string().trim().min(1).max(12),
  }),
  z.object({
    type: z.literal('MOVE_STATION'),
    stationId: z.string(),
    posX: z.number().min(4).max(96),
    posY: z.number().min(4).max(92),
  }),
  z.object({
    type: z.literal('REMOVE_STATION'),
    stationId: z.string(),
  }),
  z.object({
    type: z.literal('CREATE_LINE'),
    mode: z.enum(['SUBWAY', 'BUS']),
  }),
  z.object({
    type: z.literal('CREATE_CONNECTED_LINE'),
    mode: z.enum(['SUBWAY', 'BUS']),
    fromStationId: z.string(),
    toStationId: z.string(),
  }),
  z.object({
    type: z.literal('DETACH_STATION'),
    lineId: z.string(),
    stationId: z.string(),
  }),
  z.object({
    type: z.literal('INSERT_STATION'),
    lineId: z.string(),
    fromStationId: z.string(),
    toStationId: z.string(),
    stationId: z.string(),
  }),
  z.object({
    type: z.literal('REMOVE_LINE'),
    lineId: z.string(),
  }),
  z.object({
    type: z.literal('BUILD_SEGMENT'),
    lineId: z.string(),
    fromStationId: z.string(),
    toStationId: z.string(),
  }),
  z.object({
    type: z.literal('SET_LINE_STATUS'),
    lineId: z.string(),
    status: z.enum(['OPERATING', 'SUSPENDED']),
  }),
  z.object({
    type: z.literal('SET_VEHICLE_SERVICE'),
    lineId: z.string(),
    vehicleId: z.string(),
    inService: z.boolean(),
  }),
  z.object({
    type: z.literal('TRANSFER_VEHICLE'),
    lineId: z.string(),
    vehicleId: z.string(),
    targetLineId: z.string(),
  }),
  z.object({
    type: z.literal('REMOVE_VEHICLE'),
    lineId: z.string(),
    vehicleId: z.string(),
  }),
])

class ConstructionFundsError extends Error {}

const LINE_COLORS = ['RED', 'BLUE', 'GREEN', 'YELLOW', 'PURPLE'] as const

function nextLineIdentity(
  lines: Array<{ name: string; mode: string; color: string }>,
  mode: 'SUBWAY' | 'BUS',
) {
  let name: string
  if (mode === 'SUBWAY') {
    const maxNumber = lines.reduce((max, item) => {
      const match = item.name.match(/^(\d+)호선$/)
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    name = `${maxNumber + 1}호선`
  } else {
    const used = new Set(lines.filter(item => item.mode === 'BUS').map(item => item.name))
    name = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(ch => !used.has(ch)) ?? `버스 ${lines.length + 1}`
  }

  const color = LINE_COLORS
    .map(candidate => ({ candidate, count: lines.filter(item => item.color === candidate).length }))
    .sort((a, b) => a.count - b.count)[0].candidate
  return { name, color }
}

function depotBeyondTerminus(
  terminus: { posX: number; posY: number },
  inner: { posX: number; posY: number },
) {
  const length = Math.hypot(terminus.posX - inner.posX, terminus.posY - inner.posY) || 1
  return {
    depotX: Math.max(4, Math.min(96, terminus.posX + ((terminus.posX - inner.posX) / length) * 4.5)),
    depotY: Math.max(4, Math.min(92, terminus.posY + ((terminus.posY - inner.posY) / length) * 4.5)),
  }
}

async function runPaidConstruction<T>(
  cityId: string,
  cost: number,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async tx => {
    const charged = await tx.city.updateMany({
      where: {
        id: cityId,
        status: 'ACTIVE',
        cashBalance: { gte: cost + ECONOMY.BUILD_DEBT_LIMIT },
      },
      data: { cashBalance: { decrement: cost } },
    })
    if (charged.count === 0) {
      throw new ConstructionFundsError('공사 후 운영자금이 대출 한도(₵-2,500)를 넘습니다.')
    }
    return operation(tx)
  })
}

// 차고지를 현재 차고지와 가까운 쪽 종점의 연장선상으로 재배치한다.
// 노선 구성이 바뀌는 모든 액션(연장·역 제거·역 이동) 후에 호출할 것.
async function repositionDepot(lineId: string) {
  const line = await db.line.findUnique({ where: { id: lineId } })
  if (!line) return
  const ordered = await db.lineStation.findMany({
    where: { lineId },
    orderBy: { order: 'asc' },
    include: { station: true },
  })
  if (ordered.length < 2) return
  const first = ordered[0].station
  const last = ordered[ordered.length - 1].station
  const distFirst = Math.hypot(line.depotX - first.posX, line.depotY - first.posY)
  const distLast = Math.hypot(line.depotX - last.posX, line.depotY - last.posY)
  const [terminus, inner] = distFirst <= distLast
    ? [first, ordered[1].station]
    : [last, ordered[ordered.length - 2].station]
  const length = Math.hypot(terminus.posX - inner.posX, terminus.posY - inner.posY) || 1
  // 지형(물) 검사는 클라이언트 전용이므로 서버는 맵 범위로만 클램프한다
  const depotX = Math.max(4, Math.min(96, terminus.posX + ((terminus.posX - inner.posX) / length) * 4.5))
  const depotY = Math.max(4, Math.min(92, terminus.posY + ((terminus.posY - inner.posY) / length) * 4.5))
  await db.line.update({ where: { id: lineId }, data: { depotX, depotY } })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const auth = await authorizeCityAccess(req, id)
  if (auth.error) return auth.error

  const body = await req.json().catch(() => null)
  const parsed = ActionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  const action = parsed.data

  if (action.type === 'RESET_CITY') {
    const city = await db.city.findUnique({ where: { id } })
    if (!city) return NextResponse.json({ error: '도시를 찾을 수 없습니다.' }, { status: 404 })
    await db.$transaction(tx => resetCityForNewGame(tx, id))
    return NextResponse.json({ message: '역과 노선을 초기화하고 같은 도시에서 새 경영을 시작했습니다.' })
  }

  const city = await db.city.findUnique({ where: { id }, select: { status: true } })
  if (!city) return NextResponse.json({ error: '도시를 찾을 수 없습니다.' }, { status: 404 })
  if (city.status !== 'ACTIVE') {
    return NextResponse.json({ error: '게임이 종료되었습니다. 다시 시작한 뒤 운영해주세요.' }, { status: 409 })
  }

  try {

  if (action.type === 'BUILD_STATION') {
    const stationCount = await db.station.count({ where: { cityId: id } })
    if (stationCount >= 30) {
      return NextResponse.json({ error: '역은 최대 30개까지 건설할 수 있습니다.' }, { status: 400 })
    }
    const duplicate = await db.station.findFirst({ where: { cityId: id, name: action.name } })
    if (duplicate) return NextResponse.json({ error: '같은 이름의 역이 이미 있습니다.' }, { status: 409 })
    const station = await runPaidConstruction(id, ECONOMY.BUILD_COST.STATION, tx => tx.station.create({
      data: {
        cityId: id,
        name: action.name,
        type: 'RESIDENTIAL',
        capacity: 180,
        posX: action.posX,
        posY: action.posY,
      },
    }))
    const message = `${station.name}을 건설했습니다. (₵800)`
    await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
    return NextResponse.json({ message, station })
  }

  if (action.type === 'CREATE_LINE') {
    const lines = await db.line.findMany({ where: { cityId: id } })
    const { name, color } = nextLineIdentity(lines, action.mode)
    const cost = lineBuildCost(action.mode)
    const created = await runPaidConstruction(id, cost, async tx => {
      const nextLine = await tx.line.create({
        data: {
          cityId: id,
          playerId: auth.player.id,
          mode: action.mode,
          name,
          color,
          depotX: 50,
          depotY: 50,
        },
      })
      await tx.vehicle.create({
        data: {
          lineId: nextLine.id,
          capacity: action.mode === 'BUS' ? 60 : 120,
          status: 'SPARE',
          isSpare: true,
          headwayMinutes: 6,
        },
      })
      return nextLine
    })
    return NextResponse.json({
      message: `${name} 노선을 만들었습니다. (${action.mode === 'BUS' ? '₵600' : '₵2,000'}) 역 두 개를 연달아 클릭해 선로를 부설하세요.`,
      line: created,
    })
  }

  if (action.type === 'CREATE_CONNECTED_LINE') {
    if (action.fromStationId === action.toStationId) {
      return NextResponse.json({ error: '서로 다른 두 역을 선택해주세요.' }, { status: 400 })
    }
    const stations = await db.station.findMany({
      where: { cityId: id, id: { in: [action.fromStationId, action.toStationId] } },
    })
    const fromStation = stations.find(station => station.id === action.fromStationId)
    const toStation = stations.find(station => station.id === action.toStationId)
    if (!fromStation || !toStation) {
      return NextResponse.json({ error: '선택한 역을 찾을 수 없습니다.' }, { status: 404 })
    }

    const lines = await db.line.findMany({ where: { cityId: id } })
    const { name, color } = nextLineIdentity(lines, action.mode)
    const distance = Math.hypot(fromStation.posX - toStation.posX, fromStation.posY - toStation.posY)
    const cost = lineBuildCost(action.mode) + segmentBuildCost(action.mode, distance)
    const depot = depotBeyondTerminus(fromStation, toStation)
    const created = await runPaidConstruction(id, cost, async tx => {
      const nextLine = await tx.line.create({
        data: {
          cityId: id,
          playerId: auth.player.id,
          mode: action.mode,
          name,
          color,
          ...depot,
        },
      })
      await tx.lineStation.createMany({
        data: [
          { lineId: nextLine.id, stationId: fromStation.id, order: 0 },
          { lineId: nextLine.id, stationId: toStation.id, order: 1 },
        ],
      })
      await tx.vehicle.create({
        data: {
          lineId: nextLine.id,
          capacity: action.mode === 'BUS' ? 60 : 120,
          status: 'SPARE',
          isSpare: true,
          headwayMinutes: 6,
        },
      })
      return nextLine
    })

    const message = `${fromStation.name}–${toStation.name} 사이에 ${name}을 건설했습니다. (${formatWon(cost)})`
    await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
    return NextResponse.json({ message, line: created })
  }

  if (action.type === 'MOVE_STATION') {
    const station = await db.station.findFirst({ where: { id: action.stationId, cityId: id } })
    if (!station) return NextResponse.json({ error: '역을 찾을 수 없습니다.' }, { status: 404 })
    const updated = await db.station.update({
      where: { id: station.id },
      data: { posX: action.posX, posY: action.posY },
    })
    // 이 역이 종점인 노선의 차고지가 따라오도록 소속 노선 전부 재배치
    const memberships = await db.lineStation.findMany({ where: { stationId: station.id } })
    for (const membership of memberships) {
      await repositionDepot(membership.lineId)
    }
    return NextResponse.json({ message: `${station.name}을 이동했습니다.`, station: updated })
  }

  if (action.type === 'REMOVE_STATION') {
    const station = await db.station.findFirst({ where: { id: action.stationId, cityId: id } })
    if (!station) return NextResponse.json({ error: '역을 찾을 수 없습니다.' }, { status: 404 })
    const memberships = await db.lineStation.findMany({
      where: { stationId: station.id },
      include: {
        line: {
          include: {
            lineStations: {
              where: { stationId: { not: station.id } },
              orderBy: { order: 'asc' },
            },
          },
        },
      },
    })
    for (const membership of memberships) {
      const fallbackStation = membership.line.lineStations[0]
      const operatingHere = await db.vehicle.count({
        where: { lineId: membership.lineId, currentStationId: station.id, status: 'OPERATING', isSpare: false },
      })
      if (!fallbackStation && operatingHere > 0) {
        return NextResponse.json(
          { error: `${membership.line.name} 운행 차량을 먼저 입고한 뒤 마지막 역을 삭제해주세요.` },
          { status: 409 },
        )
      }
      if (fallbackStation) {
        await db.vehicle.updateMany({
          where: { lineId: membership.lineId, currentStationId: station.id },
          data: {
            currentStationId: fallbackStation.stationId,
            direction: 1,
            segmentProgressMinutes: -stationDwellMinutes(membership.line.mode),
          },
        })
      }
    }
    await db.station.delete({ where: { id: station.id } })
    // 종점이 사라진 노선의 차고지를 새 종점으로 이동
    for (const membership of memberships) {
      await repositionDepot(membership.lineId)
    }
    return NextResponse.json({ message: `${station.name}을 삭제했습니다.` })
  }

  if (action.type === 'RENAME_STATION') {
    const station = await db.station.findFirst({ where: { id: action.stationId, cityId: id } })
    if (!station) return NextResponse.json({ error: '역을 찾을 수 없습니다.' }, { status: 404 })
    const duplicate = await db.station.findFirst({
      where: { cityId: id, name: action.name, id: { not: station.id } },
    })
    if (duplicate) return NextResponse.json({ error: '같은 이름의 역이 이미 있습니다.' }, { status: 409 })
    const updated = await db.station.update({ where: { id: station.id }, data: { name: action.name } })
    return NextResponse.json({ message: `${station.name}을 ${updated.name}(으)로 변경했습니다.`, station: updated })
  }

  const line = await db.line.findFirst({
    where: { id: action.lineId, cityId: id },
    include: {
      lineStations: { include: { station: true }, orderBy: { order: 'asc' } },
      vehicles: { orderBy: { id: 'asc' } },
    },
  })
  if (!line) return NextResponse.json({ error: '노선을 찾을 수 없습니다.' }, { status: 404 })

  if (action.type === 'BUILD_SEGMENT') {
    if (action.fromStationId === action.toStationId) {
      return NextResponse.json({ error: '서로 다른 두 역을 선택해주세요.' }, { status: 400 })
    }
    const stations = await db.station.findMany({
      where: { cityId: id, id: { in: [action.fromStationId, action.toStationId] } },
    })
    if (stations.length !== 2) return NextResponse.json({ error: '선택한 역을 찾을 수 없습니다.' }, { status: 404 })

    const fromMembership = line.lineStations.find(item => item.stationId === action.fromStationId)
    const toMembership = line.lineStations.find(item => item.stationId === action.toStationId)
    if (fromMembership && toMembership) {
      const adjacent = Math.abs(fromMembership.order - toMembership.order) === 1
      return NextResponse.json(
        { error: adjacent ? '두 역은 이미 연결되어 있습니다.' : '기존 노선의 중간 구간은 다시 연결할 수 없습니다.' },
        { status: 409 },
      )
    }

    // 노선 중간 삽입은 폴리라인이 의도치 않게 우회하므로 종점 연장만 허용한다
    const memberships = line.lineStations
    const onLine = fromMembership ?? toMembership
    const newStationId = fromMembership ? action.toStationId : action.fromStationId
    const [fromStation, toStation] = [action.fromStationId, action.toStationId]
      .map(stationId => stations.find(station => station.id === stationId)!)
    const distance = Math.hypot(fromStation.posX - toStation.posX, fromStation.posY - toStation.posY)
    const cost = segmentBuildCost(line.mode, distance)
    if (memberships.length > 0) {
      if (!onLine) {
        return NextResponse.json(
          { error: `${line.name}의 종점과 이어주세요. 노선에 없는 두 역끼리는 연결할 수 없습니다.` },
          { status: 400 },
        )
      }
      const isFirst = onLine.stationId === memberships[0].stationId
      const isLast = onLine.stationId === memberships[memberships.length - 1].stationId
      if (!isFirst && !isLast) {
        return NextResponse.json(
          { error: '노선 중간에는 연결할 수 없습니다. 종점에서만 연장할 수 있습니다.' },
          { status: 400 },
        )
      }
      if (isLast) {
        await runPaidConstruction(id, cost, tx => tx.lineStation.create({
          data: { lineId: line.id, stationId: newStationId, order: memberships[memberships.length - 1].order + 1 },
        }))
      } else {
        await runPaidConstruction(id, cost, async tx => {
          await tx.lineStation.updateMany({
            where: { lineId: line.id },
            data: { order: { increment: 1 } },
          })
          return tx.lineStation.create({
            data: { lineId: line.id, stationId: newStationId, order: memberships[0].order },
          })
        })
      }
    } else {
      await runPaidConstruction(id, cost, tx => tx.lineStation.createMany({
        data: [
          { lineId: line.id, stationId: action.fromStationId, order: 0 },
          { lineId: line.id, stationId: action.toStationId, order: 1 },
        ],
      }))
    }

    // 차고지는 노선 종점을 따라간다
    await repositionDepot(line.id)

    const message = `${fromStation.name}–${toStation.name} 구간을 ${line.name}에 건설했습니다. (${formatWon(cost)})`
    await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
    return NextResponse.json({ message })
  }

  if (action.type === 'INSERT_STATION') {
    // order 값에는 역 제거로 구멍이 있을 수 있으므로 정렬 순서(랭크) 기준으로 이웃 판정
    const fromIndex = line.lineStations.findIndex(item => item.stationId === action.fromStationId)
    const toIndex = line.lineStations.findIndex(item => item.stationId === action.toStationId)
    if (fromIndex < 0 || toIndex < 0 || Math.abs(fromIndex - toIndex) !== 1) {
      return NextResponse.json({ error: '이웃한 구간이 아닙니다.' }, { status: 400 })
    }
    const fromMembership = line.lineStations[fromIndex]
    const toMembership = line.lineStations[toIndex]
    if (line.lineStations.some(item => item.stationId === action.stationId)) {
      return NextResponse.json({ error: '이미 이 노선에 있는 역입니다.' }, { status: 409 })
    }
    const station = await db.station.findFirst({ where: { id: action.stationId, cityId: id } })
    if (!station) return NextResponse.json({ error: '역을 찾을 수 없습니다.' }, { status: 404 })
    const insertAt = Math.min(fromMembership.order, toMembership.order) + 1
    const cost = stationInsertCost(line.mode)

    // 삽입되는 구간을 지금 지나는 중인 차량은 새 역 기준으로 진행 상태를 다시 맞춰준다.
    // 그대로 두면 예전 구간 길이 기준 진행 시간이 훨씬 짧아진 새 구간에 그대로 클램프되어
    // 순간이동한 것처럼 새 역까지 튕겨 나간다.
    const orderedStations = line.lineStations.map(item => item.station)
    const vehicleFixes = line.vehicles.flatMap(vehicle => {
      const fix = reconcileVehicleForInsertedStation(
        orderedStations,
        {
          currentStationId: vehicle.currentStationId,
          direction: vehicle.direction,
          segmentProgressMinutes: vehicle.segmentProgressMinutes,
        },
        [fromMembership.stationId, toMembership.stationId],
        station,
        line.mode,
      )
      return fix ? [{ vehicleId: vehicle.id, ...fix }] : []
    })

    await runPaidConstruction(id, cost, async tx => {
      await tx.lineStation.updateMany({
        where: { lineId: line.id, order: { gte: insertAt } },
        data: { order: { increment: 1 } },
      })
      const created = await tx.lineStation.create({
        data: { lineId: line.id, stationId: action.stationId, order: insertAt },
      })
      for (const fix of vehicleFixes) {
        await tx.vehicle.update({
          where: { id: fix.vehicleId },
          data: { currentStationId: fix.currentStationId, segmentProgressMinutes: fix.segmentProgressMinutes },
        })
      }
      return created
    })
    return NextResponse.json({ message: `${line.name}이 ${station.name}을 경유하도록 변경했습니다. (${formatWon(cost)})` })
  }

  if (action.type === 'DETACH_STATION') {
    const membership = line.lineStations.find(item => item.stationId === action.stationId)
    if (!membership) return NextResponse.json({ error: '이 노선에 속하지 않은 역입니다.' }, { status: 400 })
    const fallbackStation = line.lineStations.find(item => item.stationId !== action.stationId)
    if (!fallbackStation && line.vehicles.some(vehicle => (
      vehicle.currentStationId === action.stationId && isVehicleInService(vehicle)
    ))) {
      return NextResponse.json(
        { error: `${line.name} 운행 차량을 먼저 입고한 뒤 마지막 역을 제거해주세요.` },
        { status: 409 },
      )
    }
    if (fallbackStation) {
      await db.vehicle.updateMany({
        where: { lineId: line.id, currentStationId: action.stationId },
        data: {
          currentStationId: fallbackStation.stationId,
          direction: 1,
          segmentProgressMinutes: -stationDwellMinutes(line.mode),
        },
      })
    }
    await db.lineStation.delete({
      where: { lineId_stationId: { lineId: line.id, stationId: action.stationId } },
    })
    await repositionDepot(line.id)
    return NextResponse.json({ message: `${membership.station.name}을 ${line.name}에서 제거했습니다.` })
  }

  if (action.type === 'REMOVE_LINE') {
    // Support는 onDelete 제약이 없어 노선·차량 삭제를 막으므로 먼저 정리한다
    await db.support.deleteMany({
      where: { OR: [{ fromLineId: line.id }, { toLineId: line.id }] },
    })
    await db.line.delete({ where: { id: line.id } })
    // 관제장은 City.ownerPlayerId에 묶여 있어 노선 삭제와 무관하다.
    await db.activityLog.create({
      data: { cityId: id, playerId: auth.player.id, message: `${line.name} 노선을 삭제했습니다.` },
    })
    return NextResponse.json({ message: `${line.name} 노선을 삭제했습니다.` })
  }

  if (action.type === 'SET_LINE_STATUS') {
    await db.line.update({ where: { id: line.id }, data: { status: action.status } })
    const message = action.status === 'OPERATING'
      ? `${line.name} 운행을 재개했습니다.`
      : `${line.name} 운행을 폐쇄했습니다.`
    await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
    return NextResponse.json({ message })
  }

  const vehicle = line.vehicles.find(item => item.id === action.vehicleId)
  if (!vehicle) return NextResponse.json({ error: '차량을 찾을 수 없습니다.' }, { status: 404 })

  if (action.type === 'SET_VEHICLE_SERVICE') {
    if (!action.inService) {
      if (vehicle.status === 'SPARE' && vehicle.isSpare) {
        return NextResponse.json({ message: `${line.name} 차량은 이미 차고지에서 대기 중입니다.`, vehicle })
      }
      if (!isVehicleInService(vehicle)) {
        return NextResponse.json({ error: '운행 중인 차량만 입고할 수 있습니다.' }, { status: 409 })
      }
      const updatedVehicle = await db.vehicle.update({
        where: { id: vehicle.id },
        data: vehicleServiceUpdate(false),
      })
      const message = `${line.name} 차량을 차고지에 입고했습니다.`
      await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
      return NextResponse.json({ message, vehicle: updatedVehicle })
    }
    if (line.lineStations.length === 0) {
      return NextResponse.json({ error: '차량을 투입할 역이 없습니다.' }, { status: 400 })
    }
    if (isVehicleInService(vehicle)) {
      return NextResponse.json({ message: `${line.name} 차량은 이미 운행 중입니다.`, vehicle })
    }
    if (!vehicle.isSpare) {
      return NextResponse.json({ error: '차고지에서 대기 중인 차량만 운행할 수 있습니다.' }, { status: 409 })
    }
    const depotStation = line.lineStations.reduce((nearest, item) => {
      const distance = Math.hypot(item.station.posX - line.depotX, item.station.posY - line.depotY)
      const nearestDistance = Math.hypot(nearest.station.posX - line.depotX, nearest.station.posY - line.depotY)
      return distance < nearestDistance ? item : nearest
    })
    const stationIndex = line.lineStations.findIndex(item => item.stationId === depotStation.stationId)
    const direction = stationIndex >= line.lineStations.length - 1 ? -1 : 1
    const updatedVehicle = await db.vehicle.update({
      where: { id: vehicle.id },
      data: vehicleServiceUpdate(true, {
        stationId: depotStation.stationId,
        direction,
        dwellMinutes: stationDwellMinutes(line.mode),
      }),
    })
    const message = `${line.name} 차량 운행을 시작했습니다.`
    await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
    return NextResponse.json({ message, vehicle: updatedVehicle })
  }

  if (action.type === 'TRANSFER_VEHICLE') {
    if (vehicle.status !== 'SPARE' || !vehicle.isSpare) {
      return NextResponse.json({ error: '운행 차량은 먼저 입고한 뒤 다른 차고지로 이동해주세요.' }, { status: 409 })
    }
    if (action.targetLineId === line.id) {
      return NextResponse.json({ error: '같은 노선 차고지로는 이동할 수 없습니다.' }, { status: 400 })
    }
    const targetLine = await db.line.findFirst({ where: { id: action.targetLineId, cityId: id } })
    if (!targetLine) return NextResponse.json({ error: '이동할 차고지를 찾을 수 없습니다.' }, { status: 404 })
    const updatedVehicle = await db.vehicle.update({
      where: { id: vehicle.id },
      data: { lineId: targetLine.id },
    })
    const message = `차량을 ${targetLine.name} 차고지로 이동했습니다.`
    await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
    return NextResponse.json({ message, vehicle: updatedVehicle })
  }

  await db.vehicle.delete({ where: { id: vehicle.id } })
  const message = `${line.name} 차량 1대를 제거했습니다.`
  await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
  return NextResponse.json({ message })
  } catch (error) {
    if (error instanceof ConstructionFundsError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    throw error
  }
}

// 게임 화폐 ₵ 표기 (₵1 = 1만 원) — 클라이언트 formatMoney와 동일 기준
function formatWon(value: number): string {
  return `₵${Math.round(value / 10_000).toLocaleString('ko-KR')}`
}
