import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ECONOMY, lineBuildCost, segmentBuildCost, stationInsertCost, vehiclePurchaseCost } from '@/lib/economy'
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
    type: z.literal('DEPLOY_VEHICLE'),
    lineId: z.string(),
    vehicleId: z.string().optional(),
    stationId: z.string(),
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
      throw new ConstructionFundsError('공사 후 운영자금이 대출 한도(-2,500만 원)를 넘습니다.')
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
  const body = await req.json().catch(() => null)
  const parsed = ActionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  const action = parsed.data

  if (action.type === 'RESET_CITY') {
    const city = await db.city.findUnique({ where: { id } })
    if (!city) return NextResponse.json({ error: '도시를 찾을 수 없습니다.' }, { status: 404 })
    await db.$transaction([
      db.passenger.deleteMany({ where: { cityId: id } }),
      db.city.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          lastTickAt: new Date(),
          cashBalance: ECONOMY.INITIAL_CASH,
          totalRevenue: 0,
          revenueGoal: ECONOMY.REVENUE_GOAL,
          happiness: ECONOMY.INITIAL_HAPPINESS,
          score: 0,
          insolvencyTicks: 0,
          unhappyTicks: 0,
          gameOverReason: null,
          goalReachedAtTick: null,
        },
      }),
    ])
    return NextResponse.json({ message: '같은 도시와 노선을 유지한 채 새 경영을 시작했습니다.' })
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
    return NextResponse.json({ message: `${station.name}을 건설했습니다. (800만 원)`, station })
  }

  if (action.type === 'CREATE_LINE') {
    const lines = await db.line.findMany({ where: { cityId: id } })
    let name: string
    if (action.mode === 'SUBWAY') {
      // 네이밍 규칙: 지하철은 "n호선" — 기존 최대 번호 + 1
      const maxNumber = lines.reduce((max, item) => {
        const match = item.name.match(/^(\d+)호선$/)
        return match ? Math.max(max, Number(match[1])) : max
      }, 0)
      name = `${maxNumber + 1}호선`
    } else {
      // 버스는 A, B, C…
      const used = new Set(lines.filter(item => item.mode === 'BUS').map(item => item.name))
      name = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(ch => !used.has(ch)) ?? `버스 ${lines.length + 1}`
    }
    // 색상: 도시 내 최소 사용 색 (동률이면 enum 순서 앞이 우선 → 미사용 색 먼저)
    const COLORS = ['RED', 'BLUE', 'GREEN', 'YELLOW', 'PURPLE'] as const
    const color = COLORS
      .map(candidate => ({ candidate, count: lines.filter(item => item.color === candidate).length }))
      .sort((a, b) => a.count - b.count)[0].candidate
    const cost = lineBuildCost(action.mode)
    const created = await runPaidConstruction(id, cost, async tx => {
      const nextLine = await tx.line.create({
        data: { cityId: id, mode: action.mode, name, color, depotX: 50, depotY: 50 },
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
      message: `${name} 노선을 만들었습니다. (${action.mode === 'BUS' ? '600만' : '2,000만'} 원) 역 두 개를 연달아 클릭해 선로를 부설하세요.`,
      line: created,
    })
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
    // 이 역에 있던 운행 차량은 차고지 대기로 전환 (lineStations·대기 승객은 cascade 삭제)
    await db.vehicle.updateMany({
      where: { currentStationId: station.id },
      data: { status: 'SPARE', isSpare: true, currentStationId: null, direction: 1 },
    })
    const memberships = await db.lineStation.findMany({ where: { stationId: station.id } })
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
      vehicles: true,
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

    return NextResponse.json({
      message: `${fromStation.name}–${toStation.name} 구간을 ${line.name}에 건설했습니다. (${formatWon(cost)})`,
    })
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
    await runPaidConstruction(id, cost, async tx => {
      await tx.lineStation.updateMany({
        where: { lineId: line.id, order: { gte: insertAt } },
        data: { order: { increment: 1 } },
      })
      return tx.lineStation.create({
        data: { lineId: line.id, stationId: action.stationId, order: insertAt },
      })
    })
    return NextResponse.json({ message: `${line.name}이 ${station.name}을 경유하도록 변경했습니다. (${formatWon(cost)})` })
  }

  if (action.type === 'DETACH_STATION') {
    const membership = line.lineStations.find(item => item.stationId === action.stationId)
    if (!membership) return NextResponse.json({ error: '이 노선에 속하지 않은 역입니다.' }, { status: 400 })
    await db.lineStation.delete({
      where: { lineId_stationId: { lineId: line.id, stationId: action.stationId } },
    })
    // 제거된 역에 있던 이 노선의 차량은 차고지 대기로 전환
    await db.vehicle.updateMany({
      where: { lineId: line.id, currentStationId: action.stationId },
      data: { status: 'SPARE', isSpare: true, currentStationId: null, direction: 1 },
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
    return NextResponse.json({ message: `${line.name} 노선을 삭제했습니다.` })
  }

  if (action.type === 'SET_LINE_STATUS') {
    await db.line.update({ where: { id: line.id }, data: { status: action.status } })
    return NextResponse.json({
      message: action.status === 'OPERATING'
        ? `${line.name} 운행을 재개했습니다.`
        : `${line.name} 운행을 폐쇄했습니다.`,
    })
  }

  if (action.type === 'DEPLOY_VEHICLE') {
    const stationId = action.stationId
    const stationOnLine = line.lineStations.some(item => item.stationId === stationId)
    if (!stationOnLine) return NextResponse.json({ error: '해당 노선에 연결된 역을 선택해주세요.' }, { status: 400 })
    const spare = action.vehicleId
      ? line.vehicles.find(vehicle => vehicle.id === action.vehicleId && vehicle.status === 'SPARE')
      : line.vehicles.find(vehicle => vehicle.status === 'SPARE')
    if (action.vehicleId && !spare) {
      return NextResponse.json({ error: '선택한 예비 차량을 찾을 수 없습니다.' }, { status: 404 })
    }
    const vehicle = spare
      ? await db.vehicle.update({
          where: { id: spare.id },
          data: { status: 'OPERATING', isSpare: false, currentStationId: stationId, direction: 1 },
        })
      : await runPaidConstruction(id, vehiclePurchaseCost(line.mode), tx => tx.vehicle.create({
          data: {
            lineId: line.id,
            capacity: line.mode === 'BUS' ? 60 : 120,
            status: 'OPERATING',
            currentStationId: stationId,
            direction: 1,
          },
        }))
    const station = await db.station.findUniqueOrThrow({ where: { id: stationId } })
    return NextResponse.json({ message: `${line.name} 차량을 ${station.name}에 배치했습니다.`, vehicle })
  }

  const vehicle = line.vehicles.find(item => item.id === action.vehicleId)
  if (!vehicle) return NextResponse.json({ error: '차량을 찾을 수 없습니다.' }, { status: 404 })

  if (action.type === 'SET_VEHICLE_SERVICE') {
    if (!action.inService) {
      const updatedVehicle = await db.vehicle.update({
        where: { id: vehicle.id },
        data: { status: 'SPARE', isSpare: true, currentStationId: null },
      })
      return NextResponse.json({ message: `${line.name} 차량을 차고지에 입고했습니다.`, vehicle: updatedVehicle })
    }
    if (line.lineStations.length === 0) {
      return NextResponse.json({ error: '차량을 투입할 역이 없습니다.' }, { status: 400 })
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
      data: {
        status: 'OPERATING',
        isSpare: false,
        currentStationId: depotStation.stationId,
        direction,
      },
    })
    return NextResponse.json({ message: `${line.name} 차량 운행을 시작했습니다.`, vehicle: updatedVehicle })
  }

  if (action.type === 'TRANSFER_VEHICLE') {
    if (action.targetLineId === line.id) {
      return NextResponse.json({ error: '같은 노선 차고지로는 이동할 수 없습니다.' }, { status: 400 })
    }
    const targetLine = await db.line.findFirst({ where: { id: action.targetLineId, cityId: id } })
    if (!targetLine) return NextResponse.json({ error: '이동할 차고지를 찾을 수 없습니다.' }, { status: 404 })
    const updatedVehicle = await db.vehicle.update({
      where: { id: vehicle.id },
      data: {
        lineId: targetLine.id,
        status: 'SPARE',
        isSpare: true,
        currentStationId: null,
        direction: 1,
      },
    })
    return NextResponse.json({
      message: `차량을 ${targetLine.name} 차고지로 이동했습니다.`,
      vehicle: updatedVehicle,
    })
  }

  await db.vehicle.delete({ where: { id: vehicle.id } })
  return NextResponse.json({ message: `${line.name} 차량 1대를 제거했습니다.` })
  } catch (error) {
    if (error instanceof ConstructionFundsError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    throw error
  }
}

function formatWon(value: number): string {
  return `${Math.round(value / 10_000).toLocaleString('ko-KR')}만 원`
}
