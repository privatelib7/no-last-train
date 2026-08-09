import assert from 'node:assert/strict'
import test from 'node:test'
import { getCityMap } from '../src/maps'
import { createCitizenJourneys, locateCitizen, pathStaysOnLand } from '../src/mobility'

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
