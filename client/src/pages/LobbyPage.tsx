import { useEffect, useState } from 'react'
import { fetchCities, type LobbyCity } from '../api/cities'
import { fetchRecentActivity, type ActivityItem } from '../api/activity'
import type { AuthSession } from '../api/auth'
import NewCityModal from './NewCityModal'
import styles from './LobbyPage.module.css'

const ACTIVITY_POLL_MS = 5000

interface Props {
  session: AuthSession | null
  onBack: () => void
  onSelectCity: (cityId: string) => void
  onLogout: () => void
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

export default function LobbyPage({ session, onBack, onSelectCity, onLogout }: Props) {
  const [cities, setCities] = useState<LobbyCity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showNewCityModal, setShowNewCityModal] = useState(false)

  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [activityLoading, setActivityLoading] = useState(true)
  const [activityError, setActivityError] = useState<string | null>(null)

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
