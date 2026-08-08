import assert from 'node:assert/strict'
import test from 'node:test'
import { isVehicleInService, vehicleServiceUpdate } from './vehicle-service'

test('운행 차량과 차고지 대기 차량을 상태와 예비 플래그로 일관되게 구분한다', () => {
  assert.equal(isVehicleInService({ status: 'OPERATING', isSpare: false }), true)
  assert.equal(isVehicleInService({ status: 'OPERATING', isSpare: true }), false)
  assert.equal(isVehicleInService({ status: 'SPARE', isSpare: true }), false)
})

test('입고 명령은 대기 상태를, 운행 명령은 지정 역의 운행 상태를 만든다', () => {
  assert.deepEqual(vehicleServiceUpdate(false), {
    status: 'SPARE',
    isSpare: true,
    currentStationId: null,
    segmentProgressMinutes: 0,
  })
  assert.deepEqual(vehicleServiceUpdate(true, {
    stationId: 'station-a',
    direction: -1,
    dwellMinutes: 1.5,
  }), {
    status: 'OPERATING',
    isSpare: false,
    currentStationId: 'station-a',
    direction: -1,
    segmentProgressMinutes: -1.5,
  })
})
