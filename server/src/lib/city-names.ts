/** 선택 가능한 도시(맵) 이름 풀 */
export const CITY_NAMES = [
  '부산',
  '서울',
] as const

export type CityName = (typeof CITY_NAMES)[number]

const ROOM_TITLE_ADJECTIVES = [
  '심야',
  '막차',
  '첫차',
  '혼잡',
  '긴급',
  '순환',
  '환승',
  '출근',
  '퇴근',
  '돌발',
  '해무',
  '폭우',
  '고속',
  '지하',
  '야간',
] as const

const ROOM_TITLE_NOUNS = [
  '관제실',
  '운영실',
  '사령실',
  '배차실',
  '통제실',
  '노선팀',
  '차고지',
  '종착역',
  '환승허브',
  '승강장',
] as const

function pickOne<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

export function pickRandomCityName(): CityName {
  return pickOne(CITY_NAMES)
}

/** 게임 톤의 랜덤 방제목 (예: 심야 관제실) */
export function pickRandomRoomTitle(): string {
  return `${pickOne(ROOM_TITLE_ADJECTIVES)} ${pickOne(ROOM_TITLE_NOUNS)}`
}

export function isCityName(value: string): value is CityName {
  return (CITY_NAMES as readonly string[]).includes(value)
}
