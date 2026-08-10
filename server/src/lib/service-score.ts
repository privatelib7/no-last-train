import { isVehicleInService } from './vehicle-service'

// 운행 중인 노선·차량이 닿지 않는 역은 시민에게 '대중교통이 없는' 것과 같다.
export const UNSERVED_STATION_SCORE = 0
// 혼잡도 100%라도 열차는 오고 있으므로 무서비스보다는 낫다.
export const MAX_CONGESTION_SCORE = 20

export type ServiceScoreLine = {
  status: string
  lineStations: Array<{ stationId: string }>
  vehicles: Array<{ status: string; isSpare: boolean }>
}

export type ServiceScoreStation = {
  station: { id: string }
  congestion: number
}

// 실제로 승객을 태울 수 있는 노선(운행 중 + 역 2개 이상 + 운행 차량 보유)의 역만 모은다.
export function collectServedStationIds(lines: ServiceScoreLine[]): Set<string> {
  const served = new Set<string>()
  for (const line of lines) {
    if (line.status !== 'OPERATING') continue
    if (line.lineStations.length < 2) continue
    if (!line.vehicles.some(isVehicleInService)) continue
    for (const lineStation of line.lineStations) served.add(lineStation.stationId)
  }
  return served
}

// 서비스 점수는 "시민이 실제로 이동할 수 있는가"를 나타낸다.
// 역이 없거나 노선이 닿지 않으면 아무리 방치해도 만점이 나오지 않도록 0점으로 본다.
export function calcServiceScore(
  snapshots: ServiceScoreStation[],
  lines: ServiceScoreLine[],
): number {
  if (snapshots.length === 0) return UNSERVED_STATION_SCORE

  const served = collectServedStationIds(lines)
  const total = snapshots.reduce((sum, snapshot) => {
    if (!served.has(snapshot.station.id)) return sum + UNSERVED_STATION_SCORE
    // 혼잡도 0 → 100점, 혼잡도 1 → 20점 (선형)
    return sum + Math.max(MAX_CONGESTION_SCORE, 100 - snapshot.congestion * 80)
  }, 0)
  return total / snapshots.length
}
