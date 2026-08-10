import { NextRequest, NextResponse } from 'next/server'
import { authorizeCityAccess } from '@/lib/access'
import { buildCityMotionSnapshot } from '@/lib/city-motion'
import { syncCityClock } from '@/lib/simulation'

// GET /api/cities/[id]/motion
// 클라이언트가 맞춰야 하는 syncTick + 차량 렌더 좌표를 가볍게 내려준다.
// (도시 전체 조회보다 가볍지만, 이 폴링(500ms)이 city GET(2500ms)보다 훨씬 자주
// 돌기 때문에 틱 동기화도 여기서 같이 맞춰야 실제 3초 틱 경계에 가깝게 전진한다.
// 그러지 않으면 city GET 폴링 타이밍에 따라 틱이 몰아서 처리되고, 그 결과가
// 클라이언트 미리보기와 어긋나며 차량이 순간 가속하는 것처럼 보인다.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const auth = await authorizeCityAccess(req, id)
  if (auth.error) return auth.error

  try {
    await syncCityClock(id)
  } catch (err) {
    console.error(`[cities/${id}/motion] syncCityClock failed`, err)
  }

  const snapshot = await buildCityMotionSnapshot(id)
  if (!snapshot) {
    return NextResponse.json({ error: '도시를 찾을 수 없습니다.' }, { status: 404 })
  }

  return NextResponse.json(snapshot, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
