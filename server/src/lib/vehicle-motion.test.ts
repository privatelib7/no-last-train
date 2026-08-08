import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceVehicleMotion, segmentTravelMinutes, stationDwellMinutes, type MotionStation } from './vehicle-motion'

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
