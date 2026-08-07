import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authorizeCityAccess } from '@/lib/access'
import { z } from 'zod'

const CreatePolicySchema = z.object({
  lineId: z.string(),
  type: z.enum(['CONGESTION_RESPONSE', 'PASSENGER_PRIORITY', 'SUPPORT_CONDITION']),
  conditionStationId: z.string().optional(),
  conditionThreshold: z.number().min(0).max(100).optional(),
  conditionTimeStart: z.number().min(0).max(23).optional(),
  conditionTimeEnd: z.number().min(0).max(23).optional(),
  actionType: z.enum(['DEPLOY_SPARE', 'ADJUST_HEADWAY', 'LEND_VEHICLE']),
  actionTargetLineId: z.string().optional(),
  resourceLimit: z.number().int().min(1).max(3).default(1),
  rawInput: z.string().optional(),
  parsedSummary: z.string().optional(),
})

// GET /api/cities/[id]/policies — 도시 내 모든 활성 정책 조회
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const auth = await authorizeCityAccess(req, id)
  if (auth.error) return auth.error

  const policies = await db.policy.findMany({
    where: { line: { cityId: id }, isActive: true },
    include: { line: { select: { color: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json({ policies })
}

// POST /api/cities/[id]/policies — 정책 추가
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const auth = await authorizeCityAccess(req, id)
  if (auth.error) return auth.error

  const body = await req.json().catch(() => null)
  const parsed = CreatePolicySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const line = await db.line.findFirst({ where: { id: parsed.data.lineId, cityId: id } })
  if (!line) return NextResponse.json({ error: '노선을 찾을 수 없습니다.' }, { status: 404 })

  // 같은 타입의 기존 정책 비활성화 (1노선 1정책 유형)
  await db.policy.updateMany({
    where: { lineId: parsed.data.lineId, type: parsed.data.type, isActive: true },
    data: { isActive: false },
  })

  const policy = await db.policy.create({ data: { ...parsed.data } })
  return NextResponse.json({ policy }, { status: 201 })
}
