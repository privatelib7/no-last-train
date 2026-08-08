import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // API 전용 서버 — 페이지 빌드 불필요
  output: 'standalone',

  // Prisma / pg 는 workerd 전용 export를 쓰도록 번들에서 빼고
  // OpenNext가 node_modules 그대로 옮기게 한다.
  serverExternalPackages: ['@prisma/client', '.prisma/client', 'pg', '@prisma/adapter-pg'],
}

export default nextConfig
