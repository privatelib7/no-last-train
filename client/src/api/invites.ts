export type CityInvite = {
  email: string
  createdAt: string
}

export type CityInvitesPayload = {
  ownerEmail: string | null
  invites: CityInvite[]
}

const API_BASE = import.meta.env.VITE_API_URL ?? ''

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.error ?? `요청에 실패했습니다. (${res.status})`)
  }
  return body as T
}

export function fetchInvites(cityId: string, playerToken: string) {
  return request<CityInvitesPayload>(`/api/cities/${cityId}/invites`, {
    headers: { 'x-player-token': playerToken },
  })
}

export function addInvite(cityId: string, playerToken: string, email: string) {
  return request<CityInvite>(`/api/cities/${cityId}/invites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-player-token': playerToken },
    body: JSON.stringify({ email }),
  })
}
