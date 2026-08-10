/**
 * 서버 motion 좌표를 목표로 따라가되, 목표에 일찍 닿아도 다음 패킷까지
 * 마지막 속도로 짧게 외삽해 "몰아가다 멈칫"을 없앤다.
 */

export type SmoothPoint = { x: number; y: number }

export type LastMoveState = {
  lastMs: number
  vx: number
  vy: number
  /** 목표에 닿은 뒤 외삽을 시작한 시각 — null이면 아직 목표 추적 중 */
  coastSinceMs: number | null
}

const SNAP_MAP_UNITS = 40
/** 목표에 사실상 도착으로 보는 거리 */
const AT_TARGET_UNITS = 0.08
/** 패킷이 안 와도 마지막 속도로 이어가는 최대 시간 */
const COAST_MAX_MS = 220
const CATCHUP_SPEED_MULTIPLIER = 1.02

export function resolveSmoothVehiclePosition(
  vehicleId: string,
  target: SmoothPoint | null,
  nowMs: number,
  smoothRef: Map<string, SmoothPoint>,
  lastMoveRef: Map<string, LastMoveState>,
  cruiseSpeed = 1,
  gameMinutesPerWallSecond = 10 / 3,
  forceSnap = false,
): SmoothPoint | null {
  if (!target) {
    smoothRef.delete(vehicleId)
    lastMoveRef.delete(vehicleId)
    return null
  }

  const prev = smoothRef.get(vehicleId)
  const last = lastMoveRef.get(vehicleId)
  const unitsPerWallSecond = Math.max(0.2, cruiseSpeed) * Math.max(0.5, gameMinutesPerWallSecond)

  if (!prev || !last || forceSnap) {
    smoothRef.set(vehicleId, target)
    lastMoveRef.set(vehicleId, {
      lastMs: nowMs,
      vx: 0,
      vy: 0,
      coastSinceMs: null,
    })
    return target
  }

  const dtSec = Math.max(0, (nowMs - last.lastMs) / 1000)
  const dist = Math.hypot(target.x - prev.x, target.y - prev.y)

  if (dist > SNAP_MAP_UNITS || dtSec <= 0) {
    smoothRef.set(vehicleId, target)
    lastMoveRef.set(vehicleId, {
      lastMs: nowMs,
      vx: last.vx,
      vy: last.vy,
      coastSinceMs: null,
    })
    return target
  }

  // 목표가 아직 앞에 있으면 순항 속도로 추적하고 속도를 기억한다.
  if (dist > AT_TARGET_UNITS) {
    const maxStep = unitsPerWallSecond * CATCHUP_SPEED_MULTIPLIER * dtSec
    const ratio = Math.min(1, maxStep / dist)
    const current = {
      x: prev.x + (target.x - prev.x) * ratio,
      y: prev.y + (target.y - prev.y) * ratio,
    }
    const step = Math.hypot(current.x - prev.x, current.y - prev.y)
    const vx = dtSec > 0 ? (current.x - prev.x) / dtSec : last.vx
    const vy = dtSec > 0 ? (current.y - prev.y) / dtSec : last.vy
    // 거의 안 움직인 프레임은 이전 속도를 유지(노이즈 방지)
    smoothRef.set(vehicleId, current)
    lastMoveRef.set(vehicleId, {
      lastMs: nowMs,
      vx: step > 1e-6 ? vx : last.vx,
      vy: step > 1e-6 ? vy : last.vy,
      coastSinceMs: null,
    })
    return current
  }

  // 목표에 도착: 다음 패킷이 올 때까지 마지막 속도로 짧게 미끄러진다.
  const coastSince = last.coastSinceMs ?? nowMs
  const coastElapsed = nowMs - coastSince
  const speed = Math.hypot(last.vx, last.vy)
  if (coastElapsed < COAST_MAX_MS && speed > 0.05) {
    const current = {
      x: prev.x + last.vx * dtSec,
      y: prev.y + last.vy * dtSec,
    }
    smoothRef.set(vehicleId, current)
    lastMoveRef.set(vehicleId, {
      lastMs: nowMs,
      vx: last.vx,
      vy: last.vy,
      coastSinceMs: coastSince,
    })
    return current
  }

  smoothRef.set(vehicleId, target)
  lastMoveRef.set(vehicleId, {
    lastMs: nowMs,
    vx: last.vx,
    vy: last.vy,
    coastSinceMs: coastSince,
  })
  return target
}
