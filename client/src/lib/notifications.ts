function isSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

async function ensurePermission(): Promise<NotificationPermission> {
  if (!isSupported()) return 'denied'
  if (Notification.permission !== 'default') return Notification.permission
  return Notification.requestPermission()
}

// 파산 위험·게임오버 같은 응급 상황이 발생한 순간 크롬 알림을 한 번 띄운다.
// tag를 상황별로 고유하게 주면(예: `nlt-cash-${cityId}`) 알림이 중복으로 쌓이지 않는다.
export async function notifyEmergency(title: string, body: string, tag: string): Promise<void> {
  if (!isSupported()) return
  const permission = await ensurePermission()
  if (permission !== 'granted') return
  try {
    new Notification(title, { body, icon: '/favicon.svg', tag })
  } catch {
    // 일부 환경에서 Notification 생성 실패 시 무시
  }
}
