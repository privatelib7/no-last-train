import { NextResponse } from 'next/server'
import { CITY_NAMES } from '@/lib/city-names'

// GET /api/cities/names — 랜덤 배정에 쓰이는 도시 이름 풀
export async function GET() {
  return NextResponse.json({ names: [...CITY_NAMES] })
}
