import { useEffect, useState } from 'react'
import TitlePage from './pages/TitlePage'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import VerifyEmailPage from './pages/VerifyEmailPage'
import ForgotPasswordPage from './pages/ForgotPasswordPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import SettingsPage from './pages/SettingsPage'
import LobbyPage from './pages/LobbyPage'
import GamePage from './pages/GamePage'
import { fetchMe, type AuthSession } from './api/auth'
import './App.css'

type Page = 'title' | 'login' | 'register' | 'verify' | 'forgot' | 'reset' | 'settings' | 'lobby' | 'game'

const ACTIVE_CITY_KEY = 'nlt.activeCityId'
const SESSION_KEY = 'nlt.session'
const CITY_QUERY_KEY = 'city'

function loadSession(): AuthSession | null {
  const raw = window.localStorage.getItem(SESSION_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as AuthSession
  } catch {
    return null
  }
}

function readVerifyToken(): string | null {
  return new URLSearchParams(window.location.search).get('verifyToken')
}

function readResetToken(): string | null {
  return new URLSearchParams(window.location.search).get('resetToken')
}

function readCityIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get(CITY_QUERY_KEY)
}

// 타이틀 → 로비 → 인게임 3단계 흐름을 브라우저 히스토리에 실어서
// 뒤로가기(Alt+←, 마우스/트랙패드 제스처 포함)로도 화면 간 이동이 되게 한다.
type NavState = { page: 'title' } | { page: 'lobby' } | { page: 'game'; cityId: string }

