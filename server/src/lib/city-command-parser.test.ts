import assert from 'node:assert/strict'
import test from 'node:test'
import { planFallbackCityCommand, type CityCommandContext } from './city-command-parser'

const context: CityCommandContext = {
  stations: [
    { id: 'city-hall', name: '시청역', posX: 10, posY: 20 },
    { id: 'river', name: '강변역', posX: 40, posY: 20 },
    { id: 'park', name: '공원역', posX: 75, posY: 20 },
  ],
  lines: [{
    id: 'line-1',
    name: '1호선',
    mode: 'SUBWAY',
    status: 'OPERATING',
    stations: [
      { id: 'city-hall', name: '시청역', posX: 10, posY: 20 },
      { id: 'river', name: '강변역', posX: 40, posY: 20 },
    ],
  }],
}

test('두 역 사이 신규 노선 명령을 원자적 건설 액션으로 만든다', () => {
  const result = planFallbackCityCommand('시청역과 공원역 사이에 새로운 노선을 건설해 줘.', context)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.actions, [{
    type: 'CREATE_CONNECTED_LINE',
    mode: 'SUBWAY',
    fromStationId: 'city-hall',
    toStationId: 'park',
  }])
})

test('버스가 명시된 신규 노선은 버스 노선으로 계획한다', () => {
  const result = planFallbackCityCommand('시청과 강변 사이에 새 버스 노선을 만들어 줘.', context)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.actions[0].type, 'CREATE_CONNECTED_LINE')
  if (result.actions[0].type === 'CREATE_CONNECTED_LINE') {
    assert.equal(result.actions[0].mode, 'BUS')
  }
})

test('노선 연장은 목표 역과 가까운 종점에서 시작한다', () => {
  const result = planFallbackCityCommand('1호선을 공원역 방향으로 연장해줘.', context)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.actions, [{
    type: 'BUILD_SEGMENT',
    lineId: 'line-1',
    fromStationId: 'river',
    toStationId: 'park',
  }])
})

test('노선 운행 중단과 재개 명령을 구분한다', () => {
  const suspended = planFallbackCityCommand('1호선 운행을 중단해줘.', context)
  const resumed = planFallbackCityCommand('1호선 운행을 재개해줘.', context)

  assert.equal(suspended.ok, true)
  assert.equal(resumed.ok, true)
  if (suspended.ok) {
    assert.deepEqual(suspended.actions[0], {
      type: 'SET_LINE_STATUS',
      lineId: 'line-1',
      status: 'SUSPENDED',
    })
  }
  if (resumed.ok) {
    assert.deepEqual(resumed.actions[0], {
      type: 'SET_LINE_STATUS',
      lineId: 'line-1',
      status: 'OPERATING',
    })
  }
})

test('이미 포함된 역으로 연장하는 명령은 실행하지 않는다', () => {
  const result = planFallbackCityCommand('1호선을 시청역 방향으로 연장해줘.', context)

  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /이미/)
})
