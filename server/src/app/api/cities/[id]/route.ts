import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { syncCityClock } from '@/lib/simulation'
import { authorizeCityAccess, authorizeCityOwner } from '@/lib/access'
import { buildCityStateSnapshot } from '@/lib/city-state'
import { z } from 'zod'

const UpdateCitySchema = z.object({
  roomTitle: z.string().trim().min(1, '방제목을 입력해주세요.').max(24, '방제목은 24자까지입니다.'),
})

// GET /api/cities/[id] — 도시 현재 상태 전체 조회
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const auth = await authorizeCityAccess(req, id)
  if (auth.error) return auth.error

  // 여러 화면이 동시에 열려 있어도 서버 시계 하나만 틱을 진행한다.
  // 시계 동기화 실패가 도시 조회 자체를 막지 않게 한다.
  try {
    await syncCityClock(id)
  } catch (err) {
    console.error(`[cities/${id}] syncCityClock failed`, err)
  }

  const snapshot = await buildCityStateSnapshot(id, auth.player.id)
  if (!snapshot) return NextResponse.json({ error: '도시를 찾을 수 없습니다.' }, { status: 404 })

  return NextResponse.json(snapshot)
}

// PATCH /api/cities/[id] — 방제목 변경 (관제장만)
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const auth = await authorizeCityOwner(req, id)
  if (auth.error) return auth.error

  const body = await req.json().catch(() => null)
  const parsed = UpdateCitySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? '방제목을 확인해주세요.' },
      { status: 400 },
    )
  }

  const city = await db.city.update({
    where: { id },
    data: { roomTitle: parsed.data.roomTitle },
    select: { id: true, name: true, roomTitle: true },
  })

  return NextResponse.json(city)
}
