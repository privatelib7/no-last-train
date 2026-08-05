import { useState } from 'react'
import TitlePage from './pages/TitlePage'
import LobbyPage from './pages/LobbyPage'

type Page = 'title' | 'lobby'

export default function App() {
  const [page, setPage] = useState<Page>('title')

  return (
    <>
      {page === 'title' && <TitlePage onStart={() => setPage('lobby')} />}
      {page === 'lobby' && <LobbyPage onBack={() => setPage('title')} />}
    </>
  )
}
