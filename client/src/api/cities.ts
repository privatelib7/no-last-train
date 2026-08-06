export type LobbyCity = {
  id: string
  name: string
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
