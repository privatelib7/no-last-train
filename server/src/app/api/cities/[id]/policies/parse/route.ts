import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parsePolicy } from '@/lib/policy-parser'
import { authorizeCityAccess } from '@/lib/access'
import { z } from 'zod'

const ParseSchema = z.object({
  rawInput: z.string().min(1).max(200),
})

// POST /api/cities/[id]/policies/parse — 자연어 → 정책 구조화
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const auth = await authorizeCityAccess(req, id)
  if (auth.error) return auth.error

  const body = await req.json().catch(() => null)
  const parsed = ParseSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  // 도시 컨텍스트 (역 이름, 노선 색상) 수집
  const [stations, lines] = await Promise.all([
    db.station.findMany({ where: { cityId: id }, select: { id: true, name: true, type: true } }),
    db.line.findMany({ where: { cityId: id }, select: { id: true, color: true, name: true } }),
  ])

  if (!stations.length) {
    return NextResponse.json({ error: '도시를 찾을 수 없습니다.' }, { status: 404 })
  }

  const result = await parsePolicy(parsed.data.rawInput, {
    stationNames: stations.map(s => s.name),
    lineColors: lines.map(l => l.name ?? l.color),
  })

  if (!result.ok) return NextResponse.json(result)

  const policy = { ...result.policy }
  if (policy.type === 'CONGESTION_RESPONSE') {
    const namedStation = stations.find(station => parsed.data.rawInput.includes(station.name))
    const returnedStation = stations.find(station => station.id === policy.conditionStationId || station.name === policy.conditionStationId)
    policy.conditionStationId = returnedStation?.id
      ?? namedStation?.id
      ?? stations.find(station => station.type === 'HUB')?.id
      ?? stations[0].id
  }
  if (policy.actionType === 'LEND_VEHICLE') {
    policy.actionTargetLineId = lines.find(line => line.color === 'BLUE')?.id
      ?? lines.find(line => line.id !== policy.actionTargetLineId)?.id
  }

  return NextResponse.json({ ok: true, policy })
}
