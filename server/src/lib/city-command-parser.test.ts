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
    vehicles: [
      { id: 'vehicle-1', status: 'OPERATING', isSpare: false },
      { id: 'vehicle-2', status: 'SPARE', isSpare: true },
    ],
  }, {
    id: 'line-2',
    name: '2호선',
    mode: 'SUBWAY',
    status: 'OPERATING',
    stations: [
      { id: 'river', name: '강변역', posX: 40, posY: 20 },
      { id: 'park', name: '공원역', posX: 75, posY: 20 },
    ],
    vehicles: [
      { id: 'vehicle-3', status: 'SPARE', isSpare: true },
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

test('기존 노선 삭제 명령을 REMOVE_LINE 액션으로 만든다', () => {
  const result = planFallbackCityCommand('1호선 노선을 삭제해줘.', context)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.actions, [{ type: 'REMOVE_LINE', lineId: 'line-1' }])
})

test('폐쇄는 삭제가 아니라 운행 중단으로 유지한다', () => {
  const result = planFallbackCityCommand('1호선을 폐쇄해줘.', context)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.actions, [{ type: 'SET_LINE_STATUS', lineId: 'line-1', status: 'SUSPENDED' }])
})

test('역 완전 삭제와 노선에서 역 제외를 구분한다', () => {
  const removed = planFallbackCityCommand('공원역을 완전히 삭제해줘.', context)
  const detached = planFallbackCityCommand('1호선에서 시청역을 빼줘.', context)

  assert.equal(removed.ok, true)
  assert.equal(detached.ok, true)
  if (removed.ok) {
    assert.deepEqual(removed.actions, [{ type: 'REMOVE_STATION', stationId: 'park' }])
  }
  if (detached.ok) {
    assert.deepEqual(detached.actions, [{ type: 'DETACH_STATION', lineId: 'line-1', stationId: 'city-hall' }])
  }
})

test('역 이름 변경 명령은 현재 역 ID와 새 이름을 사용한다', () => {
  const result = planFallbackCityCommand('시청역 이름을 중앙역으로 바꿔줘.', context)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.actions, [{ type: 'RENAME_STATION', stationId: 'city-hall', name: '중앙역' }])
})

test('역을 지정하지 않은 새 버스 노선 명령도 처리한다', () => {
  const result = planFallbackCityCommand('새 버스 노선을 만들어줘.', context)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.actions, [{ type: 'CREATE_LINE', mode: 'BUS' }])
})

test('기존 구간 사이에 역을 삽입한다', () => {
  const result = planFallbackCityCommand('1호선 시청역과 강변역 사이에 공원역을 추가해줘.', context)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.actions, [{
    type: 'INSERT_STATION',
    lineId: 'line-1',
    fromStationId: 'city-hall',
    toStationId: 'river',
    stationId: 'park',
  }])
})

test('표시 번호로 차량 입고와 운행을 계획한다', () => {
  const stored = planFallbackCityCommand('1호선 1번 차량을 입고해줘.', context)
  const started = planFallbackCityCommand('1호선 2번 차량 운행 시작해줘.', context)

  assert.equal(stored.ok, true)
  assert.equal(started.ok, true)
  if (stored.ok) {
    assert.deepEqual(stored.actions, [{
      type: 'SET_VEHICLE_SERVICE',
      lineId: 'line-1',
      vehicleId: 'vehicle-1',
      inService: false,
    }])
  }
  if (started.ok) {
    assert.deepEqual(started.actions, [{
      type: 'SET_VEHICLE_SERVICE',
      lineId: 'line-1',
      vehicleId: 'vehicle-2',
      inService: true,
    }])
  }
})

test('표시 번호로 차량 이동과 삭제를 계획한다', () => {
  const transferred = planFallbackCityCommand('1호선 2번 차량을 2호선 차고지로 옮겨줘.', context)
  const removed = planFallbackCityCommand('1호선 1번 차량을 삭제해줘.', context)

  assert.equal(transferred.ok, true)
  assert.equal(removed.ok, true)
  if (transferred.ok) {
    assert.deepEqual(transferred.actions, [{
      type: 'TRANSFER_VEHICLE',
      lineId: 'line-1',
      vehicleId: 'vehicle-2',
      targetLineId: 'line-2',
    }])
  }
  if (removed.ok) {
    assert.deepEqual(removed.actions, [{
      type: 'REMOVE_VEHICLE',
      lineId: 'line-1',
      vehicleId: 'vehicle-1',
    }])
  }
})

