import { useState } from 'react'
import styles from './SettingsPage.module.css'
import LicensesPage from './LicensesPage'
import { unlockBgm } from '../lib/bgm'
import { applyTheme, loadSettings, saveSettings, type GameSettings } from '../lib/settings'

interface Props {
  onBack: () => void
}

export default function SettingsPage({ onBack }: Props) {
  const [settings, setSettings] = useState<GameSettings>(() => loadSettings())
  // 설정 안에서만 오가는 화면이라 App의 페이지 상태 대신 여기서 관리한다.
  const [view, setView] = useState<'settings' | 'licenses'>('settings')

  const update = (patch: Partial<GameSettings>) => {
    // 슬라이더/토글 조작 자체가 사용자 제스처이므로 여기서 BGM 잠금을 푼다.
    unlockBgm()
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      if (patch.theme) applyTheme(patch.theme)
      return next
    })
  }

  if (view === 'licenses') return <LicensesPage onBack={() => setView('settings')} />

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <button className={styles.backBtn} onClick={onBack} type="button" title="뒤로">
          <span className={styles.backArrow}>←</span>
        </button>

        <div className={styles.header}>
          <div className={styles.titleKo}>설정</div>
          <p className={styles.subtitle}>화면과 소리를 취향에 맞게 조정하세요.</p>
        </div>

        <div className={styles.section}>
          <span className={styles.sectionTitle}>화면</span>

          <label className={styles.row}>
            <span className={styles.rowLabel}>
              <span className={styles.rowTitle}>다크 모드</span>
              <span className={styles.rowHint}>어두운 화면으로 눈의 피로를 줄여요.</span>
            </span>
            <span className={styles.switch}>
              <input
                type="checkbox"
                checked={settings.theme === 'dark'}
                onChange={(e) => update({ theme: e.target.checked ? 'dark' : 'light' })}
              />
              <span className={styles.switchTrack} />
            </span>
          </label>
        </div>

        <div className={styles.section}>
          <span className={styles.sectionTitle}>소리</span>

          <div className={styles.volumeBlock}>
            <div className={styles.volumeHeader}>
              <span className={styles.volumeLabel}>
                <input
                  className={styles.checkbox}
                  type="checkbox"
                  checked={settings.bgmEnabled}
                  onChange={(e) => update({ bgmEnabled: e.target.checked })}
                  aria-label="배경음악 켜기/끄기"
                />
                배경음악
              </span>
              <span className={styles.volumeValue}>{settings.bgmVolume}%</span>
            </div>
            <input
              className={styles.slider}
              type="range"
              min={0}
              max={100}
              value={settings.bgmVolume}
              disabled={!settings.bgmEnabled}
              onChange={(e) => update({ bgmVolume: Number(e.target.value) })}
              aria-label="배경음악 음량"
            />
          </div>
        </div>

        <div className={styles.section}>
          <span className={styles.sectionTitle}>정보</span>

          <button className={styles.linkRow} type="button" onClick={() => setView('licenses')}>
            <span className={styles.rowLabel}>
              <span className={styles.rowTitle}>오픈소스 라이선스</span>
              <span className={styles.rowHint}>이 게임이 사용한 오픈소스와 외부 에셋 고지</span>
            </span>
            <span className={styles.rowArrow}>›</span>
          </button>
        </div>

        <button className={styles.doneBtn} type="button" onClick={onBack}>
          완료
        </button>
      </div>
    </div>
  )
}
