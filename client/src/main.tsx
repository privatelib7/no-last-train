import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initBgm } from './lib/bgm'
import { installLocalDebugLogging } from './lib/local-debug'
import { applyTheme, loadSettings } from './lib/settings'

installLocalDebugLogging()

// 렌더 전에 적용해 다크모드 사용자가 밝은 화면을 잠깐 보는 깜빡임을 방지한다.
applyTheme(loadSettings().theme)
initBgm()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