test('두 역 사이 새 역 신설은 중간 지점에 기본 이름으로 계획한다', () => {
  const result = planFallbackCityCommand('시청역과 강변역 사이에 새 역을 지어줘.', context)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.actions, [{
    type: 'BUILD_STATION',
    name: '신설역 4',
    posX: 25,
    posY: 20,
  }])
})

test('가까운 두 역 사이에는 새 역을 짓지 않는다', () => {
  const tightContext: CityCommandContext = {
    ...context,
    stations: [
      { id: 'a', name: '가역', posX: 10, posY: 20 },
      { id: 'b', name: '나역', posX: 13, posY: 20 },
    ],
    lines: [],
  }
  const result = planFallbackCityCommand('가역과 나역 사이에 새 역을 지어줘.', tightContext)

  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /가까워/)
})

test('증차 명령은 대수를 읽어 차량 구매로 계획한다', () => {
  const single = planFallbackCityCommand('1호선에 차량 구매해줘.', context)
  const double = planFallbackCityCommand('2호선 차량 2대 구입해줘.', context)

  assert.equal(single.ok, true)
  assert.equal(double.ok, true)
  if (single.ok) assert.deepEqual(single.actions, [{ type: 'BUY_VEHICLE', lineId: 'line-1', count: 1 }])
  if (double.ok) assert.deepEqual(double.actions, [{ type: 'BUY_VEHICLE', lineId: 'line-2', count: 2 }])
})

test('모든 노선 일괄 명령은 상태가 다른 노선만 바꾼다', () => {
  const suspendAll = planFallbackCityCommand('모든 노선 운행을 중단해줘.', context)
  const resumeAll = planFallbackCityCommand('모든 노선 운행을 재개해줘.', context)

  assert.equal(suspendAll.ok, true)
  if (suspendAll.ok) {
    assert.deepEqual(suspendAll.actions, [
      { type: 'SET_LINE_STATUS', lineId: 'line-1', status: 'SUSPENDED' },
      { type: 'SET_LINE_STATUS', lineId: 'line-2', status: 'SUSPENDED' },
    ])
  }
  // 이미 두 노선 모두 운행 중이므로 재개는 바꿀 대상이 없다
  assert.equal(resumeAll.ok, false)
  if (!resumeAll.ok) assert.match(resumeAll.reason, /이미/)
})

test('노선 차량 일괄 투입은 차고지 대기 차량만 계획한다', () => {
  const result = planFallbackCityCommand('1호선 모든 차량을 투입해줘.', context)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.actions, [{
    type: 'SET_VEHICLE_SERVICE',
    lineId: 'line-1',
    vehicleId: 'vehicle-2',
    inService: true,
  }])
})

test('도시 전체 차량 일괄 입고는 운행 중인 차량만 계획한다', () => {
  const result = planFallbackCityCommand('모든 차량을 입고해줘.', context)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.actions, [{
    type: 'SET_VEHICLE_SERVICE',
    lineId: 'line-1',
    vehicleId: 'vehicle-1',
    inService: false,
  }])
})

test('한 번에 실행할 액션이 상한을 넘으면 계획을 취소한다', () => {
  const spare = (id: string) => ({ id, status: 'SPARE' as const, isSpare: true })
  const crowdedContext: CityCommandContext = {
    ...context,
    lines: context.lines.map((line, lineIndex) => ({
      ...line,
      vehicles: Array.from({ length: 11 }, (_, index) => spare(`v-${lineIndex}-${index}`)),
    })),
  }
  const result = planFallbackCityCommand('모든 차량을 투입해줘.', crowdedContext)

  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /20개까지/)
})

test('존재하지 않는 차량 번호는 실행하지 않는다', () => {
  const result = planFallbackCityCommand('1호선 9번 차량을 삭제해줘.', context)

  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /9번 차량/)
})
