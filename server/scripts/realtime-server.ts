/**
 * 실시간 상태(차량 위치·틱, 도시 전체 상태) 전용 WebSocket 서버.
 *
 * 차량 좌표는 DB 틱(3초)과 분리해 자주 push 한다.
 * - motion push (~100ms): 캐시된 DB 상태에서 벽시계 preview로 x/y만 계산 (DB I/O 없음)
 * - motion sync (~500ms): 밀린 틱을 따라잡고 캐시를 무효화 → 다음 push가 새 DB 기준
 * - city state (~2500ms): 잔고·대기인원 등 무거운 스냅샷
 *
 *   npx tsx scripts/realtime-server.ts
 */
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { resolvePlayerByToken, cityExists } from '../src/lib/access'
import { syncCityClock, tickRecentlyActiveCities } from '../src/lib/simulation'
import {
  buildCityMotionSnapshot,
  invalidateCityMotionCache,
  loadCityMotionBase,
  refreshCityMotionBase,
} from '../src/lib/city-motion'
import { buildCityStateSnapshot } from '../src/lib/city-state'
import { SIM } from '../src/types/game'

const PORT = Number(process.env.REALTIME_PORT ?? 3012)
/** 좌표 push — 캐시 렌더만 하므로 짧게 가져도 DB를 때리지 않는다 */
const MOTION_PUSH_MS = 100
/** 틱 따라잡기 + 모션 베이스 갱신 (push보다 드물게, 캐시는 비우지 않고 교체) */
const MOTION_SYNC_MS = 400
const CITY_INTERVAL_MS = 2500
const HEARTBEAT_INTERVAL_MS = SIM.LIVE_TICK_MS
const WS_CATCHUP_MAX_TICKS = 20
const SYNC_CONCURRENCY = 4

type ConnState = { cityId: string | null; playerId: string | null }

const connState = new Map<WebSocket, ConnState>()
const citySubscribers = new Map<string, Set<WebSocket>>()

function subscribersFor(cityId: string): Set<WebSocket> {
  let set = citySubscribers.get(cityId)
  if (!set) {
    set = new Set()
    citySubscribers.set(cityId, set)
  }
  return set
}

function unsubscribe(ws: WebSocket) {
  const state = connState.get(ws)
  if (!state?.cityId) return
  const set = citySubscribers.get(state.cityId)
  set?.delete(ws)
  if (set && set.size === 0) {
    citySubscribers.delete(state.cityId)
    invalidateCityMotionCache(state.cityId)
  }
  state.cityId = null
}

function send(ws: WebSocket, message: unknown) {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(message))
}

function subscribedCityIds(): string[] {
  return [...citySubscribers.entries()]
    .filter(([, sockets]) => sockets.size > 0)
    .map(([cityId]) => cityId)
}

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  if (items.length === 0) return
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index]
      index += 1
      await fn(current)
    }
  })
  await Promise.all(workers)
}

async function sendMotionTo(ws: WebSocket, cityId: string) {
  try {
    // 구독 직후는 최신 DB를 강제 로드해 캐시를 데운다.
    await loadCityMotionBase(cityId)
    const snapshot = await buildCityMotionSnapshot(cityId)
    if (snapshot) send(ws, { type: 'motion', payload: snapshot })
  } catch (err) {
    console.error(`[realtime] initial motion send failed for ${cityId}`, err)
  }
}

async function sendCityStateTo(ws: WebSocket, cityId: string, playerId: string | null) {
  try {
    const snapshot = await buildCityStateSnapshot(cityId, playerId)
    if (snapshot) send(ws, { type: 'city', payload: snapshot })
  } catch (err) {
    console.error(`[realtime] initial city send failed for ${cityId}`, err)
  }
}

/** 캐시 기준 좌표만 밀어준다 — 매 사이클 DB/틱 처리 없음 */
async function broadcastMotionPush() {
  const cityIds = subscribedCityIds()
  await mapPool(cityIds, 8, async cityId => {
    const sockets = citySubscribers.get(cityId)
    if (!sockets || sockets.size === 0) return
    try {
      const snapshot = await buildCityMotionSnapshot(cityId)
      if (!snapshot) return
      const message = JSON.stringify({ type: 'motion', payload: snapshot })
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(message)
      }
    } catch (err) {
      console.error(`[realtime] motion push failed for ${cityId}`, err)
    }
  })
}

