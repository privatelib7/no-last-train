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

async function claimUnownedCity(cityId: string, playerId: string) {
  const claimed = await db.city.updateMany({
    where: { id: cityId, ownerPlayerId: null },
    data: { ownerPlayerId: playerId },
  })
  if (claimed.count > 0) return true

  // 동시에 다른 요청이 승계를 끝냈다면 최종 소유자를 다시 확인한다.
  return isCityOwner(cityId, playerId)
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

  const [city, ownsLine, invited] = await Promise.all([
    db.city.findUnique({ where: { id: cityId }, select: { ownerPlayerId: true } }),
    db.line.findFirst({ where: { cityId, playerId: player.id }, select: { id: true } }),
    player.email
      ? db.cityInvite.findUnique({ where: { cityId_email: { cityId, email: player.email } } })
      : Promise.resolve(null),
  ])

  if (city?.ownerPlayerId === player.id) {
    return { player }
  }

  // 예전 데이터 복구: 관제장이 비어 있고 내 노선이 있으면 실제 관제장으로 승계한다.
  // 화면의 isOwner와 변경 API가 모두 같은 ownerPlayerId를 보게 해야 한다.
  if (!city?.ownerPlayerId && ownsLine && await claimUnownedCity(cityId, player.id)) {
    return { player }
  }

  if (ownsLine || invited) return { player }

  // 더 오래된 데이터는 활동 기록을 마지막 복구 근거로 사용한다.
  const acted = await db.activityLog.findFirst({
    where: { cityId, playerId: player.id },
    select: { id: true },
  })
  if (!city?.ownerPlayerId && acted && await claimUnownedCity(cityId, player.id)) return { player }

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
