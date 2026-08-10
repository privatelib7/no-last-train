export type LobbyCity = {
  id: string
  name: string
  roomTitle: string
  mapKey: string
  seasonDay: number
  status: 'ACTIVE' | 'SEASON_ENDED'
  lineCount: number
  lines: string[]
  createdAt: string
}

const API_BASE = import.meta.env.VITE_API_URL ?? ''

export async function fetchCities(playerToken?: string): Promise<LobbyCity[]> {
  const headers: HeadersInit = {}
  if (playerToken) headers['x-player-token'] = playerToken

  const res = await fetch(`${API_BASE}/api/cities`, { headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `도시 목록을 불러오지 못했습니다. (${res.status})`)
  }

  const data = (await res.json()) as { cities: LobbyCity[] }
  return data.cities
}

export async function fetchCityNames(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/cities/names`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `도시 이름 목록을 불러오지 못했습니다. (${res.status})`)
  }

  const data = (await res.json()) as { names: string[] }
  return data.names
}

export type LineColor = 'RED' | 'BLUE' | 'GREEN' | 'YELLOW' | 'PURPLE'

export async function createCity(
  playerToken: string,
  options: { name: string; roomTitle?: string; lineColor?: LineColor },
): Promise<{ cityId: string; name: string; roomTitle: string }> {
  const res = await fetch(`${API_BASE}/api/cities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerToken,
      name: options.name,
      roomTitle: options.roomTitle,
      lineColor: options.lineColor ?? 'RED',
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.error ?? `도시를 만들지 못했습니다. (${res.status})`)
  }

  return body as { cityId: string; name: string; roomTitle: string }
}

export async function updateRoomTitle(
  cityId: string,
  playerToken: string,
  roomTitle: string,
): Promise<{ id: string; name: string; roomTitle: string }> {
  const res = await fetch(`${API_BASE}/api/cities/${cityId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-player-token': playerToken,
    },
    body: JSON.stringify({ roomTitle }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.error ?? `방제목을 바꾸지 못했습니다. (${res.status})`)
  }
  return body as { id: string; name: string; roomTitle: string }
}

export async function deleteCity(
  cityId: string,
  playerToken: string,
  roomTitle: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/cities/${cityId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'x-player-token': playerToken,
    },
    body: JSON.stringify({ roomTitle }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `관제실을 삭제하지 못했습니다. (${res.status})`)
  }
}
