// 도시별 맵 지오메트리 (viewBox 0~100 기준)

export type CityMapDef = {
  key: string
  name: string
  landPath: string
  islandPaths: string[]
  rivers: Array<{ d: string; width: number; opacity: number }>
  mountainPaths: string[]
  districts: Array<{ x: number; y: number; label: string }>
  isLand: (x: number, y: number) => boolean
}

// ─── 부산 ───────────────────────────────────────────────────────────────

const BUSAN_LAND_PATH = 'M0 0H100V35C98 41 99 46 95 50C92 54 94 59 90 63C86 66 83 63 79 67C75 71 70 67 66 72C62 76 57 73 53 79C49 85 44 80 39 84C34 88 29 83 23 87C15 92 8 87 0 89Z'
const YEONGDO_PATH = 'M42 87C46 84 51 86 53 91C50 96 43 97 39 92Z'

const BUSAN_COAST: Array<[number, number]> = [
  [0, 89], [15, 92], [23, 87], [29, 83], [34, 88], [39, 84], [44, 80],
  [49, 85], [53, 79], [57, 73], [62, 76], [66, 72], [70, 67], [75, 71],
  [79, 67], [83, 63], [86, 66], [90, 63], [92, 54], [95, 50], [98, 41], [100, 35],
]

function busanCoastY(x: number) {
  for (let index = 1; index < BUSAN_COAST.length; index++) {
    const [leftX, leftY] = BUSAN_COAST[index - 1]
    const [rightX, rightY] = BUSAN_COAST[index]
    if (x <= rightX) {
      const ratio = (x - leftX) / (rightX - leftX)
      return leftY + (rightY - leftY) * ratio
    }
  }
  return 35
}

const BUSAN: CityMapDef = {
  key: 'BUSAN',
  name: '부산',
  landPath: BUSAN_LAND_PATH,
  islandPaths: [YEONGDO_PATH],
  rivers: [
    { d: 'M19 -4C17 15 23 27 20 42C17 57 22 70 17 90', width: 3.8, opacity: 0.9 },
    { d: 'M72 28C70 40 74 49 70 61C68 68 71 73 70 78', width: 1.8, opacity: 0.72 },
  ],
  mountainPaths: [
    'M28 17L35 6L41 18Z',
    'M48 22L56 8L64 22Z',
    'M70 20L77 9L84 22Z',
  ],
  districts: [
    { x: 9, y: 47, label: '강서구' },
    { x: 29, y: 41, label: '사상구' },
    { x: 47, y: 49, label: '부산진구' },
    { x: 57, y: 29, label: '동래구' },
    { x: 72, y: 45, label: '수영구' },
    { x: 84, y: 48, label: '해운대구' },
    { x: 43, y: 94, label: '영도' },
  ],
  isLand(x, y) {
    const onMainland = x >= 0 && x <= 100 && y >= 0 && y <= busanCoastY(x)
    const onYeongdo = x >= 39 && x <= 53 && y >= 84 && y <= 97
    return onMainland || onYeongdo
  },
}

// ─── 서울 ───────────────────────────────────────────────────────────────

// 한강 중심선 (동→서)
const HAN_RIVER: Array<[number, number]> = [
  [0, 56], [10, 53], [18, 50], [28, 46], [40, 44], [52, 48],
  [64, 52], [76, 50], [88, 44], [100, 40],
]
const HAN_HALF_WIDTH = 2.6

function hanRiverY(x: number) {
  for (let index = 1; index < HAN_RIVER.length; index++) {
    const [leftX, leftY] = HAN_RIVER[index - 1]
    const [rightX, rightY] = HAN_RIVER[index]
    if (x <= rightX) {
      const ratio = (x - leftX) / (rightX - leftX)
      return leftY + (rightY - leftY) * ratio
    }
  }
  return 40
}

const SEOUL: CityMapDef = {
  key: 'SEOUL',
  name: '서울',
  // 내륙 도시 — 맵 전체가 땅
  landPath: 'M0 0H100V100H0Z',
  // 여의도
  islandPaths: ['M20 48C23 46.6 27 46.8 29 48.4C27.5 50.2 22.5 50.4 20 49.4Z'],
  rivers: [
    { d: `M${HAN_RIVER.map(([x, y]) => `${x} ${y}`).join('L')}`, width: HAN_HALF_WIDTH * 2, opacity: 0.9 },
    // 중랑천
    { d: 'M68 4C67 16 70 28 68 40C67 45 66 48 65 51', width: 1.4, opacity: 0.7 },
    // 안양천
    { d: 'M14 96C15 84 13 72 15 60C15.5 57 16 54 17 51', width: 1.4, opacity: 0.7 },
  ],
  mountainPaths: [
    'M30 14L38 3L46 14Z',   // 북한산
    'M52 12L58 4L64 12Z',   // 도봉·수락
    'M36 92L44 81L52 92Z',  // 관악산
    'M84 26L89 19L94 26Z',  // 아차산
  ],
  districts: [
    { x: 10, y: 42, label: '은평구' },
    { x: 24, y: 38, label: '마포구' },
    { x: 42, y: 28, label: '종로구' },
    { x: 46, y: 39, label: '용산구' },
    { x: 66, y: 22, label: '노원구' },
    { x: 80, y: 36, label: '광진구' },
    { x: 22, y: 62, label: '영등포구' },
    { x: 44, y: 66, label: '동작구' },
    { x: 62, y: 62, label: '강남구' },
    { x: 80, y: 58, label: '송파구' },
    { x: 25, y: 49, label: '여의도' },
  ],
  isLand(x, y) {
    if (x < 0 || x > 100 || y < 0 || y > 100) return false
    const inRiver = Math.abs(y - hanRiverY(x)) < HAN_HALF_WIDTH
    const onYeouido = x >= 20 && x <= 29 && Math.abs(y - hanRiverY(x)) < 1.6
    return !inRiver || onYeouido
  },
}

export const CITY_MAPS: Record<string, CityMapDef> = { BUSAN, SEOUL }

export function getCityMap(key: string | null | undefined): CityMapDef {
  return CITY_MAPS[key ?? ''] ?? BUSAN
}
