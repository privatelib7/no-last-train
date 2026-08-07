export type ThemeMode = 'light' | 'dark'

export interface GameSettings {
  theme: ThemeMode
  bgmEnabled: boolean
  bgmVolume: number // 0-100
  sfxEnabled: boolean
  sfxVolume: number // 0-100
}

const SETTINGS_KEY = 'nlt.settings'

const DEFAULT_SETTINGS: GameSettings = {
  theme: 'light',
  bgmEnabled: true,
  bgmVolume: 70,
  sfxEnabled: true,
  sfxVolume: 80,
}

export function loadSettings(): GameSettings {
  const raw = window.localStorage.getItem(SETTINGS_KEY)
  if (!raw) return { ...DEFAULT_SETTINGS }
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<GameSettings>) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: GameSettings) {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

// html 루트에 data-theme을 반영한다 — 다크모드는 index.css의 공통 CSS 변수 오버라이드로만 처리된다.
export function applyTheme(theme: ThemeMode) {
  document.documentElement.dataset.theme = theme
}
