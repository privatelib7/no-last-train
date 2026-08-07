export type ActivityItem = {
  id: string
  cityId: string
  cityName: string
  roomTitle: string
  actor: string
  message: string
  createdAt: string
}

const API_BASE = import.meta.env.VITE_API_URL ?? ''

export async function fetchRecentActivity(playerToken: string): Promise<ActivityItem[]> {
  const res = await fetch(`${API_BASE}/api/activity`, {
    headers: { 'x-player-token': playerToken },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `최근 활동을 불러오지 못했습니다. (${res.status})`)
  }
  const data = (await res.json()) as { activity: ActivityItem[] }
  return data.activity
}
