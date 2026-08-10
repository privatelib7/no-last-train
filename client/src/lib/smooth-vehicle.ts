/**
 * 서버가 500ms마다 보내는 motion 좌표(x/y)를 목표로 두고, 그 사이를 순항 속도에
 * 최대한 맞춰 선형으로 이어 그린다. 서버 값 자체가 물리 계산 결과이므로, 두 목표
 * 사이의 거리는 이미 "순항 속도 × 방송 간격"과 거의 정확히 같다 — 그래서 배속을
 * 크게 주면(예전엔 1.15배) 오히려 목표에 일찍 도달해 남은 시간 동안 멈춰 있다가
 * 다음 목표가 오는 "몰아가다 멈칫"이 매 방송마다 반복돼 버벅여 보였다.
 * 배속을 1에 아주 가깝게(지연 누적 방지용 약간의 여유만) 둬서, 도착 시점이 다음
 * 방송 시점과 거의 맞아떨어지게 한다.
 */

export type SmoothPoint = { x: number; y: number }

type LastMoveState = { lastMs: number }

// 이 거리를 넘는 이동은 순항 속도로 따라잡기엔 비현실적으로 크다(최초 로딩, 노선·역 편집,
// 차량 재배치, 밀린 틱 몰아잡기 등) — 느리게 기어가는 것보다 즉시 스냅하는 편이 자연스럽다.
const SNAP_MAP_UNITS = 40
// 순항 속도의 이 배수까지만 허용한다. 1에 아주 가까워야 "몰아가다 멈칫"이 없다 —
// 그래도 타이밍 오차(방송 지연 등)가 누적돼 계속 처지지 않도록 아주 약간의 여유는 둔다.
const CATCHUP_SPEED_MULTIPLIER = 1.03

export function resolveSmoothVehiclePosition(
  vehicleId: string,
  target: SmoothPoint | null,
  nowMs: number,
  smoothRef: Map<string, SmoothPoint>,
  lastMoveRef: Map<string, LastMoveState>,
  cruiseSpeed = 1,
  gameMinutesPerWallSecond = 10 / 3,
  // 자리 비운 동안 밀린 틱을 몰아서 따라잡는 중이면 true — 순항 속도로는 다음 폴링
  // 전에 못 따라잡아 계속 뒤처지기만 하므로, 이 구간은 보간 없이 바로 위치를 맞춘다.
  forceSnap = false,
): SmoothPoint | null {
  if (!target) {
    smoothRef.delete(vehicleId)
    lastMoveRef.delete(vehicleId)
    return null
  }

  const prev = smoothRef.get(vehicleId)
  const last = lastMoveRef.get(vehicleId)

  if (!prev || !last || forceSnap) {
    smoothRef.set(vehicleId, target)
    lastMoveRef.set(vehicleId, { lastMs: nowMs })
    return target
  }

  const dtSec = Math.max(0, (nowMs - last.lastMs) / 1000)
  lastMoveRef.set(vehicleId, { lastMs: nowMs })

  const dist = Math.hypot(target.x - prev.x, target.y - prev.y)

  // 비정상적으로 큰 이동(순항 속도로 못 따라잡음)이거나 시간 정보가 없으면 그대로 따라간다.
  if (dist > SNAP_MAP_UNITS || dtSec <= 0) {
    smoothRef.set(vehicleId, target)
    return target
  }

  // 목표까지, 순항 속도의 CATCHUP_SPEED_MULTIPLIER배를 넘지 않는 속도로만 다가간다.
  // dist가 이번 프레임 이동량보다 작아지면 ratio가 1이 되어 자연스럽게 목표에 닿는다.
  const unitsPerWallSecond = Math.max(0.2, cruiseSpeed) * Math.max(0.5, gameMinutesPerWallSecond)
  const maxStep = unitsPerWallSecond * CATCHUP_SPEED_MULTIPLIER * dtSec
  const ratio = dist > 0 ? Math.min(1, maxStep / dist) : 1
  const current = {
    x: prev.x + (target.x - prev.x) * ratio,
    y: prev.y + (target.y - prev.y) * ratio,
  }
  smoothRef.set(vehicleId, current)
  return current
}
