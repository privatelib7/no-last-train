import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { Player } from '@prisma/client'

type AuthorizedResult = { player: Player; error?: undefined }
type UnauthorizedResult = { player?: undefined; error: NextResponse }

const PLAYER_CACHE_TTL_MS = 30_000
const CITY_CACHE_TTL_MS = 60_000

const globalForAuth = globalThis as unknown as {
  __nltPlayerByToken?: Map<string, { player: Player; expiresAt: number }>
  __nltCityExists?: Map<string, number>
}

function playerCache() {
  if (!globalForAuth.__nltPlayerByToken) globalForAuth.__nltPlayerByToken = new Map()
  return globalForAuth.__nltPlayerByToken
}

function cityCache() {
  if (!globalForAuth.__nltCityExists) globalForAuth.__nltCityExists = new Map()
  return globalForAuth.__nltCityExists
}

export async function resolvePlayerByToken(token: string): Promise<Player | null> {
  const now = Date.now()
  const cached = playerCache().get(token)
  if (cached && cached.expiresAt > now) return cached.player

  const player = await db.player.findUnique({ where: { token } })
  if (!player) {
    playerCache().delete(token)
    return null
  }
  playerCache().set(token, { player, expiresAt: now + PLAYER_CACHE_TTL_MS })
  return player
}

export async function cityExists(cityId: string): Promise<boolean> {
  const now = Date.now()
  const cachedUntil = cityCache().get(cityId)
  if (cachedUntil && cachedUntil > now) return true

  const city = await db.city.findUnique({ where: { id: cityId }, select: { id: true } })
  if (!city) {
    cityCache().delete(cityId)
    return false
  }
  cityCache().set(cityId, now + CITY_CACHE_TTL_MS)
  return true
}

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
// 로그인만 하면 링크를 통해 바로 플레이 가능 (데모용)
export async function authorizeCityAccess(
  req: NextRequest,
  cityId: string,
): Promise<AuthorizedResult | UnauthorizedResult> {
  const token = req.headers.get('x-player-token')
  if (!token) {
    return { error: NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 }) }
  }

  const player = await resolvePlayerByToken(token)
  if (!player) {
    return { error: NextResponse.json({ error: '세션이 만료되었습니다. 다시 로그인해주세요.' }, { status: 401 }) }
  }

  if (!(await cityExists(cityId))) {
    return { error: NextResponse.json({ error: '도시를 찾을 수 없습니다.' }, { status: 404 }) }
  }

  // 예전 데이터 복구: 관제장이 비어 있고 내 노선/활동 기록이 있으면 실제 관제장으로 승계한다.
  // 화면의 isOwner와 변경 API가 모두 같은 ownerPlayerId를 보게 해야 한다.
  // (접근 자체는 링크만 있으면 되므로, 이 승계는 접근 여부와 무관하게 부수적으로 시도한다.)
  const city = await db.city.findUnique({ where: { id: cityId }, select: { ownerPlayerId: true } })
  if (!city?.ownerPlayerId) {
    const [ownsLine, acted] = await Promise.all([
      db.line.findFirst({ where: { cityId, playerId: player.id }, select: { id: true } }),
      db.activityLog.findFirst({ where: { cityId, playerId: player.id }, select: { id: true } }),
    ])
    if (ownsLine || acted) await claimUnownedCity(cityId, player.id)
  }

  return { player }
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
