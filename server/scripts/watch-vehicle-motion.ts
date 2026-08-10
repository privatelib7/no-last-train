/**
 * 도시 차량 위치를 DB 스냅샷 + 클라와 동일한 보간으로 터미널에 부드럽게 표시한다.
 *
 *   npx tsx scripts/watch-vehicle-motion.ts <cityId>
 *
 * Ctrl+C 로 종료.
 */
import pg from 'pg'
import { advanceVehicleMotion } from '../src/lib/vehicle-motion'
import { SIM } from '../src/types/game'

const cityId = process.argv[2]
if (!cityId) {
  console.error('Usage: npx tsx scripts/watch-vehicle-motion.ts <cityId>')
  process.exit(1)
}

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://nlt:nlt@127.0.0.1:5432/no_last_train?sslmode=disable'

const MAX_PREVIEW_TICKS = 1.25
const RENDER_MS = 100
const POLL_MS = 500

type StationRow = { id: string; name: string; posX: number; posY: number; order: number; lineId: string }
type VehicleRow = {
  id: string
  lineId: string
  lineName: string
  mode: string
  status: string
  isSpare: boolean
  currentStationId: string | null
  direction: number
  segmentProgressMinutes: number
}

type Snapshot = {
  city: { name: string; currentTick: number; lastTickAt: Date; status: string }
  stationsByLine: Map<string, StationRow[]>
  vehicles: VehicleRow[]
  fingerprint: string
}

const pool = new pg.Pool({ connectionString: DATABASE_URL })

let base: Snapshot | null = null
let animStartedAtMs = Date.now()
let lastPollAtMs = 0

function vehicleFingerprint(vehicles: VehicleRow[]) {
  // 미세 float 차이로 매 프레임 리셋되지 않게 0.5분 단위로 양자화
  return vehicles.map(v => {
    const seg = Math.round((v.segmentProgressMinutes || 0) * 2) / 2
    return `${v.id}:${v.currentStationId}:${v.direction}:${seg}:${v.status}:${v.isSpare ? 1 : 0}`
  }).join('|')
}

async function loadSnapshot(): Promise<Snapshot> {
  const cityRes = await pool.query<{
    name: string
    currentTick: number
    lastTickAt: Date
    status: string
  }>(
    `SELECT name, "currentTick", "lastTickAt", status
     FROM "City" WHERE id = $1`,
    [cityId],
  )
  const city = cityRes.rows[0]
  if (!city) throw new Error(`도시를 찾을 수 없습니다: ${cityId}`)

  const stationsRes = await pool.query<StationRow>(
    `SELECT s.id, s.name, s."posX", s."posY", ls."order", ls."lineId"
     FROM "LineStation" ls
     JOIN "Station" s ON s.id = ls."stationId"
     JOIN "Line" l ON l.id = ls."lineId"
     WHERE l."cityId" = $1
     ORDER BY ls."lineId", ls."order"`,
    [cityId],
  )

  const stationsByLine = new Map<string, StationRow[]>()
  for (const row of stationsRes.rows) {
    const list = stationsByLine.get(row.lineId) ?? []
    list.push(row)
    stationsByLine.set(row.lineId, list)
  }

  const vehiclesRes = await pool.query<VehicleRow>(
    `SELECT
       v.id,
       v."lineId",
       l.name AS "lineName",
       l.mode,
       v.status,
       v."isSpare",
       v."currentStationId",
       v.direction,
       v."segmentProgressMinutes"
     FROM "Vehicle" v
     JOIN "Line" l ON l.id = v."lineId"
     WHERE l."cityId" = $1
     ORDER BY l.name, v.id`,
    [cityId],
  )

  const vehicles = vehiclesRes.rows
  const fingerprint = `${city.currentTick}|${vehicleFingerprint(vehicles)}`
  return { city, stationsByLine, vehicles, fingerprint }
}

function pad(s: string, n: number) {
  let width = 0
  let out = ''
  for (const ch of s) {
    const w = /[^\u0000-\u00ff]/.test(ch) ? 2 : 1
    if (width + w > n) break
    out += ch
    width += w
  }
  return out + ' '.repeat(Math.max(0, n - width))
}

function fmt(n: number, digits = 2) {
  return n.toFixed(digits).padStart(7, ' ')
}

