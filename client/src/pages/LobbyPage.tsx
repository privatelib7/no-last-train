import { useEffect, useState } from 'react'
import { fetchCities, type LobbyCity } from '../api/cities'
import { fetchRecentActivity, type ActivityItem } from '../api/activity'
import type { AuthSession } from '../api/auth'
import { unlockBgm } from '../lib/bgm'
import NewCityModal from './NewCityModal'
import styles from './LobbyPage.module.css'

const ACTIVITY_POLL_MS = 5000

interface Props {
  session: AuthSession | null
  onBack: () => void
  onSelectCity: (cityId: string) => void
  onLogout: () => void
  onOpenSettings: () => void
}

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
  return created ? `${city.name} · ${day} · ${lines} · ${created}` : `${city.name} · ${day} · ${lines}`
}

function formatRelativeTime(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000))
  if (diffSec < 60) return '방금 전'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}분 전`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}시간 전`
  return formatCreatedAt(iso)
}

export default function LobbyPage({ session, onBack, onSelectCity, onLogout, onOpenSettings }: Props) {
  const [cities, setCities] = useState<LobbyCity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showNewCityModal, setShowNewCityModal] = useState(false)

  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [activityLoading, setActivityLoading] = useState(true)
  const [activityError, setActivityError] = useState<string | null>(null)

  useEffect(() => {
    // 타이틀 "시작"에서 이미 켰을 수도 있고, 인게임→로비 복귀 시에도 재생을 재시도한다.
    unlockBgm()
  }, [])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setLoading(true)
        setError(null)
        const data = await fetchCities(session?.token)
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

  // 로그인한 본인이 접근 가능한 방(도시)에서 최근 24시간 안에 일어난 활동만 실시간(폴링)으로 보여준다.
  useEffect(() => {
    if (!session) {
      setActivityLoading(false)
      return
    }
    let cancelled = false

    const load = async (isFirst: boolean) => {
      try {
        if (isFirst) setActivityLoading(true)
        const data = await fetchRecentActivity(session.token)
        if (!cancelled) {
          setActivity(data)
          setActivityError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setActivityError(e instanceof Error ? e.message : '최근 활동을 불러오지 못했습니다.')
        }
      } finally {
        if (!cancelled && isFirst) setActivityLoading(false)
      }
    }

    void load(true)
    const timer = window.setInterval(() => void load(false), ACTIVITY_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [session])

  return (
    <div className={styles.page}>
      <nav className={styles.sidebar}>
        <button className={styles.backBtn} onClick={onBack} title="타이틀로">
          <span className={styles.backArrow}>←</span>
        </button>
        <button className={styles.settingsBtn} onClick={onOpenSettings} title="설정" aria-label="설정">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </nav>

      <main className={styles.main}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <h1 className={styles.pageTitle}>관제실 선택</h1>
            <p className={styles.pageSubtitle}>도시 운영에 참여할 관제실을 선택하세요.</p>
          </div>
          <div className={styles.headerRight}>
            <button
              className={styles.newCityBtn}
              onClick={() => session && setShowNewCityModal(true)}
              disabled={!session}
              type="button"
              title={session ? undefined : '로그인이 필요합니다'}
            >
              <span className={styles.newCityBtnIcon}>+</span>
              새 관제실
            </button>
            {session && (
              <div className={styles.userBadge}>
                <span className={styles.userNameWrap}>
                  <span className={styles.userName}>{session.nickname ?? session.username}</span>
                  {session.email && (
                    <span className={styles.userTooltip} role="tooltip">
                      {session.email}
                    </span>
                  )}
                </span>
                <button className={styles.logoutBtn} onClick={onLogout} type="button">
                  로그아웃
                </button>
              </div>
            )}
          </div>
        </div>

        {loading && <p className={styles.pageSubtitle}>관제실 불러오는 중…</p>}
        {error && <p className={styles.errorText}>{error}</p>}

        {!loading && !error && cities.length === 0 && (
          <p className={styles.emptyText}>아직 만든 관제실이 없어요. 새 관제실을 시작해보세요.</p>
        )}

        <div className={styles.cityList}>
          {cities.map((city) => {
            const active = city.status === 'ACTIVE'
            return (
              <button
                key={city.id}
                className={`${styles.cityRow} ${active ? styles.cityRowActive : ''}`}
                onClick={() => active && onSelectCity(city.id)}
                disabled={!active}
                aria-label={`${city.roomTitle} (${city.name}) 도시 운영 시작`}
              >
                <div className={styles.cityRowIcon}>
                  {city.lines.length > 0 ? (
                    city.lines.slice(0, 4).map((l) => (
                      <span key={l} className={styles.lineDot} style={{ background: LINE_COLORS[l] ?? '#C4BFB8' }} />
                    ))
                  ) : (
                    <span className={styles.lineDotEmpty} />
                  )}
                </div>

                <div className={styles.cityRowInfo}>
                  <div className={styles.cityName}>{city.roomTitle}</div>
                  <div className={styles.citySub}>{citySubtitle(city)}</div>
                </div>

                {active && (
                  <div className={styles.activeBadge}>
                    <span className={styles.activeDot} />
                    운행 중
                  </div>
                )}

                <span className={styles.cityRowChevron} aria-hidden="true">
                  ›
                </span>
              </button>
            )
          })}
        </div>

        {showNewCityModal && session && (
          <NewCityModal
            playerToken={session.token}
            onClose={() => setShowNewCityModal(false)}
            onCreated={(cityId) => {
              setShowNewCityModal(false)
              onSelectCity(cityId)
            }}
          />
        )}

        <div className={styles.activitySection}>
          <div className={styles.activityTitle}>최근 활동</div>

          {!session && <p className={styles.activityEmpty}>로그인하면 내 방들의 최근 활동을 볼 수 있어요.</p>}
          {session && activityLoading && <p className={styles.activityEmpty}>활동 불러오는 중…</p>}
          {session && activityError && <p className={styles.errorText}>{activityError}</p>}
          {session && !activityLoading && !activityError && activity.length === 0 && (
            <p className={styles.activityEmpty}>최근 24시간 동안 활동이 없어요.</p>
          )}

          {session && !activityLoading && activity.length > 0 && (
            <div className={styles.activityList}>
              {activity.map((item) => (
                <div key={item.id} className={styles.activityItem}>
                  <span className={styles.activityTime}>{formatRelativeTime(item.createdAt)}</span>
                  <span className={styles.activityText}>
                    <button
                      type="button"
                      className={styles.activityRoom}
                      onClick={() => onSelectCity(item.cityId)}
                      title={`${item.roomTitle} 관제실로 이동`}
                    >
                      {item.roomTitle}
                    </button>
                    {' · '}
                    {item.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