function buildUrlForNav(next: NavState): string {
  const url = new URL(window.location.href)
  if (next.page === 'game') url.searchParams.set(CITY_QUERY_KEY, next.cityId)
  else url.searchParams.delete(CITY_QUERY_KEY)
  url.searchParams.delete('verifyToken')
  url.searchParams.delete('resetToken')
  return url.toString()
}

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(() => loadSession())
  // 주소창의 ?city= 만 복원한다. localStorage만으로는 타이틀을 건너뛰지 않는다.
  const [activeCityId, setActiveCityId] = useState<string | null>(() => readCityIdFromUrl())
  const [verifyToken] = useState<string | null>(() => readVerifyToken())
  const [resetToken] = useState<string | null>(() => readResetToken())
  const [page, setPage] = useState<Page>(() => {
    if (readVerifyToken()) return 'verify'
    if (readResetToken()) return 'reset'
    return readCityIdFromUrl() ? 'game' : 'title'
  })
  // 설정 화면에서 닫기를 눌렀을 때 타이틀/로비 중 어디서 열었는지로 되돌아가기 위해 기억해둔다.
  const [settingsReturnPage, setSettingsReturnPage] = useState<'title' | 'lobby'>('title')
  const applyNavState = (next: NavState) => {
    if (next.page === 'game') {
      window.localStorage.setItem(ACTIVE_CITY_KEY, next.cityId)
      setActiveCityId(next.cityId)
    } else {
      window.localStorage.removeItem(ACTIVE_CITY_KEY)
      setActiveCityId(null)
    }
    setPage(next.page)
  }

  // 새 화면으로 "이동"할 때마다 히스토리 항목을 쌓는다 — 브라우저 뒤로가기가 곧 이전 화면으로 가는 길이 되도록.
  const navigate = (next: NavState) => {
    window.history.pushState(next, '', buildUrlForNav(next))
    applyNavState(next)
  }

  // 처음 로드된 화면(타이틀 또는 공유 링크로 들어온 인게임)을 히스토리 맨 밑단으로 기록해둔다.
  useEffect(() => {
    if (page === 'game' && activeCityId) {
      window.history.replaceState({ page: 'game', cityId: activeCityId } satisfies NavState, '', window.location.href)
    } else if (page === 'title') {
      window.history.replaceState({ page: 'title' } satisfies NavState, '', window.location.href)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const state = event.state as NavState | null
      if (state && (state.page === 'title' || state.page === 'lobby' || state.page === 'game')) {
        applyNavState(state)
      } else {
        applyNavState({ page: 'title' })
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // 공유/새로고침용: URL에 city가 있을 때만 로컬에도 남겨 둔다.
    if (activeCityId) window.localStorage.setItem(ACTIVE_CITY_KEY, activeCityId)
    else window.localStorage.removeItem(ACTIVE_CITY_KEY)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!session) return
    fetchMe(session.token)
      .then((me) => {
        // 예전에 저장된 세션(email 필드 도입 전)도 최신 정보로 보강한다.
        if (me.email !== session.email || me.nickname !== session.nickname) {
          const merged: AuthSession = { ...session, email: me.email, nickname: me.nickname }
          window.localStorage.setItem(SESSION_KEY, JSON.stringify(merged))
          setSession(merged)
        }
      })
      .catch(() => {
        window.localStorage.removeItem(SESSION_KEY)
        setSession(null)
        // 공유 링크로 들어와 도시를 보고 있는 중이라면 로그인 세션 만료와 무관하게 유지한다.
        setPage((p) => (p === 'game' || p === 'verify' ? p : 'title'))
      })
    // 세션 검증은 앱 시작 시 1회만 수행한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleAuthed = (next: AuthSession) => {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(next))
    setSession(next)
    // 공유 링크로 들어와 로그인이 필요했던 경우, 로그인 후 원래 도시로 되돌아간다.
    navigate(activeCityId ? { page: 'game', cityId: activeCityId } : { page: 'lobby' })
  }

  const handleStart = () => {
    if (session) navigate({ page: 'lobby' })
    else setPage('login')
  }

  const handleLogout = () => {
    window.localStorage.removeItem(SESSION_KEY)
    setSession(null)
    navigate({ page: 'title' })
  }

  const goLoginFromVerify = () => {
    const url = new URL(window.location.href)
    url.searchParams.delete('verifyToken')
    window.history.replaceState(null, '', url.toString())
    setPage('login')
  }

  const goLoginFromReset = () => {
    const url = new URL(window.location.href)
    url.searchParams.delete('resetToken')
    window.history.replaceState(null, '', url.toString())
    setPage('login')
  }

  const enterCity = (cityId: string) => navigate({ page: 'game', cityId })

  const leaveCity = () => navigate({ page: 'lobby' })

  return (
    <>
      {page === 'title' && (
        <TitlePage
          onStart={handleStart}
          onOpenSettings={() => {
            setSettingsReturnPage('title')
            setPage('settings')
          }}
        />
      )}
      {page === 'settings' && <SettingsPage onBack={() => setPage(settingsReturnPage)} />}
      {page === 'verify' && verifyToken && (
        <VerifyEmailPage token={verifyToken} onGoLogin={goLoginFromVerify} />
      )}
      {page === 'reset' && resetToken && (
        <ResetPasswordPage token={resetToken} onGoLogin={goLoginFromReset} />
      )}
      {page === 'login' && (
        <LoginPage
          onBack={() => setPage('title')}
          onGoRegister={() => setPage('register')}
          onGoForgotPassword={() => setPage('forgot')}
          onLoggedIn={handleAuthed}
        />
      )}
      {page === 'register' && (
        <RegisterPage onBack={() => setPage('title')} onGoLogin={() => setPage('login')} />
      )}
      {page === 'forgot' && (
        <ForgotPasswordPage onBack={() => setPage('login')} onGoLogin={() => setPage('login')} />
      )}
      {page === 'lobby' && (
        <LobbyPage
          session={session}
          onBack={() => navigate({ page: 'title' })}
          onSelectCity={enterCity}
          onLogout={handleLogout}
          onOpenSettings={() => {
            setSettingsReturnPage('lobby')
            setPage('settings')
          }}
        />
      )}
      {page === 'game' && activeCityId && (
        <GamePage
          cityId={activeCityId}
          session={session}
          onBack={leaveCity}
          onRequireLogin={() => setPage('login')}
        />
      )}
    </>
  )
}
