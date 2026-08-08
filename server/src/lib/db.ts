// 생성된 클라이언트를 쓴다. 같은 경로에 런타임별로 다른 벌이 생성된다
// (prisma/schema.prisma의 generator 두 개 참고):
//   로컬/시드      → runtime "nodejs"
//   Cloudflare 빌드 → runtime "workerd" (wasm 엔진을 모듈로 import)
// 어느 쪽이든 드라이버 어댑터가 실제 연결을 담당한다.
import { PrismaClient } from '@/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

// Cloudflare Workers(workerd)는 동적 코드 생성을 금지하므로 Prisma 기본
// 쿼리 엔진이 "Code generation from strings disallowed for this context"로
// 실패한다. pg 드라이버 어댑터를 쓰면 쿼리가 순수 JS 경로로 나가 동작한다.
// 어댑터는 로컬(Node)에서도 그대로 동작하므로 환경을 분기하지 않는다.
function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL이 설정되지 않았습니다.')

  const pool = new Pool({
    connectionString,
    // Workers의 isolate 하나가 커넥션을 오래 붙들지 않도록 작게 잡는다.
    max: 1,
  })

  return new PrismaClient({
    adapter: new PrismaPg(pool),
    log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
  })
}

export const db = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
}