async function ensureBase(now: number) {
  if (!base || now - lastPollAtMs >= POLL_MS) {
    const snap = await loadSnapshot()
    lastPollAtMs = now
    if (!base || base.fingerprint !== snap.fingerprint) {
      base = snap
      animStartedAtMs = now
    } else {
      // 같은 논리 상태면 city 메타만 갱신 (lag 표시용)
      base = { ...base, city: snap.city }
    }
  }
}

async function render() {
  const now = Date.now()
  await ensureBase(now)
  if (!base) return

  const lagSec = Math.max(0, (now - new Date(base.city.lastTickAt).getTime()) / 1000)
  const previewTicks = Math.min(
    Math.max(0, (now - animStartedAtMs) / SIM.LIVE_TICK_MS),
    MAX_PREVIEW_TICKS,
  )
  const elapsedGameMinutes = previewTicks * SIM.GAME_MINUTES_PER_TICK

  const lines: string[] = []
  lines.push(
    `${new Date().toLocaleTimeString('ko-KR')}  |  ${base.city.name}  tick=${base.city.currentTick}  lag=${lagSec.toFixed(1)}s  local+${previewTicks.toFixed(2)}t (${elapsedGameMinutes.toFixed(2)}분)`,
  )
  lines.push('')
  lines.push(
    `${pad('line', 8)}${pad('mode', 7)}${pad('veh', 10)}${pad('from→to', 30)}${pad('dir', 4)}${pad('seg', 8)}${pad('prog', 8)}${pad('phase', 8)}xy`,
  )
  lines.push('-'.repeat(102))

  for (const vehicle of base.vehicles) {
    const stations = base.stationsByLine.get(vehicle.lineId) ?? []
    const nameById = new Map(stations.map(s => [s.id, s.name]))
    const shortId = vehicle.id.slice(0, 8)

    if (vehicle.isSpare || vehicle.status !== 'OPERATING' || !vehicle.currentStationId) {
      const st = vehicle.currentStationId ? (nameById.get(vehicle.currentStationId) ?? '?') : '(없음)'
      const stateLabel = vehicle.isSpare ? 'SPARE' : vehicle.status
      lines.push(
        `${pad(vehicle.lineName, 8)}${pad(vehicle.mode, 7)}${pad(shortId, 10)}${pad(st, 30)}${String(vehicle.direction).padStart(3, ' ')} ${fmt(vehicle.segmentProgressMinutes)} ${pad('—', 8)}${pad(stateLabel, 8)}—`,
      )
      continue
    }

    const motion = advanceVehicleMotion(
      stations,
      {
        currentStationId: vehicle.currentStationId,
        direction: vehicle.direction,
        segmentProgressMinutes: vehicle.segmentProgressMinutes,
      },
      elapsedGameMinutes,
      vehicle.mode,
    )

    const fromName = motion.currentStationId
      ? (nameById.get(motion.currentStationId) ?? motion.currentStationId.slice(0, 8))
      : '?'
    const toName = motion.nextStationId
      ? (nameById.get(motion.nextStationId) ?? motion.nextStationId.slice(0, 8))
      : '—'
    const route = motion.isDwelling
      ? `${fromName} (정차 ${motion.dwellRemainingMinutes.toFixed(1)}분)`
      : `${fromName}→${toName}`
    const xy = motion.x != null && motion.y != null
      ? `${motion.x.toFixed(1)},${motion.y.toFixed(1)}`
      : '—'
    const phase = motion.isDwelling ? 'DWELL' : 'MOVE'

    lines.push(
      `${pad(vehicle.lineName, 8)}${pad(vehicle.mode, 7)}${pad(shortId, 10)}${pad(route, 30)}${String(motion.direction).padStart(3, ' ')} ${fmt(motion.segmentProgressMinutes)} ${fmt(motion.progress * 100, 1)}% ${pad(phase, 8)}${xy}`,
    )
  }

  lines.push('')
  lines.push('보간: 0.5초마다 DB, 0.1초마다 화면. 스냅샷 고정 후 벽시계로 최대 1.25틱 전진. Ctrl+C 종료.')

  process.stdout.write(`\x1b[H\x1b[J${lines.join('\n')}\n`)
}

async function main() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await render()
    } catch (err) {
      process.stdout.write(`\x1b[H\x1b[J${err instanceof Error ? err.message : String(err)}\n`)
    }
    await new Promise(r => setTimeout(r, RENDER_MS))
  }
}

process.on('SIGINT', async () => {
  await pool.end()
  process.stdout.write('\n')
  process.exit(0)
})

main().catch(async err => {
  console.error(err)
  await pool.end()
  process.exit(1)
})
