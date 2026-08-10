import { memo, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { CityMotionSnapshot, CityState, GameLine, Station, TransitMotionPhysics } from '../api/game'
import { resolveSmoothVehiclePosition, type LastMoveState } from '../lib/smooth-vehicle'
import {
  advanceCitizenJourneys,
  locateCitizen,
  type CitizenJourney,
  type CitizenTravelMode,
} from '../mobility'
import type { CityMapDef } from '../maps'
import {
  locateVehicle,
  modeCruiseSpeed,
  type RenderedVehicleMotion,
} from '../vehicle-motion'
import styles from './GamePage.module.css'

const LIVE_TICK_MS = 3000
const TICKS_PER_DAY = 144
const TICKS_PER_HOUR = 6
const GAME_MINUTES_PER_TICK = 60 / TICKS_PER_HOUR
const CITIZEN_TIME_SCALE = 0.72
const CLOCK_CATCHUP_MULTIPLIER = 1.15
const VEHICLE_SCALE = 0.62
const EARNINGS_FLASH_DURATION_MS = 1600
const EARNINGS_FLASH_RISE_UNITS = 3.5
const FRAME_MS = 33
const HUD_SAMPLE_MS = 500

const LINE_COLORS: Record<string, string> = {
  RED: '#E9783C',
  BLUE: '#3F8EDB',
  GREEN: '#55A96A',
  YELLOW: '#E1B735',
  PURPLE: '#8E6CC1',
}

const CITIZEN_MODE_CLASSES: Record<CitizenTravelMode, string> = {
  WALK: styles.personWalking,
  WAIT: styles.personWaiting,
  BOARDING: styles.personBoarding,
}

export type MotionDrive = {
  fingerprint: string
  currentTick: number
  baseSyncTick: number
  baseServerNow: number
  vehicles: CityMotionSnapshot['vehicles']
  liveTickMs: number
  gameMinutesPerTick: number
  gameMinutesPerWallSecond: number
  physics: TransitMotionPhysics
  catchingUp: boolean
  stationStats: CityMotionSnapshot['stationStats']
}

export type HudSample = {
  continuousTick: number
  waitingPassengers: number
}

type Props = {
  city: CityState['city']
  stationStats: CityState['stationStats']
  mapDef: CityMapDef
  mapScale: number
  selectedVehicleId: string
  motionRef: MutableRefObject<CityMotionSnapshot | null>
  motionDriveRef: MutableRefObject<MotionDrive | null>
  motionClockOffsetRef: MutableRefObject<number>
  stationById: Map<string, Station>
  farePerPassenger: number
  onSelectVehicle: (lineId: string, vehicleId: string) => void
  onHudSample: (sample: HudSample) => void
  /** 도시 전환 시 리셋용 키 */
  resetKey: string
}

function orderedVehicles(line: GameLine) {
  return line.vehicles.slice().sort((a, b) => a.id.localeCompare(b.id))
}

function lineDisplayName(name: string) {
  return name.replace(/^라인\s*/, '')
}

/**
 * 차량·시민 등 매 프레임 움직이는 레이어만 분리한다.
 * 부모(GamePage)가 30fps로 전체 리렌더되지 않게 이 컴포넌트 안에서만 rAF를 돌린다.
 */
function LiveTransitLayer({
  city,
  stationStats,
  mapDef,
  mapScale,
  selectedVehicleId,
  motionRef,
  motionDriveRef,
  motionClockOffsetRef,
  stationById,
  farePerPassenger,
  onSelectVehicle,
  onHudSample,
  resetKey,
}: Props) {
  const [clockNowMs, setClockNowMs] = useState(() => Date.now())
  const visualTickRef = useRef<number | null>(null)
  const lastClockWallRef = useRef<number | null>(null)
  const lastHudSampleRef = useRef(0)
  const citizenJourneysRef = useRef<CitizenJourney[]>([])
  const smoothVehicleRef = useRef(new Map<string, { x: number; y: number }>())
  const vehicleLastMoveRef = useRef(new Map<string, LastMoveState>())
  const earningsFlashRef = useRef(new Map<string, { amount: number; startedAt: number }>())
  const lastConfirmedStationRef = useRef(new Map<string, string>())
  const onHudSampleRef = useRef(onHudSample)
  onHudSampleRef.current = onHudSample

  useEffect(() => {
    visualTickRef.current = null
    lastClockWallRef.current = null
    citizenJourneysRef.current = []
    smoothVehicleRef.current.clear()
    vehicleLastMoveRef.current.clear()
    earningsFlashRef.current.clear()
    lastConfirmedStationRef.current.clear()
    lastHudSampleRef.current = 0
  }, [resetKey])

  useEffect(() => {
    let animationFrame = 0
    let lastPaint = 0
    const animate = (now: number) => {
      if (now - lastPaint >= FRAME_MS) {
        lastPaint = now
        const wallNow = Date.now()
        if (visualTickRef.current != null && lastClockWallRef.current != null) {
          const dtMs = Math.max(0, wallNow - lastClockWallRef.current)
          let nextTick = visualTickRef.current + dtMs / LIVE_TICK_MS
          const drive = motionDriveRef.current
          if (drive && city.status === 'ACTIVE') {
            const serverNow = wallNow + motionClockOffsetRef.current
            const anchorTick = drive.baseSyncTick
              + Math.max(0, (serverNow - drive.baseServerNow) / drive.liveTickMs)
            if (anchorTick > nextTick) {
              const maxAdvance = (dtMs / LIVE_TICK_MS) * CLOCK_CATCHUP_MULTIPLIER
              nextTick = Math.min(anchorTick, visualTickRef.current + maxAdvance)
            }
          }
          visualTickRef.current = nextTick
        }
        lastClockWallRef.current = wallNow
        setClockNowMs(wallNow)
      }
      animationFrame = window.requestAnimationFrame(animate)
    }
    animationFrame = window.requestAnimationFrame(animate)
    return () => window.cancelAnimationFrame(animationFrame)
  }, [city.status, motionDriveRef, motionClockOffsetRef])

  const motionSnap = motionRef.current
  const motionDrive = motionDriveRef.current
  const currentTick = motionDrive?.currentTick ?? motionSnap?.currentTick ?? city.currentTick
  const liveTickMs = motionDrive?.liveTickMs ?? motionSnap?.liveTickMs ?? LIVE_TICK_MS
  const gameMinutesPerTick = motionDrive?.gameMinutesPerTick ?? motionSnap?.gameMinutesPerTick ?? GAME_MINUTES_PER_TICK
  const gameMinutesPerWallSecond = motionDrive?.gameMinutesPerWallSecond
    ?? motionSnap?.gameMinutesPerWallSecond
    ?? (gameMinutesPerTick / (liveTickMs / 1000))
  const motionPhysics = motionDrive?.physics ?? motionSnap?.physics ?? null
  const serverNowMs = clockNowMs + motionClockOffsetRef.current
  const localSyncTick = motionDrive && city.status === 'ACTIVE'
    ? motionDrive.baseSyncTick + Math.max(0, (serverNowMs - motionDrive.baseServerNow) / liveTickMs)
    : currentTick

  if (city.status === 'ACTIVE') {
    if (visualTickRef.current == null) visualTickRef.current = localSyncTick
  } else {
    visualTickRef.current = currentTick
  }
  const continuousTick = city.status === 'ACTIVE' && visualTickRef.current != null
    ? visualTickRef.current
    : currentTick

  const gameHour = (continuousTick / TICKS_PER_HOUR) % 24
  const isWeekend = Math.floor(continuousTick / TICKS_PER_DAY) % 7 >= 5
  const journeyTime = continuousTick * CITIZEN_TIME_SCALE

  const citizenJourneys = advanceCitizenJourneys({
    previous: citizenJourneysRef.current,
    journeyTime,
    seed: city.seed,
    waitingCount: stationStats.reduce((sum, stat) => sum + stat.waitingCount, 0),
    gameHour,
    weekend: isWeekend,
    stations: city.stations,
    lines: city.lines,
    map: mapDef,
  })
  citizenJourneysRef.current = citizenJourneys
  const movingCitizens = citizenJourneys.map(journey => ({
    ...journey,
    position: locateCitizen(journey, journeyTime),
  }))

  const motionVehicleById = new Map((motionDrive?.vehicles ?? motionSnap?.vehicles ?? []).map(item => [item.id, item]))
  const vehicleMotionById = new Map(
    city.lines.flatMap(line => orderedVehicles(line).map(vehicle => {
      const synced = motionVehicleById.get(vehicle.id)
      let located: RenderedVehicleMotion
      if (synced && synced.x != null && synced.y != null) {
        const fromStation = synced.fromStationId ? stationById.get(synced.fromStationId) ?? null : null
        const toStation = synced.toStationId ? stationById.get(synced.toStationId) ?? null : null
        located = {
          fromStation,
          toStation,
          arrivedStationIds: synced.isDwelling && synced.fromStationId ? [synced.fromStationId] : [],
          direction: synced.direction,
          segmentDurationMinutes: synced.segmentDurationMinutes,
          segmentProgressMinutes: synced.renderSegmentProgressMinutes,
          dwellRemainingMinutes: synced.dwellRemainingMinutes,
          isDwelling: synced.isDwelling,
          isPullingOut: synced.isPullingOut,
          progress: synced.progress,
          x: synced.x,
          y: synced.y,
        }
      } else {
        located = locateVehicle(line, vehicle, 0, motionPhysics)
      }
      const smoothed = resolveSmoothVehiclePosition(
        vehicle.id,
        located.x != null && located.y != null ? { x: located.x, y: located.y } : null,
        clockNowMs,
        smoothVehicleRef.current,
        vehicleLastMoveRef.current,
        modeCruiseSpeed(line.mode, motionPhysics),
        gameMinutesPerWallSecond,
        motionDrive?.catchingUp ?? false,
      )
      if (smoothed) {
        return [vehicle.id, { ...located, x: smoothed.x, y: smoothed.y }] as const
      }
      return [vehicle.id, located] as const
    })),
  )

  // motion(Redis 보조 캐시, sync 주기마다 갱신)이 city state(2500ms)보다 훨씬 자주 새로
  // 고쳐지므로, 있으면 그걸 우선 쓴다 — 그래야 승객 감소·매출 표시가 지연 없이 나온다.
  const fastStationStats = motionDrive?.stationStats ?? motionSnap?.stationStats ?? null
  const fastWaitingById = fastStationStats
    ? new Map(fastStationStats.map(stat => [stat.stationId, stat.waitingCount]))
    : null
  const waitingByStation = new Map(
    stationStats.map(stat => [stat.stationId, fastWaitingById?.get(stat.stationId) ?? stat.waitingCount]),
  )
  for (const line of city.lines) {
    if (line.status !== 'OPERATING') continue
    for (const vehicle of orderedVehicles(line)) {
      if (vehicle.status !== 'OPERATING' || vehicle.isSpare) continue
      const synced = motionVehicleById.get(vehicle.id)
      if (synced?.isDwelling && synced.fromStationId) {
        const waiting = waitingByStation.get(synced.fromStationId) ?? 0
        waitingByStation.set(synced.fromStationId, Math.max(0, waiting - vehicle.capacity))
      }
      const confirmedStationId = synced?.currentStationId ?? vehicle.currentStationId
      const lastConfirmedStationId = lastConfirmedStationRef.current.get(vehicle.id)
      if (confirmedStationId && confirmedStationId !== lastConfirmedStationId) {
        lastConfirmedStationRef.current.set(vehicle.id, confirmedStationId)
        if (lastConfirmedStationId != null) {
          const waitingBefore = fastWaitingById?.get(confirmedStationId)
            ?? stationStats.find(stat => stat.stationId === confirmedStationId)?.waitingCount
            ?? 0
          const boarding = Math.min(waitingBefore, vehicle.capacity)
          const earned = boarding * farePerPassenger
          if (earned > 0) {
            earningsFlashRef.current.set(vehicle.id, { amount: earned, startedAt: clockNowMs })
          }
        }
      }
    }
  }

  const waitingPassengers = [...waitingByStation.values()].reduce((sum, waiting) => sum + waiting, 0)
  const hudPayloadRef = useRef<HudSample>({ continuousTick, waitingPassengers })
  hudPayloadRef.current = { continuousTick, waitingPassengers }

  useEffect(() => {
    if (clockNowMs - lastHudSampleRef.current < HUD_SAMPLE_MS) return
    lastHudSampleRef.current = clockNowMs
    const sample = hudPayloadRef.current
    onHudSampleRef.current(sample)
  }, [clockNowMs])

  return (
    <>
      <g
        className={styles.peopleLayer}
        clipPath="url(#city-land-clip)"
        aria-label={`외부에서 역과 정류장으로 이동하는 시민 ${movingCitizens.length}명`}
      >
        {movingCitizens.map(citizen => {
          const { position } = citizen
          return (
            <circle
              key={citizen.id}
              cx={position.x}
              cy={position.y}
              r={citizen.radius * position.radiusScale * mapScale}
              opacity={citizen.opacity * position.opacityScale}
              className={`${styles.personDot} ${CITIZEN_MODE_CLASSES[position.mode]} ${citizen.warm ? styles.personDotWarm : ''}`}
            />
          )
        })}
      </g>

      {city.stations.map(station => {
        const waiting = waitingByStation.get(station.id) ?? 0
        const congestion = station.capacity > 0 ? Math.min(waiting / station.capacity, 1) : 0
        return (
          <text
            key={`wait-${station.id}`}
            transform={`translate(${station.posX} ${station.posY}) scale(${mapScale})`}
            x="1.55"
            y="0.45"
            className={`${styles.waitingCount}${
              congestion >= 1
                ? ` ${styles.waitingCountSaturated}`
                : congestion >= 0.7
                  ? ` ${styles.waitingCountWarn}`
                  : ''
            }`}
          >
            {waiting}
          </text>
        )
      })}

      {city.lines.flatMap(line => orderedVehicles(line)
        .filter(vehicle => vehicle.status === 'OPERATING' && !vehicle.isSpare)
        .map(vehicle => {
          const motion = vehicleMotionById.get(vehicle.id)
          const station = motion?.fromStation
          const nextStation = motion?.toStation
          if (!motion || motion.x === null || motion.y === null) return null
          const lineNo = line.name.match(/\d+/)?.[0] ?? line.name.slice(0, 1)
          const progress = line.status === 'OPERATING' ? motion.progress : 0
          const facing = motion.isPullingOut && station
            ? { x: station.posX - line.depotX, y: station.posY - line.depotY }
            : nextStation && station
              ? { x: nextStation.posX - station.posX, y: nextStation.posY - station.posY }
              : { x: 1, y: 0 }
          const rawAngle = Math.atan2(facing.y, facing.x) * 180 / Math.PI
          const trainFlipped = Math.abs(rawAngle) > 90
          const trainAngle = trainFlipped ? rawAngle - 180 * Math.sign(rawAngle || 1) : rawAngle
          return (
            <g
              key={vehicle.id}
              transform={`translate(${motion.x} ${motion.y}) rotate(${trainAngle})${trainFlipped ? ' scale(-1,1)' : ''} scale(${mapScale * VEHICLE_SCALE})`}
              className={`${styles.trainIcon} ${vehicle.id === selectedVehicleId ? styles.selectedTrain : ''}`}
              onClick={event => { event.stopPropagation(); onSelectVehicle(line.id, vehicle.id) }}
              role="button"
              tabIndex={0}
              aria-label={`${lineDisplayName(line.name)} 차량 선택`}
              aria-pressed={vehicle.id === selectedVehicleId}
              data-map-interactive="true"
              data-motion-progress={progress.toFixed(3)}
            >
              {line.mode === 'BUS' ? (
                <>
                  <rect x="-3" y="-2.1" width="6" height="4.2" rx="1.6" fill={LINE_COLORS[line.color]} className={styles.trainBody} />
                  <rect x="-2.2" y="-1.35" width="2.7" height="1.35" rx=".3" className={styles.trainWindow} />
                  <rect x="1" y="-1.15" width="1.15" height="2.5" rx=".22" className={styles.busDoor} />
                  <circle cx="-1.6" cy="2.05" r=".56" className={styles.trainWheel} />
                  <circle cx="1.6" cy="2.05" r=".56" className={styles.trainWheel} />
                  <text x="-.6" y=".9" textAnchor="middle" className={styles.trainNumber} transform={trainFlipped ? 'scale(-1,1)' : undefined}>{lineNo}</text>
                </>
              ) : (
                <>
                  <path d="M-1.6 -2.9H1.6M-1.1 -2L0 -2.85L1.1 -2" className={styles.pantograph} />
                  <rect x="-3.7" y="-2" width="7.4" height="4" rx="1.2" fill={LINE_COLORS[line.color]} className={styles.trainBody} />
                  <rect x="-2.8" y="-1.2" width="1.55" height="1.25" rx=".28" className={styles.trainWindow} />
                  <rect x="-.65" y="-1.2" width="1.55" height="1.25" rx=".28" className={styles.trainWindow} />
                  <circle cx="-2.15" cy="1.85" r=".56" className={styles.trainWheel} />
                  <circle cx="2.15" cy="1.85" r=".56" className={styles.trainWheel} />
                  <text x="2.2" y=".55" textAnchor="middle" className={styles.trainNumber} transform={trainFlipped ? 'scale(-1,1)' : undefined}>{lineNo}</text>
                </>
              )}
            </g>
          )
        }))}

      {city.lines.flatMap(line => orderedVehicles(line)
        .filter(vehicle => vehicle.status === 'OPERATING' && !vehicle.isSpare)
        .map(vehicle => {
          const flash = earningsFlashRef.current.get(vehicle.id)
          if (!flash) return null
          const elapsed = clockNowMs - flash.startedAt
          if (elapsed < 0 || elapsed > EARNINGS_FLASH_DURATION_MS) return null
          const motion = vehicleMotionById.get(vehicle.id)
          if (!motion || motion.x === null || motion.y === null) return null
          const progress = elapsed / EARNINGS_FLASH_DURATION_MS
          const riseY = -EARNINGS_FLASH_RISE_UNITS * progress
          return (
            <text
              key={`earn-${vehicle.id}`}
              transform={`translate(${motion.x} ${motion.y + riseY - 3}) scale(${mapScale})`}
              textAnchor="middle"
              className={styles.earningsFlash}
              style={{ opacity: 1 - progress }}
            >
              +₵{Math.round(flash.amount / 10_000).toLocaleString('ko-KR')}
            </text>
          )
        }))}
    </>
  )
}

export default memo(LiveTransitLayer)
