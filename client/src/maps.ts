// 도시별 맵 지오메트리 (viewBox 0~100 기준)

export type ZoneKind = 'residential' | 'commercial' | 'industrial'

export type Zone = {
  kind: ZoneKind
  points: Array<[number, number]>
}

export type CityMapDef = {
  key: string
  name: string
  landPath: string
  islandPaths: string[]
  rivers: Array<{ d: string; width: number; opacity: number }>
  mountainPaths: string[]
  districts: Array<{ x: number; y: number; label: string }>
  zones: Zone[]
  isLand: (x: number, y: number) => boolean
}

export function polyPath(points: Array<[number, number]>) {
  return `M${points.map(([x, y]) => `${x} ${y}`).join('L')}Z`
}

// ray-cast 점-폴리곤 내부 판정
export function pointInPolygon(x: number, y: number, points: Array<[number, number]>) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

// ─── 부산 ───────────────────────────────────────────────────────────────
// 실제 부산 형태: 북동쪽 기장군, 서쪽 강서구(낙동강), 동남 해안, 남쪽 영도

const BUSAN_BOUNDARY: Array<[number, number]> = [
  [36, 26], [44, 18], [50, 8], [60, 6], [64, 14], [72, 8], [82, 4], [90, 10],
  [86, 20], [92, 28], [88, 38], [80, 44], [84, 50], [74, 58], [68, 56], [64, 66],
  [56, 72], [52, 80], [44, 86], [40, 94], [32, 88], [26, 92], [16, 84], [10, 72],
  [14, 62], [10, 52], [18, 44], [16, 36], [26, 32], [30, 36],
]

const YEONGDO_POLY: Array<[number, number]> = [[48, 84], [54, 82], [58, 86], [54, 92], [48, 90]]

// 낙동강 중심선 (북→남)
const NAKDONG: Array<[number, number]> = [
  [34, 24], [33, 34], [34, 44], [32, 54], [30, 64], [31, 74], [29, 84], [28, 94],
]
const NAKDONG_HALF_WIDTH = 2.0

function nakdongX(y: number) {
  for (let index = 1; index < NAKDONG.length; index++) {
    const [topX, topY] = NAKDONG[index - 1]
    const [bottomX, bottomY] = NAKDONG[index]
    if (y <= bottomY) {
      const ratio = (y - topY) / (bottomY - topY)
      return topX + (bottomX - topX) * ratio
    }
  }
  return 28
}

const BUSAN: CityMapDef = {
  key: 'BUSAN',
  name: '부산',
  landPath: polyPath(BUSAN_BOUNDARY),
  islandPaths: [polyPath(YEONGDO_POLY)],
  rivers: [
    { d: `M${NAKDONG.map(([x, y]) => `${x} ${y}`).join('L')}`, width: NAKDONG_HALF_WIDTH * 2, opacity: 0.9 },
    // 수영강
    { d: 'M70 28C69 36 71 42 69 50C68 54 69 56 68 58', width: 1.4, opacity: 0.72 },
  ],
  mountainPaths: [
    'M46 24L52 14L58 24Z',   // 금정산
    'M72 34L77 26L82 34Z',   // 장산
    'M34 68L39 60L44 68Z',   // 구덕산
  ],
  districts: [
    { x: 78, y: 16, label: '기장군' },
    { x: 54, y: 20, label: '금정구' },
    { x: 42, y: 32, label: '북구' },
    { x: 16, y: 66, label: '강서구' },
    { x: 38, y: 58, label: '사상구' },
    { x: 58, y: 38, label: '동래구' },
    { x: 78, y: 46, label: '해운대구' },
    { x: 66, y: 60, label: '수영구' },
    { x: 44, y: 70, label: '중구' },
    { x: 32, y: 80, label: '사하구' },
    { x: 53, y: 88, label: '영도' },
  ],
  zones: [
    // 주거: 북구/화명, 동래/연제
    { kind: 'residential', points: [[38, 30], [48, 32], [50, 42], [42, 44], [36, 38]] },
    { kind: 'residential', points: [[48, 40], [60, 42], [62, 50], [52, 52], [46, 46]] },
    // 상업: 서면(부산진), 남포/광복
    { kind: 'commercial', points: [[46, 52], [56, 54], [58, 62], [50, 64], [44, 58]] },
    { kind: 'commercial', points: [[42, 68], [50, 70], [50, 78], [44, 78], [40, 72]] },
    // 산업: 사상공단(낙동강변), 강서/녹산, 센텀
    { kind: 'industrial', points: [[36, 46], [41, 48], [41, 60], [36, 62]] },
    { kind: 'industrial', points: [[14, 62], [22, 60], [24, 72], [16, 74]] },
    { kind: 'industrial', points: [[62, 46], [70, 48], [72, 54], [64, 56]] },
  ],
  isLand(x, y) {
    const onYeongdo = pointInPolygon(x, y, YEONGDO_POLY)
    if (onYeongdo) return true
    if (!pointInPolygon(x, y, BUSAN_BOUNDARY)) return false
    const inRiver = Math.abs(x - nakdongX(y)) < NAKDONG_HALF_WIDTH
    return !inRiver
  },
}

