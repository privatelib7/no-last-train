import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authorizeCityAccess } from '@/lib/access'
import { z } from 'zod'

const InviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('올바른 이메일 주소를 입력해주세요.'),
})

// GET /api/cities/[id]/invites — 이 도시에 접근 권한이 부여된 이메일 목록
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const auth = await authorizeCityAccess(req, id)
  if (auth.error) return auth.error

  const [city, invites] = await Promise.all([
    db.city.findUnique({
      where: { id },
      select: {
        ownerPlayerId: true,
        owner: { select: { email: true } },
        lines: {
          where: { playerId: { not: null } },
          take: 1,
          select: { player: { select: { email: true } } },
        },
      },
    }),
    db.cityInvite.findMany({
      where: { cityId: id },
      orderBy: { createdAt: 'asc' },
      select: { email: true, createdAt: true },
    }),
  ])

  // 관제장은 City.ownerPlayerId 우선. 예전 데이터는 소유 노선으로 폴백.
  const ownerEmail = city?.owner?.email ?? city?.lines[0]?.player?.email ?? null

  return NextResponse.json({
    ownerEmail,
    invites,
  })
}

// POST /api/cities/[id]/invites — 이메일 주소에 접근 권한 부여 (구글 독스 "공유"와 동일)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const auth = await authorizeCityAccess(req, id)
  if (auth.error) return auth.error

  const body = await req.json().catch(() => null)
  const parsed = InviteSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? '이메일을 확인해주세요.' }, { status: 400 })
  }

  const invite = await db.cityInvite.upsert({
    where: { cityId_email: { cityId: id, email: parsed.data.email } },
    update: {},
    create: { cityId: id, email: parsed.data.email },
  })

  return NextResponse.json({ email: invite.email, createdAt: invite.createdAt }, { status: 201 })
}
