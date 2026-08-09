import { NextRequest, NextResponse } from 'next/server'
import { authorizeCityOwner } from '@/lib/access'
import { parseCityCommand } from '@/lib/city-command-parser'
import { db } from '@/lib/db'
import { z } from 'zod'

const ParseCommandSchema = z.object({
  rawInput: z.string().trim().min(2).max(300),
})

// POST /api/cities/[id]/commands/parse — 자연어 도시 운영 명령을 안전한 액션으로 변환
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const auth = await authorizeCityOwner(req, id)
  if (auth.error) return auth.error

  const body = await req.json().catch(() => null)
  const parsed = ParseCommandSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: '도시 운영 명령은 2자 이상 300자 이하로 입력해주세요.' }, { status: 400 })
  }

  const [stations, lines] = await Promise.all([
    db.station.findMany({
      where: { cityId: id },
      select: { id: true, name: true, posX: true, posY: true },
    }),
    db.line.findMany({
      where: { cityId: id },
      select: {
        id: true,
        name: true,
        mode: true,
        status: true,
        lineStations: {
          orderBy: { order: 'asc' },
          select: {
            station: { select: { id: true, name: true, posX: true, posY: true } },
          },
        },
        vehicles: {
          orderBy: { id: 'asc' },
          select: { id: true, status: true, isSpare: true },
        },
      },
    }),
  ])

  const result = await parseCityCommand(parsed.data.rawInput, {
    stations,
    lines: lines.map(line => ({
      id: line.id,
      name: line.name,
      mode: line.mode,
      status: line.status,
      stations: line.lineStations.map(item => item.station),
      vehicles: line.vehicles,
    })),
  })

  return NextResponse.json(result)
}
