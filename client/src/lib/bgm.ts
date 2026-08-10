import { loadSettings, type GameSettings } from './settings'

export const BGM_SRC = '/audio/crab_audio-toy-train-296983.mp3'

const SETTINGS_EVENT = 'nlt:settings'

let audio: HTMLAudioElement | null = null
let started = false
let playAttempt: Promise<void> | null = null
// 사용자가 이 탭에서 한 번이라도 상호작용했는지. 자동재생 정책의 통과 여부를 가른다.
let gestured = false
let gestureBound = false

function ensureAudio() {
  if (audio || typeof Audio === 'undefined') return audio
  audio = new Audio(BGM_SRC)
  audio.loop = true
  audio.preload = 'auto'
  return audio
}

function targetVolume(settings: GameSettings) {
  if (!settings.bgmEnabled) return 0
  return Math.max(0, Math.min(1, settings.bgmVolume / 100))
}

function tryPlay(): Promise<void> | null {
  const el = ensureAudio()
  if (!el) return null

  const settings = loadSettings()
  el.volume = targetVolume(settings)

  if (!settings.bgmEnabled || settings.bgmVolume <= 0) {
    el.pause()
    return null
  }

  if (!el.paused && started) return null

  if (playAttempt) return playAttempt
  playAttempt = el.play()
    .then(() => {
      started = true
    })
    .catch(() => {
      // 사용자 제스처 밖에서 호출되면 브라우저가 막을 수 있다.
    })
    .finally(() => {
      playAttempt = null
    })

  return playAttempt
}

/**
 * 첫 사용자 상호작용에서 BGM을 켠다.
 *
 * 타이틀 "시작"을 거치지 않는 진입 경로(공유 링크·새로고침으로 곧장 인게임 등)에서는
 * unlockBgm을 부르는 화면을 아예 지나치지 않으므로, 어느 화면이든 첫 클릭/키 입력을
 * 잠금 해제 지점으로 삼는다. 재생이 실제로 시작될 때까지 리스너를 유지해
 * (BGM이 꺼져 있다가 나중에 켜지는 경우 포함) 다음 상호작용에 다시 시도한다.
 */
function bindGestureUnlock() {
  if (gestureBound || typeof window === 'undefined') return
  gestureBound = true

  const events = ['pointerdown', 'keydown', 'touchstart'] as const
  const options = { capture: true, passive: true } as const

  const onGesture = () => {
    gestured = true
    const attempt = tryPlay()
    if (!attempt) return
    void attempt.then(() => {
      if (!started) return
      for (const type of events) window.removeEventListener(type, onGesture, options)
    })
  }

  for (const type of events) window.addEventListener(type, onGesture, options)
}

export function applyBgmSettings(settings: GameSettings = loadSettings()) {
  const el = ensureAudio()
  if (!el) return

  el.volume = targetVolume(settings)

  if (!settings.bgmEnabled || settings.bgmVolume <= 0) {
    el.pause()
    return
  }

  // 상호작용 전에는 볼륨만 맞춰둔다 — 자동재생이 막히므로 첫 재생은 제스처에서.
  // 한 번이라도 상호작용했다면 설정에서 BGM을 다시 켠 것만으로도 재생을 재개한다.
  if (started || !el.paused || gestured) tryPlay()
}

/** 시작 버튼 등 사용자 제스처에서 호출해 BGM을 켠다. */
export function unlockBgm() {
  gestured = true
  started = false
  tryPlay()
}

export function initBgm() {
  ensureAudio()
  applyBgmSettings(loadSettings())
  bindGestureUnlock()

  if (typeof window === 'undefined') return

  window.addEventListener(SETTINGS_EVENT, ((event: CustomEvent<GameSettings>) => {
    applyBgmSettings(event.detail ?? loadSettings())
  }) as EventListener)
}

export function isBgmStarted() {
  return started
}
