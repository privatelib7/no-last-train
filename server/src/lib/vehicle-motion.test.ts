import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceVehicleMotion,
  reconcileVehicleForInsertedStation,
  segmentTravelMinutes,
  stationDwellMinutes,
  type MotionStation,
} from './vehicle-motion'

const stations: MotionStation[] = [
  { id: 'a', posX: 0, posY: 0 },
  { id: 'b', posX: 10, posY: 0 },
  { id: 'c', posX: 30, posY: 0 },
]

test('역간 거리와 교통수단에 따라 이동 시간이 달라진다', () => {
  const shortSubway = segmentTravelMinutes(stations[0], stations[1], 'SUBWAY')
  const longSubway = segmentTravelMinutes(stations[1], stations[2], 'SUBWAY')
  const shortBus = segmentTravelMinutes(stations[0], stations[1], 'BUS')

  assert.ok(longSubway > shortSubway)
  assert.ok(shortBus > shortSubway)
  assert.equal(shortSubway, 9.5)
  assert.equal(longSubway, 19)
  assert.equal(shortBus, 14)
})

test('10분 틱 경계에서도 차량은 구간 중간 위치를 이어서 이동한다', () => {
  const firstTick = advanceVehicleMotion(stations, {
    currentStationId: 'b',
    direction: 1,
    segmentProgressMinutes: 0,
  }, 10, 'SUBWAY')

  assert.equal(firstTick.currentStationId, 'b')
  assert.equal(firstTick.nextStationId, 'c')
  assert.equal(firstTick.segmentProgressMinutes, 10)
  assert.ok(firstTick.progress > 0 && firstTick.progress < 1)

  const continued = advanceVehicleMotion(stations, firstTick, 1, 'SUBWAY')
  assert.equal(continued.segmentProgressMinutes, 11)
  assert.ok(continued.progress > firstTick.progress)
})

test('한 틱 안에 도착한 역을 기록하고 종점에서 방향을 전환한다', () => {
  const motion = advanceVehicleMotion(stations, {
    currentStationId: 'a',
    direction: 1,
    segmentProgressMinutes: 8,
  }, 25, 'SUBWAY')

  assert.deepEqual(motion.arrivedStationIds, ['b', 'c'])
  assert.equal(motion.currentStationId, 'c')
  assert.equal(motion.nextStationId, 'b')
  assert.equal(motion.direction, -1)
  assert.ok(motion.segmentProgressMinutes > 0)
})

test('역 도착 후 승하차 시간만큼 정차한 뒤 다시 출발한다', () => {
  const arrived = advanceVehicleMotion(stations, {
    currentStationId: 'a',
    direction: 1,
    segmentProgressMinutes: 0,
  }, 9.5, 'SUBWAY')

  assert.equal(arrived.currentStationId, 'b')
  assert.equal(arrived.isDwelling, true)
  assert.equal(arrived.dwellRemainingMinutes, 1.5)
  assert.equal(arrived.x, 10)

  const stillDwelling = advanceVehicleMotion(stations, arrived, 1, 'SUBWAY')
  assert.equal(stillDwelling.currentStationId, 'b')
  assert.equal(stillDwelling.isDwelling, true)
  assert.equal(stillDwelling.dwellRemainingMinutes, 0.5)
  assert.equal(stillDwelling.x, 10)

  const departed = advanceVehicleMotion(stations, stillDwelling, 1, 'SUBWAY')
  assert.equal(departed.currentStationId, 'b')
  assert.equal(departed.isDwelling, false)
  assert.equal(departed.segmentProgressMinutes, 0.5)
  assert.ok((departed.x ?? 10) > 10)
  assert.equal(stationDwellMinutes('BUS'), 2.5)
})

// a-c 구간만 있던 노선(중간에 b가 없음)에 b를 끼워 넣는 시나리오.
// 예전 버그: 짧아진 새 구간 길이에 진행 분(min)이 그대로 클램프되어 차량이 b로 순간이동했다.
const lineWithoutB: MotionStation[] = [stations[0], stations[2]]

test('삽입 지점 이전을 지나던 차량은 출발역에 남아 물리적 위치를 유지한다', () => {
  // a→c 28분 구간 중 7분 경과 = 실제 이동 거리 7.5 (전체 거리 30의 25%), 아직 b(거리 10) 전이다.
  const fix = reconcileVehicleForInsertedStation(
    lineWithoutB,
    { currentStationId: 'a', direction: 1, segmentProgressMinutes: 7 },
    ['a', 'c'],
    stations[1],
    'SUBWAY',
  )
  assert.ok(fix)
  assert.equal(fix.currentStationId, 'a')
  assert.equal(fix.segmentProgressMinutes, 7.125)

  // 새 역이 반영된 노선에서 다시 위치를 구하면 순간이동 없이 같은 물리적 지점(x=7.5)에 있어야 한다.
  const after = advanceVehicleMotion(stations, { currentStationId: 'a', direction: 1, segmentProgressMinutes: fix.segmentProgressMinutes }, 0, 'SUBWAY')
  assert.equal(after.x, 7.5)
})

test('삽입 지점을 이미 지난 차량은 새 역을 출발점 삼아 남은 구간을 이어간다', () => {
  // a→c 28분 구간 중 14분 경과(정확히 절반, 실제 이동 거리 15) = b(거리 10)를 이미 지난 상태.
  const fix = reconcileVehicleForInsertedStation(
    lineWithoutB,
    { currentStationId: 'a', direction: 1, segmentProgressMinutes: 14 },
    ['a', 'c'],
    stations[1],
    'SUBWAY',
  )
  assert.ok(fix)
  assert.equal(fix.currentStationId, 'b')
  assert.equal(fix.segmentProgressMinutes, 4.75)

  // 새 역이 반영된 노선에서 다시 위치를 구하면 순간이동 없이 같은 물리적 지점(x=15)에 있어야 한다.
  const after = advanceVehicleMotion(stations, { currentStationId: 'b', direction: 1, segmentProgressMinutes: fix.segmentProgressMinutes }, 0, 'SUBWAY')
  assert.equal(after.x, 15)
})

test('정차 중이거나 다른 구간을 지나는 차량은 삽입에 영향받지 않는다', () => {
  const dwelling = reconcileVehicleForInsertedStation(
    lineWithoutB,
    { currentStationId: 'a', direction: 1, segmentProgressMinutes: -1.5 },
    ['a', 'c'],
    stations[1],
    'SUBWAY',
  )
  assert.equal(dwelling, null)

  const unrelatedSegment = reconcileVehicleForInsertedStation(
    stations,
    { currentStationId: 'b', direction: 1, segmentProgressMinutes: 5 },
    ['a', 'c'],
    { id: 'd', posX: 20, posY: 20 },
    'SUBWAY',
  )
  assert.equal(unrelatedSegment, null)
})