export type RemoteCursor = {
  playerId: string
  nickname: string
  x: number
  y: number
  color: string
  updatedAt: string
}

const API_BASE = import.meta.env.VITE_API_URL ?? ''

function authHeaders(playerToken: string): HeadersInit {
  return { 'x-player-token': playerToken }
}

// 내 커서 위치(x, y는 지도 좌표계 0~100)를 보내고 다른 플레이어들의 커서 목록을 받는다.
export async function syncCursor(
  cityId: string,
  playerToken: string,
  x: number,
  y: number,
): Promise<{ cursors: RemoteCursor[] }> {
  const res = await fetch(`${API_BASE}/api/cities/${cityId}/cursors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(playerToken) },
    body: JSON.stringify({ x, y }),
  })
  if (!res.ok) throw new Error(`커서 동기화 실패 (${res.status})`)
  return res.json()
}

// 지도에서 손을 떼도 다른 사람 커서는 계속 볼 수 있게 조회만 한다.
export async function fetchCursors(
  cityId: string,
  playerToken: string,
): Promise<{ cursors: RemoteCursor[] }> {
  const res = await fetch(`${API_BASE}/api/cities/${cityId}/cursors`, {
    headers: authHeaders(playerToken),
  })
  if (!res.ok) throw new Error(`커서 조회 실패 (${res.status})`)
  return res.json()
}

// 방을 나갈 때 내 커서를 즉시 지운다 (실패해도 TTL로 자연 소멸하므로 무시).
export function leaveCursor(cityId: string, playerToken: string) {
  return fetch(`${API_BASE}/api/cities/${cityId}/cursors`, {
    method: 'DELETE',
    headers: authHeaders(playerToken),
    keepalive: true,
  }).catch(() => {})
}
