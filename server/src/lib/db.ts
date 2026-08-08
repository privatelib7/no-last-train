import { getCloudflareContext } from '@opennextjs/cloudflare'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function isParseableUrl(value: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(value)
    return true
  } catch {
    return false
  }
}

/**
 * Hyperdrive 로컬 모드가 userinfo 특수문자(#, / 등)를 디코딩된 채로
 * 다시 붙여 workerd URL 파서가 실패하는 경우가 있다. userinfo만 재인코딩한다.
 */
function repairPostgresUrl(raw: string): string | null {
  const schemeIdx = raw.indexOf('://')
  if (schemeIdx < 0) return null
  const at = raw.lastIndexOf('@')
  if (at < schemeIdx) return null
  const scheme = raw.slice(0, schemeIdx + 3)
  const userinfo = raw.slice(schemeIdx + 3, at)
  const rest = raw.slice(at + 1)
  const colon = userinfo.indexOf(':')
  if (colon < 0) return null
  const user = userinfo.slice(0, colon)
  const pass = userinfo.slice(colon + 1)
  let decodedUser = user
  let decodedPass = pass
  try {
    decodedUser = decodeURIComponent(user)
  } catch {
    /* keep */
  }
  try {
    decodedPass = decodeURIComponent(pass)
  } catch {
    /* keep */
  }
  return `${scheme}${encodeURIComponent(decodedUser)}:${encodeURIComponent(decodedPass)}@${rest}`
}

type ResolvedConnection = {
  connectionString: string
  relaxTls: boolean
}

function resolveConnection(): ResolvedConnection {
  try {
    const { env } = getCloudflareContext()
    const hyperdrive = (env as { HYPERDRIVE?: { connectionString: string } }).HYPERDRIVE
    const raw = hyperdrive?.connectionString
    if (raw) {
      if (isParseableUrl(raw)) {
        return { connectionString: raw, relaxTls: false }
      }
      const repaired = repairPostgresUrl(raw)
      if (repaired && isParseableUrl(repaired)) {
        // 로컬 HD는 sslmode=disable + hyperdrive.local 로 바뀌는 경우가 많다.
        return { connectionString: repaired, relaxTls: true }
      }
    }
  } catch {
    // 시드/로컬 Next 등 CF 컨텍스트 밖
  }

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL이 설정되지 않았습니다.')
  return { connectionString, relaxTls: true }
}

function createClient(): PrismaClient {
  const { connectionString, relaxTls } = resolveConnection()

  let ssl: boolean | { rejectUnauthorized: boolean } | undefined
  try {
    const mode = new URL(connectionString).searchParams.get('sslmode')
    if (mode === 'disable') ssl = false
    else if (relaxTls || mode === 'no-verify' || mode === 'require') ssl = { rejectUnauthorized: false }
  } catch {
    if (relaxTls) ssl = { rejectUnauthorized: false }
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    maxUses: 1,
    ...(ssl !== undefined ? { ssl } : {}),
  })

  return new PrismaClient({
    adapter: new PrismaPg(pool),
    log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
  })
}

function getClient(): PrismaClient {
  // Worker에서는 요청마다 Hyperdrive 컨텍스트를 다시 읽는다.
  if (process.env.NODE_ENV !== 'production') {
    return globalForPrisma.prisma ?? (globalForPrisma.prisma = createClient())
  }
  return createClient()
}

export const db = new Proxy({} as PrismaClient, {
  get(_target, prop, _receiver) {
    const client = getClient()
    const value = Reflect.get(client, prop, client)
    return typeof value === 'function' ? value.bind(client) : value
  },
})
