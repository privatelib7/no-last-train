import { useState } from 'react'
import TitlePage from './pages/TitlePage'
import LobbyPage from './pages/LobbyPage'
import GamePage from './pages/GamePage'

type Page = 'title' | 'lobby' | 'game'

const ACTIVE_CITY_KEY = 'nlt.activeCityId'

export default function App() {
  const [activeCityId, setActiveCityId] = useState<string | null>(() =>
    window.localStorage.getItem(ACTIVE_CITY_KEY),
  )
  const [page, setPage] = useState<Page>(() => activeCityId ? 'game' : 'title')

  const enterCity = (cityId: string) => {
    window.localStorage.setItem(ACTIVE_CITY_KEY, cityId)
    setActiveCityId(cityId)
    setPage('game')
  }

  const leaveCity = () => {
    window.localStorage.removeItem(ACTIVE_CITY_KEY)
    setActiveCityId(null)
    setPage('lobby')
  }

  return (
    <>
      {page === 'title' && <TitlePage onStart={() => setPage('lobby')} />}
      {page === 'lobby' && (
        <LobbyPage onBack={() => setPage('title')} onSelectCity={enterCity} />
      )}
      {page === 'game' && activeCityId && (
        <GamePage cityId={activeCityId} onBack={leaveCity} />
      )}
    </>
  )
}
