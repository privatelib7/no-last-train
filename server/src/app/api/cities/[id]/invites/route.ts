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

  const [ownerLine, invites] = await Promise.all([
    db.line.findFirst({
      where: { cityId: id, playerId: { not: null } },
      select: { player: { select: { email: true } } },
    }),
    db.cityInvite.findMany({
      where: { cityId: id },
      orderBy: { createdAt: 'asc' },
      select: { email: true, createdAt: true },
    }),
  ])

  return NextResponse.json({
    ownerEmail: ownerLine?.player?.email ?? null,
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
