import { loadSettings, type GameSettings } from './settings'

export const BGM_SRC = '/audio/crab_audio-toy-train-296983.mp3'

const SETTINGS_EVENT = 'nlt:settings'

let audio: HTMLAudioElement | null = null
let started = false
let playAttempt: Promise<void> | null = null

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

function tryPlay() {
  const el = ensureAudio()
  if (!el) return

  const settings = loadSettings()
  el.volume = targetVolume(settings)

  if (!settings.bgmEnabled || settings.bgmVolume <= 0) {
    el.pause()
    return
  }

  if (!el.paused && started) return

  if (playAttempt) return
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
}

export function applyBgmSettings(settings: GameSettings = loadSettings()) {
  const el = ensureAudio()
  if (!el) return

  el.volume = targetVolume(settings)

  if (!settings.bgmEnabled || settings.bgmVolume <= 0) {
    el.pause()
    return
  }

  // 이미 재생 중일 때만 볼륨/재개를 반영한다. 첫 재생은 unlockBgm에서.
  if (started || !el.paused) tryPlay()
}

/** 시작 버튼 등 사용자 제스처에서 호출해 BGM을 켠다. */
export function unlockBgm() {
  started = false
  tryPlay()
}

export function initBgm() {
  ensureAudio()
  applyBgmSettings(loadSettings())

  if (typeof window === 'undefined') return

  window.addEventListener(SETTINGS_EVENT, ((event: CustomEvent<GameSettings>) => {
    applyBgmSettings(event.detail ?? loadSettings())
  }) as EventListener)
}

export function isBgmStarted() {
  return started
}
