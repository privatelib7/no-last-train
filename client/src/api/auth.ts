export type AuthSession = {
  playerId: string
  token: string
  username: string
  nickname: string | null
  email: string | null
}

export type RegisterResult = {
  message: string
  username: string
  email: string
  /** 개발 환경에서만 내려오는 인증 링크 */
  verifyUrl?: string
}

const API_BASE = import.meta.env.VITE_API_URL ?? ''

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(body.error ?? `요청에 실패했습니다. (${res.status})`) as Error & { code?: string }
    err.code = body.code
    throw err
  }
  return body as T
}

export function register(username: string, password: string, email: string, nickname?: string) {
  return request<RegisterResult>('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, email, nickname }),
  })
}

export function login(identifier: string, password: string) {
  return request<AuthSession>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  })
}

export function fetchMe(token: string) {
  return request<{ playerId: string; username: string | null; nickname: string | null; email: string | null }>(
    '/api/auth/me',
    { headers: { 'x-player-token': token } },
  )
}

export function verifyEmail(token: string) {
  return request<{ message: string }>('/api/auth/verify-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
}

export function resendVerification(identifier: string) {
  return request<{ message: string; verifyUrl?: string }>('/api/auth/resend-verification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  })
}

export function forgotPassword(identifier: string) {
  return request<{ message: string; resetUrl?: string }>('/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  })
}

export function resetPassword(token: string, password: string) {
  return request<{ message: string }>('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
  })
}
