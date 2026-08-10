/**
 * 서버 motion 좌표가 크게 점프할 때, 순항 속도를 넘지 않는 속도로만 따라잡아
 * 순간이동·급가속 없이 보이게 한다.
 *
 * 예전 구현은 "고정 시간(최대 1.6초) 안에 목표까지 선형 보간"이었는데, 그 목표
 * 자체가 매 프레임 계속 전진하는 값이라 보간 종료 시점의 실제 속도가 순항 속도의
 * 최대 3배까지 치솟았다(밀린 틱을 짧은 시간 안에 몰아서 따라잡아야 했으므로).
 * 대신 매 프레임 목표 방향으로 "순항 속도 × 배수"만큼만 전진시키는 방식으로 바꿔
 * 렌더 속도가 그 배수를 절대 넘지 않도록 한다.
 */

export type SmoothPoint = { x: number; y: number }

type LastMoveState = { lastMs: number }

// 이 거리 이하의 프레임 간 차이는 정상적인 연속 이동으로 보고 그대로 따라간다.
const JUMP_MAP_UNITS = 0.45
// 이 거리를 넘는 이동은 순항 속도로 따라잡기엔 비현실적으로 크다(최초 로딩, 노선·역 편집,
// 차량 재배치 등) — 느리게 기어가는 것보다 즉시 스냅하는 편이 자연스럽다.
const SNAP_MAP_UNITS = 40
// 밀린 만큼을 따라잡을 때도 순항 속도의 이 배수를 절대 넘지 않는다("갑자기 빨라짐" 방지).
const CATCHUP_SPEED_MULTIPLIER = 1.15

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

  // 정상적인 연속 이동, 혹은 비정상적으로 큰 이동(순항 속도로 못 따라잡음) — 그대로 따라간다.
  if (dist <= JUMP_MAP_UNITS || dist > SNAP_MAP_UNITS || dtSec <= 0) {
    smoothRef.set(vehicleId, target)
    return target
  }

  // 밀린 구간을, 순항 속도의 CATCHUP_SPEED_MULTIPLIER배를 넘지 않는 속도로만 따라잡는다.
  const unitsPerWallSecond = Math.max(0.2, cruiseSpeed) * Math.max(0.5, gameMinutesPerWallSecond)
  const maxStep = unitsPerWallSecond * CATCHUP_SPEED_MULTIPLIER * dtSec
  const ratio = Math.min(1, maxStep / dist)
  const current = {
    x: prev.x + (target.x - prev.x) * ratio,
    y: prev.y + (target.y - prev.y) * ratio,
  }
  smoothRef.set(vehicleId, current)
  return current
}