// ─── 서울 ───────────────────────────────────────────────────────────────

// 한강 중심선 (서→동): 도심 아래로 내려왔다가 동쪽에서 올라감
const HAN_RIVER: Array<[number, number]> = [
  [0, 47], [12, 46], [24, 47], [32, 50], [40, 56], [50, 60],
  [60, 59], [70, 55], [80, 51], [88, 48], [98, 50],
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

// 서울시 경계 (실제 형태 단순화, 시계 방향)
// 북부 강북 덩어리 → 동쪽 강동 날개 → 남부 로브 → 서쪽 강서 날개
const SEOUL_BOUNDARY: Array<[number, number]> = [
  [22, 43], [18, 36], [20, 28], [28, 22], [36, 18], [42, 10], [50, 14], [54, 6],
  [62, 4], [66, 11], [72, 6], [80, 8], [84, 16], [82, 24], [88, 30], [86, 38],
  [90, 44], [86, 47],
  [92, 49], [96, 56], [90, 63],
  [82, 69], [74, 73], [68, 81], [60, 79], [54, 88], [46, 83], [40, 90], [33, 86],
  [27, 78], [22, 69],
  [14, 62], [6, 54], [6, 48], [12, 44], [20, 42], [28, 45],
]

const SEOUL: CityMapDef = {
  key: 'SEOUL',
  name: '서울',
  landPath: polyPath(SEOUL_BOUNDARY),
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
    'M42 22L49 13L56 22Z',  // 북한산
    'M58 18L63 10L69 18Z',  // 도봉·수락
    'M40 84L46 76L53 84Z',  // 관악산
    'M84 42L88 36L92 43Z',  // 아차산
  ],
  districts: [
    { x: 30, y: 30, label: '은평구' },
    { x: 33, y: 43, label: '마포구' },
    { x: 47, y: 27, label: '종로구' },
    { x: 48, y: 44, label: '용산구' },
    { x: 70, y: 20, label: '노원구' },
    { x: 77, y: 45, label: '광진구' },
    { x: 88, y: 58, label: '강동구' },
    { x: 13, y: 50, label: '강서구' },
    { x: 27, y: 57, label: '영등포구' },
    { x: 46, y: 68, label: '동작구' },
    { x: 62, y: 66, label: '강남구' },
    { x: 76, y: 62, label: '송파구' },
    { x: 24, y: 50, label: '여의도' },
  ],
  zones: [
    // 주거: 노원/도봉, 은평/서대문, 강서, 관악/동작, 강동/송파
    { kind: 'residential', points: [[62, 8], [76, 10], [80, 18], [74, 26], [64, 24], [60, 16]] },
    { kind: 'residential', points: [[22, 26], [32, 22], [36, 32], [30, 40], [22, 36]] },
    { kind: 'residential', points: [[8, 52], [17, 50], [21, 56], [17, 63], [9, 59]] },
    { kind: 'residential', points: [[40, 68], [50, 70], [50, 78], [42, 82], [37, 76]] },
    { kind: 'residential', points: [[84, 53], [90, 52], [92, 58], [86, 64], [81, 60]] },
    // 상업: 종로/중구 도심, 강남, 여의도/영등포, 홍대/마포, 잠실
    { kind: 'commercial', points: [[38, 22], [50, 20], [54, 30], [48, 38], [40, 36]] },
    { kind: 'commercial', points: [[54, 56], [68, 58], [72, 66], [60, 72], [52, 64]] },
    { kind: 'commercial', points: [[20, 54], [28, 51], [31, 58], [26, 65], [19, 62]] },
    { kind: 'commercial', points: [[22, 39], [28, 37], [30, 42], [25, 44], [21, 41]] },
    { kind: 'commercial', points: [[71, 58], [79, 56], [82, 61], [76, 64], [70, 62]] },
    // 산업·오피스: 구로/금천(G밸리)~문래, 청량리/성수
    { kind: 'industrial', points: [[22, 62], [32, 66], [33, 76], [27, 77], [22, 70]] },
    { kind: 'industrial', points: [[58, 24], [70, 26], [72, 34], [62, 38], [56, 30]] },
  ],
  isLand(x, y) {
    if (!pointInPolygon(x, y, SEOUL_BOUNDARY)) return false
    const inRiver = Math.abs(y - hanRiverY(x)) < HAN_HALF_WIDTH
    const onYeouido = x >= 20 && x <= 29 && Math.abs(y - hanRiverY(x)) < 1.6
    return !inRiver || onYeouido
  },
}

export const CITY_MAPS: Record<string, CityMapDef> = { BUSAN, SEOUL }

export function getCityMap(key: string | null | undefined): CityMapDef {
  return CITY_MAPS[key ?? ''] ?? BUSAN
}
