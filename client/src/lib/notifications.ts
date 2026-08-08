export type NotifyResult = 'scheduled' | 'unsupported' | 'denied' | 'busy'

export type PendingNotification = {
  roomTitle: string
  firesAt: number
  delayMs: number
}

type Listener = (pending: PendingNotification | null) => void

const MAJOR_EVENT_MESSAGES = [
  '혼잡도가 위험 수준에 도달했습니다.',
  '콘서트 이벤트로 수요가 급증했습니다.',
  'AI가 긴급 예비 차량을 투입했습니다.',
  '노선 하나가 서비스 저하 상태에 빠졌습니다.',
]

let pending: PendingNotification | null = null
const listeners = new Set<Listener>()

function isSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

function emit() {
  for (const listener of listeners) listener(pending)
}

export function getPendingNotification() {
  return pending
}

export function subscribePendingNotification(listener: Listener) {
  listeners.add(listener)
  listener(pending)
  return () => {
    listeners.delete(listener)
  }
}

async function ensurePermission(): Promise<NotificationPermission> {
  if (!isSupported()) return 'denied'
  if (Notification.permission !== 'default') return Notification.permission
  return Notification.requestPermission()
}

function fireNotification(roomTitle: string) {
  const message = MAJOR_EVENT_MESSAGES[Math.floor(Math.random() * MAJOR_EVENT_MESSAGES.length)]!
  try {
    new Notification(`${roomTitle} — 주요 이벤트`, {
      body: message,
      icon: '/favicon.svg',
      tag: `nlt-major-event-${Date.now()}`,
    })
  } catch {
    // 일부 환경에서 Notification 생성 실패 시 무시
  }
}

// 버튼 클릭 시 예약. GamePage가 언마운트되어도(로비 이동) 타이머는 유지된다.
export async function scheduleMajorEventNotification(
  roomTitle: string,
  delayMs = 5000,
): Promise<NotifyResult> {
  if (!isSupported()) return 'unsupported'
  if (pending) return 'busy'

  const permission = await ensurePermission()
  if (permission !== 'granted') return 'denied'

  const title = roomTitle.trim() || '관제실'
  pending = {
    roomTitle: title,
    firesAt: Date.now() + delayMs,
    delayMs,
  }
  emit()

  window.setTimeout(() => {
    fireNotification(title)
    clearPending()
  }, delayMs)

  return 'scheduled'
}
