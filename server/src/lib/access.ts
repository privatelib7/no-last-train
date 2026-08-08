import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { Player } from '@prisma/client'

type AuthorizedResult = { player: Player; error?: undefined }
type UnauthorizedResult = { player?: undefined; error: NextResponse }

async function isCityOwner(cityId: string, playerId: string) {
  const city = await db.city.findUnique({
    where: { id: cityId },
    select: { ownerPlayerId: true },
  })
  return !!city?.ownerPlayerId && city.ownerPlayerId === playerId
}

// 도시 데이터에 접근하는 모든 요청은 이 검사를 통과해야 한다:
// 로그인 + (관제장 ownerPlayerId / 소유 노선 / 초대 이메일)
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

  const [owner, ownsLine, invited] = await Promise.all([
    isCityOwner(cityId, player.id),
    db.line.findFirst({ where: { cityId, playerId: player.id }, select: { id: true } }),
    player.email
      ? db.cityInvite.findUnique({ where: { cityId_email: { cityId, email: player.email } } })
      : Promise.resolve(null),
  ])

  if (owner || ownsLine || invited) {
    return { player }
  }

  // 예전 데이터 복구: 활동 기록이 있는데 owner가 비어 있으면 관제장으로 승격
  const [acted, city] = await Promise.all([
    db.activityLog.findFirst({ where: { cityId, playerId: player.id }, select: { id: true } }),
    db.city.findUnique({ where: { id: cityId }, select: { ownerPlayerId: true } }),
  ])
  if (acted && !city?.ownerPlayerId) {
    await db.city.update({
      where: { id: cityId },
      data: { ownerPlayerId: player.id },
    })
    return { player }
  }

  return {
    error: NextResponse.json(
      { error: '이 도시에 접근 권한이 없습니다. 초대받은 이메일 계정으로 로그인했는지 확인해주세요.' },
      { status: 403 },
    ),
  }
}

/** 관제장(City.ownerPlayerId)만 통과 */
export async function authorizeCityOwner(
  req: NextRequest,
  cityId: string,
): Promise<AuthorizedResult | UnauthorizedResult> {
  const auth = await authorizeCityAccess(req, cityId)
  if (auth.error) return auth

  if (!(await isCityOwner(cityId, auth.player.id))) {
    return {
      error: NextResponse.json({ error: '관제장만 변경할 수 있습니다.' }, { status: 403 }),
    }
  }

  return auth
}
