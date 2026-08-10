/**
 * 실시간 모션 캐시용 Redis 연결 — PostgreSQL을 대체하지 않는 순수 보조 계층이다.
 * Redis가 없거나 끊겨도 호출부는 항상 PostgreSQL로 직접 폴백할 수 있어야 하므로,
 * 여기서는 절대 throw하지 않고 null/실패로만 알린다.
 */
import Redis from 'ioredis'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

function createClient(name: string) {
  const client = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: attempts => Math.min(1000 * attempts, 10_000),
    reconnectOnError: () => true,
  })
  client.on('error', err => {
    console.error(`[redis:${name}] ${err.message}`)
  })
  return client
}

let commandClient: Redis | null = null
let subscriberClient: Redis | null = null

/**
 * 일반 GET/SET/PUBLISH용 클라이언트 — 연결 실패 시 null을 반환(throw 금지).
 * 연결 시도는 한 번만 걸어두고(이후는 ioredis가 retryStrategy로 알아서 재시도),
 * 100ms 주기의 뜨거운 경로에서 매번 connect()를 기다리지 않도록 상태만 확인한다.
 */
export async function getRedisCommandClient(): Promise<Redis | null> {
  if (!commandClient) {
    commandClient = createClient('cmd')
    commandClient.connect().catch(() => {})
  }
  return commandClient.status === 'ready' ? commandClient : null
}

/** SUBSCRIBE 전용 클라이언트 — ioredis는 구독 모드에서 일반 명령을 함께 못 쓴다 */
export function getRedisSubscriberClient(): Redis {
  if (!subscriberClient) subscriberClient = createClient('sub')
  return subscriberClient
}

/** Redis 실패는 항상 무시 가능해야 한다 — 캐시일 뿐, 실패해도 상위 로직은 DB로 계속 동작한다 */
export async function safeRedisCall<T>(fn: (client: Redis) => Promise<T>): Promise<T | null> {
  try {
    const client = await getRedisCommandClient()
    if (!client) return null
    return await fn(client)
  } catch (err) {
    console.error('[redis] command failed', err)
    return null
  }
}
