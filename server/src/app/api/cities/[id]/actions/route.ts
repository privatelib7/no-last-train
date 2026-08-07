import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authorizeCityAccess } from '@/lib/access'
import { z } from 'zod'

const ActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('BUILD_STATION'),
    name: z.string().trim().min(1).max(12),
    posX: z.number().min(4).max(96),
    posY: z.number().min(4).max(92),
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

  if (action.type === 'BUILD_STATION') {
    const stationCount = await db.station.count({ where: { cityId: id } })
    if (stationCount >= 30) {
      return NextResponse.json({ error: '역은 최대 30개까지 건설할 수 있습니다.' }, { status: 400 })
    }
    const duplicate = await db.station.findFirst({ where: { cityId: id, name: action.name } })
    if (duplicate) return NextResponse.json({ error: '같은 이름의 역이 이미 있습니다.' }, { status: 409 })
    const station = await db.station.create({
      data: {
        cityId: id,
        name: action.name,
        type: 'RESIDENTIAL',
        capacity: 180,
        posX: action.posX,
        posY: action.posY,
      },
    })
    const message = `${station.name}을 건설했습니다.`
    await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
    return NextResponse.json({ message, station })
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

    await db.$transaction(async tx => {
      if (fromMembership) {
        await tx.lineStation.updateMany({
          where: { lineId: line.id, order: { gt: fromMembership.order } },
          data: { order: { increment: 1 } },
        })
        await tx.lineStation.create({
          data: { lineId: line.id, stationId: action.toStationId, order: fromMembership.order + 1 },
        })
        return
      }
      if (toMembership) {
        await tx.lineStation.updateMany({
          where: { lineId: line.id, order: { gte: toMembership.order } },
          data: { order: { increment: 1 } },
        })
        await tx.lineStation.create({
          data: { lineId: line.id, stationId: action.fromStationId, order: toMembership.order },
        })
        return
      }
      const lastOrder = line.lineStations[line.lineStations.length - 1]?.order ?? -1
      await tx.lineStation.createMany({
        data: [
          { lineId: line.id, stationId: action.fromStationId, order: lastOrder + 1 },
          { lineId: line.id, stationId: action.toStationId, order: lastOrder + 2 },
        ],
      })
    })

    const [fromStation, toStation] = [action.fromStationId, action.toStationId]
      .map(stationId => stations.find(station => station.id === stationId)!)
    const message = `${fromStation.name}–${toStation.name} 구간을 ${line.name}에 건설했습니다.`
    await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
    return NextResponse.json({ message })
  }

  if (action.type === 'SET_LINE_STATUS') {
    await db.line.update({ where: { id: line.id }, data: { status: action.status } })
    const message = action.status === 'OPERATING'
      ? `${line.name} 운행을 재개했습니다.`
      : `${line.name} 운행을 폐쇄했습니다.`
    await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
    return NextResponse.json({ message })
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
      : await db.vehicle.create({
          data: {
            lineId: line.id,
            capacity: 120,
            status: 'OPERATING',
            currentStationId: stationId,
            direction: 1,
          },
        })
    const station = await db.station.findUniqueOrThrow({ where: { id: stationId } })
    const message = `${line.name} 차량을 ${station.name}에 배치했습니다.`
    await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
    return NextResponse.json({ message, vehicle })
  }

  const vehicle = line.vehicles.find(item => item.id === action.vehicleId)
  if (!vehicle) return NextResponse.json({ error: '차량을 찾을 수 없습니다.' }, { status: 404 })

  if (action.type === 'SET_VEHICLE_SERVICE') {
    if (!action.inService) {
      const updatedVehicle = await db.vehicle.update({
        where: { id: vehicle.id },
        data: { status: 'SPARE', isSpare: true, currentStationId: null },
      })
      const message = `${line.name} 차량을 차고지에 입고했습니다.`
      await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
      return NextResponse.json({ message, vehicle: updatedVehicle })
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
    const message = `${line.name} 차량 운행을 시작했습니다.`
    await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
    return NextResponse.json({ message, vehicle: updatedVehicle })
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
    const message = `차량을 ${targetLine.name} 차고지로 이동했습니다.`
    await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
    return NextResponse.json({ message, vehicle: updatedVehicle })
  }

  await db.vehicle.delete({ where: { id: vehicle.id } })
  const message = `${line.name} 차량 1대를 제거했습니다.`
  await db.activityLog.create({ data: { cityId: id, playerId: auth.player.id, message } })
  return NextResponse.json({ message })
}
