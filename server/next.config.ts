import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // API 전용 서버 — 페이지 빌드 불필요
  output: 'standalone',
}

export default nextConfig
