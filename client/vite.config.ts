import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const DEFAULT_API_PROXY_TARGET = 'http://localhost:3001'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // vite.config.ts는 Node에서 실행되므로 VITE_ 접두사 없는 변수도 읽을 수 있다.
  // 프록시 주소는 dev 서버 전용이라 클라이언트 번들에 노출할 필요가 없어 접두사를 붙이지 않는다.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: env.API_PROXY_TARGET || DEFAULT_API_PROXY_TARGET,
          changeOrigin: true,
        },
      },
    },
  }
})
