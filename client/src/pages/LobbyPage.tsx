import { useEffect, useState } from 'react'
import { fetchCities, type LobbyCity } from '../api/cities'
import styles from './LobbyPage.module.css'

interface Props {
  onBack: () => void
}

const PLAYER_LINES = [
  { color: '#E07B35', label: '빨강' },
  { color: '#5B9BD5', label: '파랑' },
  { color: '#5BBD72', label: '초록' },
  { color: '#F5C842', label: '노랑' },
  { color: '#A678D4', label: '보라' },
]

const LINE_COLORS: Record<string, string> = {
  red: '#E07B35',
  blue: '#5B9BD5',
  green: '#5BBD72',
  yellow: '#F5C842',
  purple: '#A678D4',
}

function formatCreatedAt(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

function citySubtitle(city: LobbyCity) {
  const day = `${city.seasonDay}일차`
  const lines = `노선 ${city.lineCount}`
  const created = formatCreatedAt(city.createdAt)
  return created ? `${day} · ${lines} · ${created}` : `${day} · ${lines}`
}

export default function LobbyPage({ onBack }: Props) {
  const [cities, setCities] = useState<LobbyCity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setLoading(true)
        setError(null)
        const data = await fetchCities()
        if (!cancelled) setCities(data)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : '도시 목록을 불러오지 못했습니다.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className={styles.page}>
      <nav className={styles.sidebar}>
        <button className={styles.backBtn} onClick={onBack} title="타이틀로">
          <span className={styles.backArrow}>←</span>
        </button>

        <div className={styles.sidebarDivider} />

        <div className={styles.playerList}>
          {PLAYER_LINES.map((p) => (
            <div
              key={p.label}
              className={styles.playerDot}
              style={{ background: p.color }}
              title={p.label + ' 노선'}
            />
          ))}
        </div>
      </nav>

      <main className={styles.main}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <h1 className={styles.pageTitle}>도시 선택</h1>
            <p className={styles.pageSubtitle}>운영할 도시를 고르세요</p>
          </div>
          <div className={styles.coinDisplay}>
            <span className={styles.coinIcon}>🌕</span>
            <span className={styles.coinAmount}>2,400</span>
          </div>
        </div>

        {loading && <p className={styles.pageSubtitle}>도시 불러오는 중…</p>}
        {error && <p className={styles.errorText}>{error}</p>}

        <div className={styles.cityGrid}>
          {cities.map((city) => {
            const active = city.status === 'ACTIVE'
            return (
              <button
                key={city.id}
                className={`${styles.cityCard} ${active ? styles.cityCardActive : ''}`}
              >
                <div className={styles.activeContent}>
                  <div className={styles.miniMap}>
                    <svg viewBox="0 0 120 80" fill="none" className={styles.miniMapSvg} aria-hidden="true">
                      <path d="M 10 60 Q 30 60 50 40 Q 70 20 110 20" stroke="#E07B35" strokeWidth="3" strokeLinecap="round" />
                      <path d="M 10 70 Q 40 70 70 50 Q 90 35 110 35" stroke="#5B9BD5" strokeWidth="3" strokeLinecap="round" />
                      <path d="M 10 50 L 40 50 Q 60 50 60 30 L 60 20" stroke="#5BBD72" strokeWidth="3" strokeLinecap="round" />
                      <path d="M 30 70 L 30 40" stroke="#F5C842" strokeWidth="3" strokeLinecap="round" />
                      <circle cx="10" cy="60" r="4" fill="#FAFAF7" stroke="#E07B35" strokeWidth="2" />
                      <circle cx="50" cy="40" r="5" fill="#E07B35" />
                      <circle cx="110" cy="20" r="4" fill="#FAFAF7" stroke="#E07B35" strokeWidth="2" />
                      <circle cx="70" cy="50" r="4" fill="#FAFAF7" stroke="#5B9BD5" strokeWidth="2" />
                      <circle cx="60" cy="30" r="4" fill="#FAFAF7" stroke="#5BBD72" strokeWidth="2" />
                      <circle cx="30" cy="60" r="5" fill="#F5C842" />
                    </svg>
                  </div>

                  <div className={styles.cityInfo}>
                    <div className={styles.cityName}>{city.name}</div>
                    <div className={styles.citySub}>{citySubtitle(city)}</div>
                    <div className={styles.lineChips}>
                      {city.lines.map((l) => (
                        <span
                          key={l}
                          className={styles.lineChip}
                          style={{ background: LINE_COLORS[l] ?? '#C4BFB8' }}
                        />
                      ))}
                    </div>
                  </div>

                  {active && (
                    <div className={styles.activeBadge}>
                      <span className={styles.activeDot} />
                      운행 중
                    </div>
                  )}
                </div>
              </button>
            )
          })}

          <button className={styles.newCityCard}>
            <div className={styles.newCityIcon}>+</div>
            <div className={styles.newCityLabel}>새 도시</div>
          </button>
        </div>

        <div className={styles.activitySection}>
          <div className={styles.activityTitle}>최근 활동</div>
          <div className={styles.activityList}>
            {[
              { time: '18분 전', text: '파랑 노선이 예비 차량 1대를 지원했습니다.' },
              { time: '2시간 전', text: '중앙역 혼잡도 84% — AI가 배차 간격을 조정했습니다.' },
              { time: '5시간 전', text: '콘서트 이벤트 종료 · 수송 승객 +312명' },
            ].map((item, i) => (
              <div key={i} className={styles.activityItem}>
                <span className={styles.activityTime}>{item.time}</span>
                <span className={styles.activityText}>{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  )
}
