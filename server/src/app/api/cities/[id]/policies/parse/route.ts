import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parsePolicy } from '@/lib/policy-parser'
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
  const body = await req.json().catch(() => null)
  const parsed = ParseSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  // 도시 컨텍스트 (역 이름, 노선 색상) 수집
  const [stations, lines] = await Promise.all([
    db.station.findMany({ where: { cityId: id }, select: { name: true } }),
    db.line.findMany({ where: { cityId: id }, select: { color: true, name: true } }),
  ])

  if (!stations.length) {
    return NextResponse.json({ error: '도시를 찾을 수 없습니다.' }, { status: 404 })
  }

  const result = await parsePolicy(parsed.data.rawInput, {
    stationNames: stations.map(s => s.name),
    lineColors: lines.map(l => l.name ?? l.color),
  })

  return NextResponse.json(result)
}
