import { loadSettings } from './settings'

export const GOAL_UNLOCK_SFX_SRC = '/audio/mixkit-unlock-new-item-game-notification-254.wav'

/** 일회성 효과음 재생. 설정에서 SFX가 꺼져 있으면 무시한다. */
export function playSfx(src: string) {
  if (typeof Audio === 'undefined') return

  const settings = loadSettings()
  if (!settings.sfxEnabled || settings.sfxVolume <= 0) return

  const audio = new Audio(src)
  audio.volume = Math.max(0, Math.min(1, settings.sfxVolume / 100))
  void audio.play().catch(() => {
    // 사용자 제스처 전이면 브라우저가 막을 수 있다.
  })
}

export function playGoalUnlockSfx() {
  playSfx(GOAL_UNLOCK_SFX_SRC)
}
