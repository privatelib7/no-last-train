import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { Player } from '@prisma/client'

type AuthorizedResult = { player: Player; error?: undefined }
type UnauthorizedResult = { player?: undefined; error: NextResponse }

// 도시 데이터에 접근하는 모든 요청은 이 검사를 통과해야 한다:
// 로그인(x-player-token) + (해당 도시에 노선을 가진 소유자이거나, 초대된 이메일)이어야 한다.
export async function authorizeCityAccess(
  req: NextRequest,
  cityId: string,
): Promise<AuthorizedResult | UnauthorizedResult> {
  const token = req.headers.get('x-player-token')
  if (!token) {
    return { error: NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 }) }
  }

  const player = await db.player.findUnique({ where: { token } })
  if (!player) {
    return { error: NextResponse.json({ error: '세션이 만료되었습니다. 다시 로그인해주세요.' }, { status: 401 }) }
  }

  const [ownsLine, invited] = await Promise.all([
    db.line.findFirst({ where: { cityId, playerId: player.id }, select: { id: true } }),
    player.email
      ? db.cityInvite.findUnique({ where: { cityId_email: { cityId, email: player.email } } })
      : Promise.resolve(null),
  ])

  if (!ownsLine && !invited) {
    return {
      error: NextResponse.json(
        { error: '이 도시에 접근 권한이 없습니다. 초대받은 이메일 계정으로 로그인했는지 확인해주세요.' },
        { status: 403 },
      ),
    }
  }

  return { player }
}

/** 관제장(해당 도시에 노선을 소유한 플레이어)만 통과 */
export async function authorizeCityOwner(
  req: NextRequest,
  cityId: string,
): Promise<AuthorizedResult | UnauthorizedResult> {
  const auth = await authorizeCityAccess(req, cityId)
  if (auth.error) return auth

  const ownsLine = await db.line.findFirst({
    where: { cityId, playerId: auth.player.id },
    select: { id: true },
  })
  if (!ownsLine) {
    return {
      error: NextResponse.json({ error: '관제장만 변경할 수 있습니다.' }, { status: 403 }),
    }
  }

  return auth
}
