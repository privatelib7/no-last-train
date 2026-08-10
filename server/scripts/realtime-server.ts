/**
 * 실시간 상태(차량 위치·틱, 도시 전체 상태) 전용 WebSocket 서버.
 *
 * HTTP 폴링(예전 /motion 500ms, /city 2500ms)을 대체한다 — 클라이언트가 반복해서
 * 요청하는 대신, 이 서버가 계산해서 밀어준다(push). 액션(역 짓기 등)과 인증은
 * 그대로 HTTP REST로 남아 있다.
 *
 * 구독 중인 도시는 빠르게(500ms, 큰 상한) 따라잡고, 최근에(30분 이내) 활동이 있던
 * 나머지 활성 도시도 가벼운 배경 하트비트로 실시간에 가깝게 유지한다 — 그래야
 * 나중에 들어왔을 때 밀린 틱을 몰아서 따라잡느라 순간이동처럼 보이는 일이 없다.
 * 오래(수십 시간) 방치된 도시는 하트비트에서 제외해 워커 풀을 굶기지 않는다.
 *
 *   npx tsx scripts/realtime-server.ts
 */
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { resolvePlayerByToken, cityExists } from '../src/lib/access'
import { syncCityClock, tickRecentlyActiveCities } from '../src/lib/simulation'
import { buildCityMotionSnapshot } from '../src/lib/city-motion'
import { buildCityStateSnapshot } from '../src/lib/city-state'
import { SIM } from '../src/types/game'

const PORT = Number(process.env.REALTIME_PORT ?? 3012)
const MOTION_INTERVAL_MS = 500
const CITY_INTERVAL_MS = 2500
const HEARTBEAT_INTERVAL_MS = SIM.LIVE_TICK_MS
// 데스크톱을 켜둔 채 오래 자리를 비웠다 돌아온 구독이라도 몇 초 안에 실시간을 따라잡도록,
// 이 브로드캐스트 루프는 HTTP 라이브 폴링(3틱)보다 넉넉한 상한을 쓴다. 오직 "지금 구독
// 중인" 도시에만 적용되므로 예전 하트비트처럼 방치된 도시들에 발목 잡히지 않는다.
const WS_CATCHUP_MAX_TICKS = 20

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
  if (set && set.size === 0) citySubscribers.delete(state.cityId)
  state.cityId = null
}

function send(ws: WebSocket, message: unknown) {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(message))
}

async function sendMotionTo(ws: WebSocket, cityId: string) {
  try {
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

async function broadcastMotion() {
  for (const [cityId, sockets] of citySubscribers) {
    if (sockets.size === 0) continue
    try {
      await syncCityClock(cityId, WS_CATCHUP_MAX_TICKS)
      const snapshot = await buildCityMotionSnapshot(cityId)
      if (!snapshot) continue
      const message = JSON.stringify({ type: 'motion', payload: snapshot })
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(message)
      }
    } catch (err) {
      console.error(`[realtime] motion broadcast failed for ${cityId}`, err)
    }
  }
}

async function broadcastCityState() {
  for (const [cityId, sockets] of citySubscribers) {
    if (sockets.size === 0) continue
    try {
      // isOwner는 구독자(플레이어)마다 다르므로 스냅샷 자체는 한 번만 계산하고,
      // 소켓별로 ownerPlayerId와 비교해 붙여 보낸다.
      const snapshot = await buildCityStateSnapshot(cityId, null)
      if (!snapshot) continue
      for (const ws of sockets) {
        if (ws.readyState !== WebSocket.OPEN) continue
        const playerId = connState.get(ws)?.playerId ?? null
        const isOwner = playerId != null && snapshot.city.ownerPlayerId === playerId
        send(ws, { type: 'city', payload: { ...snapshot, isOwner } })
      }
    } catch (err) {
      console.error(`[realtime] city broadcast failed for ${cityId}`, err)
    }
  }
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
      // 구독 직후 다음 브로드캐스트 주기를 기다리지 않고 바로 한 번 밀어준다.
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

let motionRunning = false
setInterval(() => {
  if (motionRunning) return
  motionRunning = true
  broadcastMotion().catch(err => console.error('[realtime] broadcastMotion failed', err)).finally(() => {
    motionRunning = false
  })
}, MOTION_INTERVAL_MS)

let cityRunning = false
setInterval(() => {
  if (cityRunning) return
  cityRunning = true
  broadcastCityState().catch(err => console.error('[realtime] broadcastCityState failed', err)).finally(() => {
    cityRunning = false
  })
}, CITY_INTERVAL_MS)

// 아무도 구독하지 않은 도시도(최근에 활동이 있었다면) 가볍게 실시간을 유지한다.
let heartbeatRunning = false
setInterval(() => {
  if (heartbeatRunning) return
  heartbeatRunning = true
  tickRecentlyActiveCities().catch(err => console.error('[realtime] heartbeat failed', err)).finally(() => {
    heartbeatRunning = false
  })
}, HEARTBEAT_INTERVAL_MS)

httpServer.listen(PORT, () => {
  console.log(`[realtime] listening on :${PORT} (ws path /ws)`)
})