/** 틱을 따라잡고 모션 베이스를 원자적으로 교체한다(push 중 캐시 공백 없음) */
async function broadcastMotionSync() {
  const cityIds = subscribedCityIds()
  await mapPool(cityIds, SYNC_CONCURRENCY, async cityId => {
    try {
      await syncCityClock(cityId, WS_CATCHUP_MAX_TICKS)
      await refreshCityMotionBase(cityId)
    } catch (err) {
      console.error(`[realtime] motion sync failed for ${cityId}`, err)
    }
  })
}

async function broadcastCityState() {
  const cityIds = subscribedCityIds()
  await mapPool(cityIds, SYNC_CONCURRENCY, async cityId => {
    const sockets = citySubscribers.get(cityId)
    if (!sockets || sockets.size === 0) return
    try {
      // 건설/배차 반영: 캐시를 비우지 않고 새 베이스로 교체한 뒤 city 상태를 보낸다.
      await refreshCityMotionBase(cityId)
      const snapshot = await buildCityStateSnapshot(cityId, null)
      if (!snapshot) return
      for (const ws of sockets) {
        if (ws.readyState !== WebSocket.OPEN) continue
        const playerId = connState.get(ws)?.playerId ?? null
        const isOwner = playerId != null && snapshot.city.ownerPlayerId === playerId
        send(ws, { type: 'city', payload: { ...snapshot, isOwner } })
      }
    } catch (err) {
      console.error(`[realtime] city broadcast failed for ${cityId}`, err)
    }
  })
}

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

wss.on('connection', ws => {
  connState.set(ws, { cityId: null, playerId: null })

  ws.on('message', async raw => {
    let msg: unknown
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    const { type } = msg as { type?: string }

    if (type === 'subscribe') {
      const { cityId, playerToken } = msg as { cityId?: string; playerToken?: string }
      if (!cityId || typeof cityId !== 'string') return
      if (!playerToken || typeof playerToken !== 'string') {
        send(ws, { type: 'error', message: '로그인이 필요합니다.' })
        return
      }
      const player = await resolvePlayerByToken(playerToken)
      if (!player) {
        send(ws, { type: 'error', message: '세션이 만료되었습니다. 다시 로그인해주세요.' })
        return
      }
      if (!(await cityExists(cityId))) {
        send(ws, { type: 'error', message: '도시를 찾을 수 없습니다.' })
        return
      }
      unsubscribe(ws)
      connState.set(ws, { cityId, playerId: player.id })
      subscribersFor(cityId).add(ws)
      void sendMotionTo(ws, cityId)
      void sendCityStateTo(ws, cityId, player.id)
      return
    }

    if (type === 'unsubscribe') {
      unsubscribe(ws)
    }
  })

  ws.on('close', () => {
    unsubscribe(ws)
    connState.delete(ws)
  })

  ws.on('error', () => {
    unsubscribe(ws)
    connState.delete(ws)
  })
})

let motionPushRunning = false
setInterval(() => {
  if (motionPushRunning) return
  motionPushRunning = true
  broadcastMotionPush()
    .catch(err => console.error('[realtime] broadcastMotionPush failed', err))
    .finally(() => { motionPushRunning = false })
}, MOTION_PUSH_MS)

let motionSyncRunning = false
setInterval(() => {
  if (motionSyncRunning) return
  motionSyncRunning = true
  broadcastMotionSync()
    .catch(err => console.error('[realtime] broadcastMotionSync failed', err))
    .finally(() => { motionSyncRunning = false })
}, MOTION_SYNC_MS)

let cityRunning = false
setInterval(() => {
  if (cityRunning) return
  cityRunning = true
  broadcastCityState()
    .catch(err => console.error('[realtime] broadcastCityState failed', err))
    .finally(() => { cityRunning = false })
}, CITY_INTERVAL_MS)

let heartbeatRunning = false
setInterval(() => {
  if (heartbeatRunning) return
  heartbeatRunning = true
  tickRecentlyActiveCities()
    .catch(err => console.error('[realtime] heartbeat failed', err))
    .finally(() => { heartbeatRunning = false })
}, HEARTBEAT_INTERVAL_MS)

httpServer.listen(PORT, () => {
  console.log(`[realtime] listening on :${PORT} (ws path /ws, motion push ${MOTION_PUSH_MS}ms, sync ${MOTION_SYNC_MS}ms)`)
})
