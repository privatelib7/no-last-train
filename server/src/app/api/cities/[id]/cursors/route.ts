import { NextRequest, NextResponse } from 'next/server'
import { authorizeCityAccess } from '@/lib/access'
import { listOtherCursors, removeCursor, upsertCursor } from '@/lib/cursor-presence'
import { z } from 'zod'

const CursorSchema = z.object({
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
})

// GET /api/cities/[id]/cursors — 내 위치를 안 올려도 다른 플레이어 커서만 조회한다.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const auth = await authorizeCityAccess(req, id)
  if (auth.error) return auth.error
  return NextResponse.json({ cursors: listOtherCursors(id, auth.player.id) })
}

// POST /api/cities/[id]/cursors — 내 커서 위치를 갱신하고 다른 플레이어들의 커서 목록을 받는다.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const auth = await authorizeCityAccess(req, id)
  if (auth.error) return auth.error

  const body = await req.json().catch(() => null)
  const parsed = CursorSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const nickname = auth.player.nickname ?? auth.player.username ?? '플레이어'
  upsertCursor(id, auth.player.id, nickname, parsed.data.x, parsed.data.y)

  return NextResponse.json({ cursors: listOtherCursors(id, auth.player.id) })
}

// DELETE /api/cities/[id]/cursors — 지도를 벗어나거나 페이지를 떠날 때 내 커서를 즉시 제거한다.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const auth = await authorizeCityAccess(req, id)
  if (auth.error) return auth.error

  removeCursor(id, auth.player.id)
  return NextResponse.json({ ok: true })
}
