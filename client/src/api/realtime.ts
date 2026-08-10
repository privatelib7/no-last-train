import type { CityMotionSnapshot } from './game'
import type { CityState } from './game'

/**
 * 도시 상태·차량 위치를 서버가 밀어주는(push) WebSocket 연결.
 * 예전의 /city(2500ms)·/motion(500ms) HTTP 폴링을 대체한다.
 */

const API_BASE = import.meta.env.VITE_API_URL ?? ''

function wsUrl(): string {
  if (API_BASE) {
    // https://example.com -> wss://example.com/ws, http:// -> ws://
    return API_BASE.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws'
  }
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/ws`
}

type RealtimeHandlers = {
  onMotion: (snapshot: CityMotionSnapshot) => void
  onCity: (state: CityState) => void
  onError?: (message: string) => void
}

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8000

export type RealtimeConnection = { close: () => void }

/** 도시 하나를 구독한다. cityId나 token이 바뀌면 새로 connectRealtime을 불러야 한다. */
export function connectRealtime(
  cityId: string,
  playerToken: string | undefined,
  handlers: RealtimeHandlers,
): RealtimeConnection {
  let closed = false
  let ws: WebSocket | null = null
  let reconnectAttempt = 0
  let reconnectTimer: number | null = null

  const subscribe = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'subscribe', cityId, playerToken: playerToken ?? '' }))
  }

  const scheduleReconnect = () => {
    if (closed) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt)
    reconnectAttempt += 1
    reconnectTimer = window.setTimeout(connect, delay)
  }

  const connect = () => {
    if (closed) return
    const socket = new WebSocket(wsUrl())
    ws = socket

    socket.onopen = () => {
      reconnectAttempt = 0
      subscribe()
    }

    socket.onmessage = event => {
      let msg: unknown
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      const { type, payload, message } = msg as { type?: string; payload?: unknown; message?: string }
      if (type === 'motion' && payload) handlers.onMotion(payload as CityMotionSnapshot)
      else if (type === 'city' && payload) handlers.onCity(payload as CityState)
      else if (type === 'error' && message) handlers.onError?.(message)
    }

    socket.onclose = () => {
      if (ws === socket) ws = null
      scheduleReconnect()
    }

    socket.onerror = () => {
      socket.close()
    }
  }

  connect()

  return {
    close: () => {
      closed = true
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer)
      ws?.close()
      ws = null
    },
  }
}
