import assert from 'node:assert/strict'
import test from 'node:test'
import { getCityMap } from '../src/maps'
import {
  advanceCitizenJourneys,
  createCitizenJourneys,
  locateCitizen,
  pathStaysOnLand,
} from '../src/mobility'

test('keeps ambient citizens visible when a city has no operating lines', () => {
  const map = getCityMap('SEOUL')
  const journeys = createCitizenJourneys({
    seed: 20260809,
    waitingCount: 5964,
    gameHour: 10,
    weekend: false,
    stations: [],
    lines: [],
    map,
  })

  assert.ok(journeys.length >= 54)
  assert.ok(journeys.every(journey => journey.accessMode === 'CITY'))
  assert.ok(journeys.every(journey => journey.landSafe))

  for (const journey of journeys) {
    for (const leg of journey.legs) {
      assert.ok(pathStaysOnLand(leg.from, leg.to, map))
    }
    for (let sample = 0; sample < 24; sample++) {
      const position = locateCitizen(journey, journey.totalDuration * sample / 24)
      assert.ok(map.isLand(position.x, position.y))
    }
  }
})

test('keeps station-bound journeys when an operating line exists', () => {
  const map = getCityMap('SEOUL')
  const stationA = { id: 'a', name: 'A', type: 'RESIDENTIAL' as const, capacity: 1000, posX: 44, posY: 36 }
  const stationB = { id: 'b', name: 'B', type: 'COMMERCIAL' as const, capacity: 1000, posX: 48, posY: 36 }
  const line = {
    id: 'line',
    playerId: null,
    color: 'RED' as const,
    mode: 'SUBWAY' as const,
    name: 'Line',
    status: 'OPERATING' as const,
    depotX: 44,
    depotY: 36,
    lineStations: [
      { stationId: stationA.id, order: 0, station: stationA },
      { stationId: stationB.id, order: 1, station: stationB },
    ],
    vehicles: [],
    policies: [],
    actionLogs: [],
  }

  const journeys = createCitizenJourneys({
    seed: 7,
    waitingCount: 20,
    gameHour: 8,
    weekend: false,
    stations: [stationA, stationB],
    lines: [line],
    map,
  })

  assert.ok(journeys.length >= 54)
  assert.ok(journeys.every(journey => journey.accessMode === 'SUBWAY'))
  assert.ok(journeys.every(journey => journey.targetStationId === stationA.id || journey.targetStationId === stationB.id))
})

test('does not teleport citizens that are already walking when a station is built', () => {
  const map = getCityMap('SEOUL')
  const stationA = { id: 'a', name: 'A', type: 'RESIDENTIAL' as const, capacity: 1000, posX: 44, posY: 36 }
  const stationB = { id: 'b', name: 'B', type: 'COMMERCIAL' as const, capacity: 1000, posX: 48, posY: 36 }
  const newStation = { id: 'c', name: 'C', type: 'COMMERCIAL' as const, capacity: 1000, posX: 30, posY: 62 }
  const world = {
    seed: 7,
    waitingCount: 20,
    gameHour: 8,
    weekend: false,
    lines: [],
    map,
  }

  const before = createCitizenJourneys({ ...world, stations: [stationA, stationB] })
  const journeyTime = 3
  const positionsBefore = new Map(before.map(journey => [journey.id, locateCitizen(journey, journeyTime)]))

  // 역이 새로 생겨도 걷는 중인 시민의 여정은 그대로여야 한다.
  const after = advanceCitizenJourneys({
    ...world,
    stations: [stationA, stationB, newStation],
    previous: before,
    journeyTime,
  })

  let carriedOver = 0
  for (const journey of after) {
    const previous = before.find(item => item.id === journey.id)
    if (!previous || previous.generation !== journey.generation) continue
    carriedOver += 1
    assert.equal(journey.targetStationId, previous.targetStationId)
    assert.deepEqual(locateCitizen(journey, journeyTime), positionsBefore.get(journey.id))
  }
  // 새 역이 생겼다고 대부분의 시민이 리스폰되어서는 안 된다.
  assert.ok(carriedOver >= before.length * 0.8, `carried over ${carriedOver}/${before.length}`)
  assert.ok(after.every(journey => journey.targetStationId !== newStation.id || journey.generation > 0))
})
