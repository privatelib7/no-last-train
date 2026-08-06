import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from 'react'
import {
  executeCityAction,
  fetchCity,
  type CityAction,
  type CityState,
  type GameLine,
  type Station,
  type Vehicle,
} from '../api/game'
import { getCityMap, pointInPolygon, polyPath, type CityMapDef, type ZoneKind } from '../maps'
import styles from './GamePage.module.css'

interface Props {
  cityId: string
  onBack: () => void
}

type VehicleDragState = {
  lineId: string
  vehicleId: string
  startX: number
  startY: number
  x: number
  y: number
  active: boolean
}

type DragTarget = { kind: 'DEPOT' | 'STATION'; id: string } | null

type MapView = { x: number; y: number; width: number; height: number }

type MapPanState = {
  pointerId: number
  startX: number
  startY: number
  startView: MapView
  moved: boolean
}

const LIVE_TICK_MS = 3000
const INITIAL_MAP_VIEW: MapView = { x: 0, y: 0, width: 100, height: 100 }

const LINE_COLORS: Record<string, string> = {
  RED: '#E9783C',
  BLUE: '#3F8EDB',
  GREEN: '#55A96A',
  YELLOW: '#E1B735',
  PURPLE: '#8E6CC1',
}

function formatHour(hour: number) {
  const normalized = ((hour % 24) + 24) % 24
  const h = Math.floor(normalized)
  const m = Math.round((normalized - h) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function formatElapsed(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return [hours, minutes, secs].map(value => String(value).padStart(2, '0')).join(':')
}

function stationPoint(station: Station) {
  return { x: station.posX, y: station.posY }
}

function orderedStations(line: GameLine) {
  return line.lineStations.slice().sort((a, b) => a.order - b.order).map(item => item.station)
}

function linePoints(line: GameLine) {
  return orderedStations(line).map(station => `${station.posX},${station.posY}`).join(' ')
}

function trainStatus(vehicle: Vehicle) {
  if (vehicle.status === 'OPERATING') return '운행 중'
  if (vehicle.status === 'SPARE') return '차고지 대기'
  if (vehicle.status === 'LOANED') return '지원 운행'
  if (vehicle.status === 'MAINTENANCE') return '정비 중'
  return '운행 불가'
}

function lineHasStation(line: GameLine, stationId: string) {
  return line.lineStations.some(item => item.stationId === stationId)
}

// 서버 simulation.ts의 vehicleTiming과 동일해야 함
function vehicleTiming(vehicleId: string, mode: string = 'SUBWAY') {
  let hash = 2166136261
  for (let index = 0; index < vehicleId.length; index++) {
    hash ^= vehicleId.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  const unsigned = hash >>> 0
  // 버스는 지하철보다 한 단계 느림 (2~4틱)
  const interval = 1 + (unsigned % 3) + (mode === 'BUS' ? 1 : 0)
  const phase = Math.floor(unsigned / 3) % interval
  return { interval, phase }
}

function shouldVehicleMove(vehicleId: string, tick: number, mode: string = 'SUBWAY') {
  const { interval, phase } = vehicleTiming(vehicleId, mode)
  return tick % interval === phase
}

function nextStationOnLine(line: GameLine, vehicle: Vehicle) {
  const stations = orderedStations(line)
  if (!vehicle.currentStationId || stations.length < 2) return null
  const currentIndex = stations.findIndex(station => station.id === vehicle.currentStationId)
  if (currentIndex < 0) return null
  let direction = vehicle.direction >= 0 ? 1 : -1
  let nextIndex = currentIndex + direction
  if (nextIndex < 0 || nextIndex >= stations.length) {
    direction *= -1
    nextIndex = currentIndex + direction
  }
  return stations[nextIndex] ?? null
}

function nearestStationToDepot(line: GameLine) {
  return orderedStations(line).reduce<Station | null>((nearest, station) => {
    if (!nearest) return station
    const currentDistance = Math.hypot(station.posX - line.depotX, station.posY - line.depotY)
    const nearestDistance = Math.hypot(nearest.posX - line.depotX, nearest.posY - line.depotY)
    return currentDistance < nearestDistance ? station : nearest
  }, null)
}

function randomUnit(seed: number, index: number, salt: number) {
  let value = Math.imul(seed + index * 374761393 + salt * 668265263, 1274126177)
  value ^= value >>> 13
  value = Math.imul(value, 2246822519)
  return (value >>> 0) / 4294967296
}

// 시간대별 구역 상주 인구 가중치 (index: 0 아침, 1 낮, 2 저녁, 3 밤)
const AMBIENT_WEIGHT: Record<'WD' | 'WE', Array<Record<ZoneKind, number>>> = {
  WD: [
    { residential: 1.2, commercial: 0.8, industrial: 2.2 },
    { residential: 0.6, commercial: 2.0, industrial: 1.4 },
    { residential: 1.5, commercial: 2.0, industrial: 0.5 },
    { residential: 2.5, commercial: 0.7, industrial: 0.15 },
  ],
  WE: [
    { residential: 1.8, commercial: 1.0, industrial: 0.1 },
    { residential: 1.0, commercial: 2.2, industrial: 0.1 },
    { residential: 1.4, commercial: 1.8, industrial: 0.1 },
    { residential: 2.4, commercial: 0.6, industrial: 0.1 },
  ],
}

function periodIndexOfHour(hour: number) {
  const h = Math.floor(hour)
  if (h >= 6 && h <= 9) return 0
  if (h >= 10 && h <= 15) return 1
  if (h >= 16 && h <= 19) return 2
  return 3
}

function zoneBBox(points: Array<[number, number]>) {
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  return { minX, minY, width: maxX - minX, height: maxY - minY }
}

// 역이 없는 승객은 구역 안에 머무른다 — 시간대에 따라 구역별 인구가 이동
function createPeople(seed: number, waitingCount: number, map: CityMapDef, periodIndex: number, weekend: boolean) {
  const count = Math.min(150, Math.max(45, Math.round(38 + Math.log10(waitingCount + 10) * 23)))
  const weights = AMBIENT_WEIGHT[weekend ? 'WE' : 'WD'][periodIndex]
  const zones = map.zones.map(zone => ({
    zone,
    bbox: zoneBBox(zone.points),
  }))
  const zoneWeights = zones.map(({ zone, bbox }) => weights[zone.kind] * bbox.width * bbox.height)
  const totalWeight = zoneWeights.reduce((sum, w) => sum + w, 0)
  // 시간대·요일이 salt에 들어가 시간대가 바뀔 때만 인구 배치가 이동한다
  const salt = 400 + periodIndex * 2 + (weekend ? 1 : 0)

  return Array.from({ length: count }, (_, index) => {
    let x = -1
    let y = -1
    if (totalWeight > 0 && index % 4 !== 0) {
      let roll = randomUnit(seed, index, salt) * totalWeight
      let picked = zones[zones.length - 1]
      for (let z = 0; z < zones.length; z++) {
        roll -= zoneWeights[z]
        if (roll <= 0) { picked = zones[z]; break }
      }
      for (let attempt = 0; attempt < 24; attempt++) {
        const candidateX = picked.bbox.minX + randomUnit(seed, index, salt + 10 + attempt * 2) * picked.bbox.width
        const candidateY = picked.bbox.minY + randomUnit(seed, index, salt + 11 + attempt * 2) * picked.bbox.height
        if (pointInPolygon(candidateX, candidateY, picked.zone.points) && map.isLand(candidateX, candidateY)) {
          x = candidateX
          y = candidateY
          break
        }
      }
    }
    if (x < 0) {
      for (let attempt = 0; attempt < 24; attempt++) {
        const candidateX = randomUnit(seed, index, salt + 60 + attempt * 2) * 100
        const candidateY = randomUnit(seed, index, salt + 61 + attempt * 2) * 96
        if (map.isLand(candidateX, candidateY)) {
          x = candidateX
          y = candidateY
          break
        }
      }
    }
    return {
      x,
      y,
      radius: 0.24 + randomUnit(seed, index, 90) * 0.14,
      opacity: 0.6 + randomUnit(seed, index, 91) * 0.3,
      warm: randomUnit(seed, index, 92) > 0.72,
    }
  })
}

export default function GamePage({ cityId, onBack }: Props) {
  const [state, setState] = useState<CityState | null>(null)
  const [selectedLineId, setSelectedLineId] = useState('')
  const [selectedVehicleId, setSelectedVehicleId] = useState('')
  const [stationBuildMode, setStationBuildMode] = useState(false)
  const [stationName, setStationName] = useState('')
  const [selectedStationId, setSelectedStationId] = useState('')
  const [renameValue, setRenameValue] = useState('')
  const [linkMode, setLinkMode] = useState(false)
  const [linkFromId, setLinkFromId] = useState('')
  const [moveStationMode, setMoveStationMode] = useState(false)
  const [vehicleDrag, setVehicleDrag] = useState<VehicleDragState | null>(null)
  const [dragTarget, setDragTarget] = useState<DragTarget>(null)
  const [mapView, setMapView] = useState<MapView>(INITIAL_MAP_VIEW)
  const [isMapPanning, setIsMapPanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [motionProgress, setMotionProgress] = useState(0)
  const ticking = useRef(false)
  const vehicleDragRef = useRef<VehicleDragState | null>(null)
  const mapPanRef = useRef<MapPanState | null>(null)
  const suppressMapClick = useRef(false)
  const mapRef = useRef<SVGSVGElement | null>(null)
  const stateRef = useRef<CityState | null>(null)
  const performActionRef = useRef<((action: CityAction) => Promise<CityState | null>) | null>(null)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const loadCity = async () => {
    const next = await fetchCity(cityId)
    setState(next)
    const firstLine = next.city.lines.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko'))[0]
    setSelectedLineId(current => current || firstLine?.id || '')
    return next
  }

  useEffect(() => {
    let cancelled = false
    fetchCity(cityId)
      .then(next => {
        if (cancelled) return
        setState(next)
        const firstLine = next.city.lines.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko'))[0]
        setSelectedLineId(firstLine?.id ?? '')
      })
      .catch(() => {
        // 삭제된 도시 ID가 localStorage에 남은 경우 등 — 로비로 복귀
        if (!cancelled) onBack()
      })
    return () => { cancelled = true }
  }, [cityId])

  useEffect(() => {
    let cancelled = false
    const timer = window.setInterval(async () => {
      if (ticking.current || busy) return
      ticking.current = true
      try {
        const next = await fetchCity(cityId)
        if (!cancelled) {
          setState(next)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '자동 운행 연결 오류')
      } finally {
        ticking.current = false
      }
    }, 600)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [busy, cityId])

  const motionTick = state?.city.currentTick ?? -1
  useEffect(() => {
    if (motionTick < 0) return
    let animationFrame = 0
    const startedAt = performance.now()
    setMotionProgress(0)

    const animate = (now: number) => {
      const progress = Math.min((now - startedAt) / (LIVE_TICK_MS - 180), 1)
      setMotionProgress(progress)
      if (progress < 1) animationFrame = window.requestAnimationFrame(animate)
    }

    animationFrame = window.requestAnimationFrame(animate)
    return () => window.cancelAnimationFrame(animationFrame)
  }, [motionTick])

  const sortedLines = useMemo(
    () => state?.city.lines.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko')) ?? [],
    [state],
  )
  const selectedLine = useMemo(
    () => sortedLines.find(line => line.id === selectedLineId) ?? null,
    [selectedLineId, sortedLines],
  )
  const selectedVehicleLine = useMemo(
    () => sortedLines.find(line => line.vehicles.some(vehicle => vehicle.id === selectedVehicleId)) ?? null,
    [selectedVehicleId, sortedLines],
  )
  const selectedVehicle = selectedVehicleLine?.vehicles.find(vehicle => vehicle.id === selectedVehicleId) ?? null
  const stationById = useMemo(
    () => new Map(state?.city.stations.map(station => [station.id, station]) ?? []),
    [state],
  )
  const interchangeStationIds = useMemo(() => {
    const memberships = new Map<string, number>()
    for (const line of sortedLines) {
      for (const item of line.lineStations) {
        memberships.set(item.stationId, (memberships.get(item.stationId) ?? 0) + 1)
      }
    }
    return new Set([...memberships].filter(([, count]) => count > 1).map(([stationId]) => stationId))
  }, [sortedLines])
  // 소속 노선이 전부 버스인 역 = 버스 정류장 (사각 글리프)
  const busOnlyStationIds = useMemo(() => {
    const modes = new Map<string, Set<string>>()
    for (const line of sortedLines) {
      for (const item of line.lineStations) {
        if (!modes.has(item.stationId)) modes.set(item.stationId, new Set())
        modes.get(item.stationId)!.add(line.mode)
      }
    }
    return new Set([...modes].filter(([, set]) => set.size === 1 && set.has('BUS')).map(([stationId]) => stationId))
  }, [sortedLines])
  const mapDef = getCityMap(state?.city.mapKey)
  const people = useMemo(() => {
    if (!state) return []
    const waiting = state.stationStats.reduce((sum, station) => sum + station.waitingCount, 0)
    const tick = state.city.currentTick
    return createPeople(
      state.city.seed,
      waiting,
      getCityMap(state.city.mapKey),
      periodIndexOfHour((tick / 6) % 24),
      Math.floor(tick / 144) % 7 >= 5,
    )
  }, [state])
  const waitingByStation = useMemo(
    () => new Map(state?.stationStats.map(stat => [stat.stationId, stat.waitingCount]) ?? []),
    [state],
  )

  useEffect(() => {
    if (!selectedVehicleId || !state) return
    const stillExists = state.city.lines.some(line => line.vehicles.some(vehicle => vehicle.id === selectedVehicleId))
    if (!stillExists) setSelectedVehicleId('')
  }, [selectedVehicleId, state])

  const performAction = async (action: CityAction) => {
    setBusy(true)
    setError(null)
    try {
      await executeCityAction(cityId, action)
      const next = await loadCity()
      if (action.type === 'REMOVE_VEHICLE') setSelectedVehicleId('')
      return next
    } catch (err) {
      setError(err instanceof Error ? err.message : '작업 실행 오류')
      return null
    } finally {
      setBusy(false)
    }
  }
  performActionRef.current = performAction

  const selectLine = (lineId: string) => {
    setSelectedLineId(lineId)
    setSelectedVehicleId('')
    setError(null)
  }

  const selectVehicle = (lineId: string, vehicleId: string) => {
    setSelectedLineId(lineId)
    setSelectedVehicleId(vehicleId)
    setStationBuildMode(false)
    setError(null)
  }

  const handleStationClick = (event: MouseEvent<SVGGElement>, stationId: string) => {
    event.stopPropagation()
    if (busy) return
    if (linkMode) {
      if (!selectedLineId) {
        setError('먼저 노선을 선택해주세요.')
        return
      }
      if (!linkFromId) {
        setLinkFromId(stationId)
        return
      }
      if (linkFromId === stationId) {
        setLinkFromId('')
        return
      }
      void performAction({
        type: 'BUILD_SEGMENT',
        lineId: selectedLineId,
        fromStationId: linkFromId,
        toStationId: stationId,
      }).then(next => {
        // 연결 성공 시 방금 이은 역에서 이어서 연결 가능
        setLinkFromId(next ? stationId : '')
      })
      return
    }
    const station = stationById.get(stationId)
    setSelectedStationId(stationId)
    setRenameValue(station?.name ?? '')
  }

  const handleMapClick = (event: MouseEvent<SVGSVGElement>) => {
    if (suppressMapClick.current) {
      suppressMapClick.current = false
      return
    }
    if (busy || (!stationBuildMode && !moveStationMode)) return
    const svg = mapRef.current
    const matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return
    const point = svg.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const mapPoint = point.matrixTransform(matrix.inverse())
    const posX = Math.round(Math.max(4, Math.min(96, mapPoint.x)) * 10) / 10
    const posY = Math.round(Math.max(4, Math.min(92, mapPoint.y)) * 10) / 10
    if (!mapDef.isLand(posX, posY)) {
      setError(moveStationMode ? '물 위로는 역을 옮길 수 없습니다.' : '물 위에는 역을 지을 수 없습니다.')
      return
    }
    if (moveStationMode) {
      if (!selectedStationId) return
      void performAction({ type: 'MOVE_STATION', stationId: selectedStationId, posX, posY }).then(next => {
        if (next) setMoveStationMode(false)
      })
      return
    }
    const name = stationName.trim() || `신설역 ${state!.city.stations.length + 1}`
    void performAction({ type: 'BUILD_STATION', name, posX, posY }).then(next => {
      if (!next) return
      setStationName('')
      setStationBuildMode(false)
    })
  }

  const clampMapView = (view: MapView) => ({
    ...view,
    x: Math.max(-8, Math.min(108 - view.width, view.x)),
    y: Math.max(-6, Math.min(106 - view.height, view.y)),
  })

  const zoomMap = (factor: number) => {
    setMapView(current => {
      const width = Math.max(34, Math.min(100, current.width * factor))
      const height = Math.max(34, Math.min(100, current.height * factor))
      const centerX = current.x + current.width / 2
      const centerY = current.y + current.height / 2
      return clampMapView({ x: centerX - width / 2, y: centerY - height / 2, width, height })
    })
  }

  const handleMapPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || stationBuildMode || moveStationMode) return
    if ((event.target as Element).closest('[data-map-interactive]')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    mapPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startView: mapView,
      moved: false,
    }
    setIsMapPanning(true)
  }

  const handleMapPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const pan = mapPanRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    const rect = event.currentTarget.getBoundingClientRect()
    const dx = (event.clientX - pan.startX) * pan.startView.width / rect.width
    const dy = (event.clientY - pan.startY) * pan.startView.height / rect.height
    pan.moved ||= Math.hypot(event.clientX - pan.startX, event.clientY - pan.startY) > 4
    setMapView(clampMapView({ ...pan.startView, x: pan.startView.x - dx, y: pan.startView.y - dy }))
  }

  const endMapPan = (event: PointerEvent<SVGSVGElement>) => {
    const pan = mapPanRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    suppressMapClick.current = pan.moved
    if (pan.moved) window.setTimeout(() => { suppressMapClick.current = false }, 0)
    mapPanRef.current = null
    setIsMapPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleMapWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    zoomMap(event.deltaY > 0 ? 1.16 : 0.86)
  }

  const beginVehiclePointerDrag = (
    event: PointerEvent<HTMLElement | SVGGElement>,
    lineId: string,
    vehicleId: string,
  ) => {
    if (event.button !== 0 || busy) return
    event.preventDefault()
    event.stopPropagation()
    selectVehicle(lineId, vehicleId)
    const nextDrag = {
      lineId,
      vehicleId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
    }
    vehicleDragRef.current = nextDrag
    setVehicleDrag(nextDrag)
  }

  const draggedVehicleId = vehicleDrag?.vehicleId
  useEffect(() => {
    if (!draggedVehicleId) return

    const updateTarget = (x: number, y: number) => {
      const element = document.elementFromPoint(x, y)
      const depot = element?.closest('[data-depot-line-id]')
      if (depot) {
        setDragTarget({ kind: 'DEPOT', id: depot.getAttribute('data-depot-line-id') ?? '' })
        return
      }
      const station = element?.closest('[data-station-id]')
      if (station) {
        setDragTarget({ kind: 'STATION', id: station.getAttribute('data-station-id') ?? '' })
        return
      }
      setDragTarget(null)
    }

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const current = vehicleDragRef.current
      if (!current) return
      const active = current.active || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 5
      const next = { ...current, x: event.clientX, y: event.clientY, active }
      vehicleDragRef.current = next
      setVehicleDrag(next)
      if (active) updateTarget(event.clientX, event.clientY)
    }

    const handlePointerUp = (event: globalThis.PointerEvent) => {
      const current = vehicleDragRef.current
      vehicleDragRef.current = null
      setVehicleDrag(null)
      setDragTarget(null)
      const currentState = stateRef.current
      if (!current?.active || !currentState) return

      const sourceLine = currentState.city.lines.find(line => line.id === current.lineId)
      const vehicle = sourceLine?.vehicles.find(item => item.id === current.vehicleId)
      const element = document.elementFromPoint(event.clientX, event.clientY)
      const depotLineId = element?.closest('[data-depot-line-id]')?.getAttribute('data-depot-line-id')
      const stationId = element?.closest('[data-station-id]')?.getAttribute('data-station-id')

      if (sourceLine && vehicle && depotLineId && depotLineId !== sourceLine.id) {
        const runAction = performActionRef.current
        if (!runAction) return
        void runAction({
          type: 'TRANSFER_VEHICLE',
          lineId: sourceLine.id,
          vehicleId: vehicle.id,
          targetLineId: depotLineId,
        }).then(next => {
          if (!next) return
          setSelectedLineId(depotLineId)
          setSelectedVehicleId(vehicle.id)
        })
        return
      }

      if (sourceLine && vehicle?.status === 'SPARE' && stationId && lineHasStation(sourceLine, stationId)) {
        void performActionRef.current?.({
          type: 'DEPLOY_VEHICLE',
          lineId: sourceLine.id,
          vehicleId: vehicle.id,
          stationId,
        })
      }
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp, { once: true })
    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
    }
  }, [draggedVehicleId])

  if (!state) {
    return (
      <div className={styles.loadingPage}>
        <span className={styles.loadingDot} />
        {error ?? '도시 로딩 중'}
      </div>
    )
  }

  const currentTick = state.city.currentTick
  // 확대해도 역·글씨·점이 화면 기준 크기를 유지하도록 counter-scale
  const mapScale = mapView.width / 100
  const selectedStation = stationById.get(selectedStationId) ?? null
  const gameHour = (currentTick / 6) % 24
  // 서버 isWeekendTick과 동일 공식 (1게임일 = 144틱, 7일 주기 중 6·7일차)
  const isWeekend = Math.floor(currentTick / 144) % 7 >= 5
  const elapsedSeconds = currentTick * (LIVE_TICK_MS / 1000) + motionProgress * (LIVE_TICK_MS / 1000)
  const latestMetric = state.city.ticks[0]
  const score = latestMetric?.serviceScore ?? 100
  const totalVehicles = state.city.lines.reduce((sum, line) => sum + line.vehicles.length, 0)
  const waitingPassengers = state.stationStats.reduce((sum, station) => sum + station.waitingCount, 0)

  return (
    <div className={styles.page}>
      <aside className={styles.controlRoom}>
        <div className={styles.controlHeader}>
          <button className={styles.backButton} onClick={onBack} aria-label="도시 선택으로 돌아가기">←</button>
          <div>
            <span>{mapDef.key} CONTROL</span>
            <h1>도시 운영실</h1>
          </div>
        </div>

        <div className={styles.liveStatus}>
          <span className={styles.liveDot} />
          <b>실시간 자동 운행</b>
        </div>

        <section className={styles.controlSection}>
          <div className={styles.sectionHeading}><span>01</span><h2>운영 노선</h2></div>
          <div className={styles.lineTabs}>
            {sortedLines.map(line => (
              <button
                key={line.id}
                className={line.id === selectedLineId ? styles.lineTabActive : ''}
                onClick={() => selectLine(line.id)}
              >
                <i style={{ background: LINE_COLORS[line.color] }} />
                <span>{line.name}</span>
                <small>{line.status === 'SUSPENDED' ? '폐쇄' : '운행'}</small>
              </button>
            ))}
          </div>
          {selectedLine && (
            <button
              className={selectedLine.status === 'SUSPENDED' ? styles.reopenButton : styles.closeButton}
              onClick={() => void performAction({
                type: 'SET_LINE_STATUS',
                lineId: selectedLine.id,
                status: selectedLine.status === 'SUSPENDED' ? 'OPERATING' : 'SUSPENDED',
              })}
              disabled={busy}
            >
              {selectedLine.status === 'SUSPENDED' ? `${selectedLine.name} 운행 재개` : `${selectedLine.name} 폐쇄`}
            </button>
          )}
        </section>

        {selectedLine && (
          <section className={styles.controlSection}>
            <div className={styles.sectionHeading}><span>02</span><h2>{selectedLine.mode === 'BUS' ? '차량' : '철도 차량'}</h2></div>
            <div className={styles.vehicleList}>
              {selectedLine.vehicles.map((vehicle, index) => {
                const station = vehicle.currentStationId ? stationById.get(vehicle.currentStationId) : null
                const intervalSeconds = vehicleTiming(vehicle.id, selectedLine.mode).interval * (LIVE_TICK_MS / 1000)
                return (
                  <div key={vehicle.id} className={styles.vehicleRow}>
                    <button
                      className={`${styles.vehicleCard} ${vehicle.id === selectedVehicleId ? styles.vehicleSelected : ''}`}
                      aria-pressed={vehicle.id === selectedVehicleId}
                      onClick={() => selectVehicle(selectedLine.id, vehicle.id)}
                      onPointerDown={event => beginVehiclePointerDrag(event, selectedLine.id, vehicle.id)}
                    >
                      <span className={styles.trainBadge} style={{ background: LINE_COLORS[selectedLine.color] }}>
                        <i /><i /><b>{index + 1}</b>
                      </span>
                      <span>
                        <b>{selectedLine.name} 차량 {index + 1}</b>
                        <small>{station?.name ?? `${selectedLine.name} 차고지`} · {trainStatus(vehicle)} · {intervalSeconds}초</small>
                      </span>
                    </button>
                    <button
                      className={vehicle.status === 'OPERATING' ? styles.storeVehicleButton : styles.startVehicleButton}
                      onClick={() => void performAction({
                        type: 'SET_VEHICLE_SERVICE',
                        lineId: selectedLine.id,
                        vehicleId: vehicle.id,
                        inService: vehicle.status !== 'OPERATING',
                      })}
                      disabled={busy || !['OPERATING', 'SPARE'].includes(vehicle.status)}
                    >{vehicle.status === 'OPERATING' ? '입고' : '운행'}</button>
                  </div>
                )
              })}
            </div>

            {selectedVehicle && (
              <button
                className={styles.removeVehicleButton}
                onClick={() => void performAction({
                  type: 'REMOVE_VEHICLE',
                  lineId: selectedVehicleLine!.id,
                  vehicleId: selectedVehicle.id,
                })}
                disabled={busy}
              >선택 차량 제거</button>
            )}
          </section>
        )}

        {selectedStation && (
          <section className={styles.controlSection}>
            <div className={styles.sectionHeading}><span>03</span><h2>역 관리</h2></div>
            <div className={styles.actionForm}>
              <label htmlFor="station-rename">역 이름</label>
              <div>
                <input
                  id="station-rename"
                  className={styles.stationNameInput}
                  value={renameValue}
                  maxLength={12}
                  onChange={event => setRenameValue(event.target.value)}
                  aria-label={`${selectedStation.name} 이름 수정`}
                />
                <button
                  onClick={() => void performAction({
                    type: 'RENAME_STATION',
                    stationId: selectedStation.id,
                    name: renameValue.trim(),
                  })}
                  disabled={busy || !renameValue.trim() || renameValue.trim() === selectedStation.name}
                >변경</button>
              </div>
            </div>
            <button
              className={moveStationMode ? styles.reopenButton : styles.modeButton}
              aria-pressed={moveStationMode}
              onClick={() => {
                setMoveStationMode(current => !current)
                setStationBuildMode(false)
                setLinkMode(false)
                setLinkFromId('')
                setError(null)
              }}
              disabled={busy}
            >{moveStationMode ? '옮길 위치를 지도에서 클릭' : `${selectedStation.name} 위치 이동`}</button>
            <button
              className={styles.removeVehicleButton}
              onClick={() => {
                if (!window.confirm(`${selectedStation.name}을 삭제할까요? 연결된 노선에서도 제거됩니다.`)) return
                void performAction({ type: 'REMOVE_STATION', stationId: selectedStation.id }).then(next => {
                  if (next) setSelectedStationId('')
                })
              }}
              disabled={busy}
            >{selectedStation.name} 삭제</button>
          </section>
        )}

        {error && <div className={styles.operationError} role="alert">! {error}</div>}
      </aside>

      <main className={styles.gameStage}>
        <header className={styles.hudTop}>
          <div className={styles.cityIdentity}>
            <span className={styles.cityName}>{state.city.name}</span>
            <span>{Math.floor(currentTick / 144) + 1}일차{isWeekend ? ' · 주말' : ''} · {formatHour(gameHour)}</span>
          </div>
          <div className={styles.hudStats}>
            <span><small>점수</small><b>{Math.round(score)}</b></span>
            <span><small>대기 승객</small><b>{waitingPassengers}명</b></span>
            <span><small>차량</small><b>{totalVehicles}대</b></span>
            <span className={styles.tickNumber}><small>흐른 시간</small><b>{formatElapsed(elapsedSeconds)}</b></span>
          </div>
        </header>

        <div className={styles.mapCanvas} aria-label={`${mapDef.name} 도시 노선도`}>
          <div className={styles.mapControls}>
            <div className={styles.stationBuilder}>
              <button
                className={stationBuildMode ? styles.stationBuilderActive : ''}
                aria-pressed={stationBuildMode}
                onClick={() => {
                  setStationBuildMode(current => !current)
                  setLinkMode(false)
                  setLinkFromId('')
                  setMoveStationMode(false)
                  setSelectedVehicleId('')
                  setError(null)
                }}
              >＋ 역 짓기</button>
              <button
                className={linkMode ? styles.stationBuilderActive : ''}
                aria-pressed={linkMode}
                onClick={() => {
                  setLinkMode(current => !current)
                  setLinkFromId('')
                  setStationBuildMode(false)
                  setMoveStationMode(false)
                  setSelectedVehicleId('')
                  setError(null)
                }}
              >⤳ 선로 잇기</button>
              {linkMode && (
                <div>
                  <small>{linkFromId ? '연결할 다음 역 클릭' : `${selectedLine?.name ?? '노선'}에 이을 첫 역 클릭`}</small>
                </div>
              )}
              {stationBuildMode && (
                <div>
                  <input
                    value={stationName}
                    onChange={event => setStationName(event.target.value)}
                    placeholder={`신설역 ${state.city.stations.length + 1}`}
                    maxLength={12}
                    aria-label="새 역 이름"
                  />
                  <small>지상 위치 클릭</small>
                </div>
              )}
            </div>
            <div className={styles.zoomControls} aria-label="지도 확대 축소">
              <button onClick={() => zoomMap(0.78)} aria-label="지도 확대">＋</button>
              <span>{(100 / mapView.width).toFixed(1)}×</span>
              <button onClick={() => zoomMap(1.28)} aria-label="지도 축소">−</button>
              <button onClick={() => setMapView(INITIAL_MAP_VIEW)} aria-label="지도 전체 보기">⌂</button>
            </div>
          </div>
          <svg
            ref={mapRef}
            className={`${styles.cityMap} ${stationBuildMode || moveStationMode ? styles.stationBuildCursor : ''} ${isMapPanning ? styles.mapPanning : ''}`}
            viewBox={`${mapView.x} ${mapView.y} ${mapView.width} ${mapView.height}`}
            role="img"
            aria-label={`${mapDef.name} 지형과 일반역, 환승역, 노선 차고지`}
            onClick={handleMapClick}
            onPointerDown={handleMapPointerDown}
            onPointerMove={handleMapPointerMove}
            onPointerUp={endMapPan}
            onPointerCancel={endMapPan}
            onWheel={handleMapWheel}
          >
            <defs>
              <pattern id="map-grid" width="5" height="5" patternUnits="userSpaceOnUse">
                <path d="M 5 0 L 0 0 0 5" fill="none" stroke="rgba(26,22,19,.035)" strokeWidth=".18" />
              </pattern>
              <clipPath id="city-land-clip">
                <path d={mapDef.landPath} />
                {mapDef.islandPaths.map((path, index) => <path key={index} d={path} />)}
              </clipPath>
            </defs>
            <rect width="100" height="100" className={styles.sea} />
            <path
              className={styles.busanLand}
              d={mapDef.landPath}
            />
            {mapDef.islandPaths.map((path, index) => (
              <path key={`island-${index}`} className={styles.yeongdo} d={path} />
            ))}
            <g clipPath="url(#city-land-clip)" aria-label="도시 구역">
              {mapDef.zones.map((zone, index) => (
                <path key={`zone-${index}`} className={styles[`zone_${zone.kind}`]} d={polyPath(zone.points)} />
              ))}
            </g>
            <path className={styles.mapGrid} d="M0 0H100V100H0Z" />
            {mapDef.rivers.map((river, index) => (
              <path
                key={`river-${index}`}
                className={styles.nakdongRiver}
                d={river.d}
                style={{ strokeWidth: river.width, opacity: river.opacity }}
              />
            ))}
            <g className={styles.mountains}>
              {mapDef.mountainPaths.map((path, index) => <path key={index} d={path} />)}
            </g>
            <g className={styles.districtLabels}>
              {mapDef.districts.map(district => (
                <text key={district.label} x={district.x} y={district.y}>{district.label}</text>
              ))}
            </g>

            <g className={styles.peopleLayer} clipPath="url(#city-land-clip)" aria-label="도시 인구">
              {people.map((person, index) => (
                <circle
                  key={index}
                  cx={person.x}
                  cy={person.y}
                  r={person.radius * mapScale}
                  opacity={person.opacity}
                  className={person.warm ? styles.personDotWarm : styles.personDot}
                />
              ))}
            </g>

            {sortedLines.map(line => {
              const nearest = nearestStationToDepot(line)
              if (!nearest) return null
              return (
                <line
                  key={`depot-spur-${line.id}`}
                  x1={line.depotX}
                  y1={line.depotY}
                  x2={nearest.posX}
                  y2={nearest.posY}
                  className={styles.depotSpur}
                  style={{ stroke: LINE_COLORS[line.color] }}
                />
              )
            })}

            {sortedLines.filter(line => line.lineStations.length > 1).map(line => (
              <g
                key={line.id}
                className={line.status === 'SUSPENDED' ? styles.closedLine : ''}
                data-map-interactive="true"
                role="button"
                tabIndex={0}
                aria-label={`${line.name} 선택`}
                onClick={event => { event.stopPropagation(); selectLine(line.id) }}
              >
                {line.mode !== 'BUS' && <polyline points={linePoints(line)} className={styles.lineShadow} />}
                <polyline
                  points={linePoints(line)}
                  className={`${styles.linePath} ${line.mode === 'BUS' ? styles.busPath : ''} ${line.id === selectedLineId ? styles.selectedLinePath : ''}`}
                  style={{ stroke: LINE_COLORS[line.color] }}
                />
              </g>
            ))}

            {state.city.stations.map(station => {
              const point = stationPoint(station)
              const isInterchange = interchangeStationIds.has(station.id)
              const isBusStop = busOnlyStationIds.has(station.id)
              const isCurrentVehicleStation = selectedVehicle?.currentStationId === station.id
              const isDropTarget = dragTarget?.kind === 'STATION' && dragTarget.id === station.id
              const highlighted = isCurrentVehicleStation || isDropTarget
                || station.id === linkFromId || (!linkMode && station.id === selectedStationId)
              return (
                <g
                  key={station.id}
                  transform={`translate(${point.x} ${point.y}) scale(${mapScale})`}
                  className={styles.stationGroup}
                  onClick={event => handleStationClick(event, station.id)}
                  role="button"
                  tabIndex={0}
                  data-station-id={station.id}
                  data-map-interactive="true"
                  aria-label={`${station.name} ${isBusStop ? '버스 정류장' : isInterchange ? '환승역' : '일반역'} 선택`}
                >
                  <title>{station.name} · {isBusStop ? '버스 정류장' : isInterchange ? '환승역' : '일반역'}</title>
                  {highlighted && <circle r="3.3" className={styles.stationSelection} />}
                  {isBusStop ? (
                    <>
                      <rect x="-1.7" y="-1.7" width="3.4" height="3.4" rx=".5" className={styles.stationHalo} />
                      <rect x="-1.2" y="-1.2" width="2.4" height="2.4" rx=".4" className={styles.stationNode} />
                    </>
                  ) : isInterchange ? (
                    <>
                      <circle r="2.45" className={styles.stationHalo} />
                      <circle r="1.85" className={styles.stationNode} />
                      <circle r=".75" className={styles.transferCore} />
                    </>
                  ) : (
                    <>
                      <circle r="2" className={styles.stationHalo} />
                      <circle r="1.4" className={styles.stationNode} />
                    </>
                  )}
                  {Array.from({ length: Math.min(Math.ceil((waitingByStation.get(station.id) ?? 0) / 5), 12) }, (_, dotIndex) => (
                    <circle
                      key={dotIndex}
                      cx={2.5 + (dotIndex % 6) * 0.95}
                      cy={-0.4 + Math.floor(dotIndex / 6) * 1.05}
                      r=".42"
                      className={styles.queueDot}
                    />
                  ))}
                </g>
              )
            })}

            {sortedLines.map(line => {
              const spareCount = line.vehicles.filter(vehicle => vehicle.status === 'SPARE').length
              const isDropTarget = dragTarget?.kind === 'DEPOT' && dragTarget.id === line.id
              return (
                <g
                  key={`depot-${line.id}`}
                  transform={`translate(${line.depotX} ${line.depotY}) scale(${mapScale})`}
                  className={`${styles.depot} ${isDropTarget ? styles.depotDropTarget : ''}`}
                  data-depot-line-id={line.id}
                  data-map-interactive="true"
                  role="button"
                  tabIndex={0}
                  aria-label={`${line.name} 차고지 · 예비 차량 ${spareCount}대`}
                  onClick={event => { event.stopPropagation(); selectLine(line.id) }}
                >
                  <circle r="4.7" className={styles.depotHitArea} />
                  <rect x="-3" y="-2.3" width="6" height="4.6" rx=".8" className={styles.depotBuilding} />
                  <path d="M-2 2.3V4M0 2.3V4M2 2.3V4" className={styles.depotRails} />
                  <rect x="-2.1" y="-1.05" width="4.2" height="1.85" rx=".45" fill={LINE_COLORS[line.color]} />
                  <text y="-3.9" textAnchor="middle" className={styles.depotLabel}>{line.name} 차고지</text>
                  {spareCount > 0 && <text x="3.4" y="3.7" textAnchor="middle" className={styles.depotCount}>{spareCount}</text>}
                </g>
              )
            })}

            {state.city.lines.flatMap(line => line.vehicles
              .filter(vehicle => vehicle.status === 'OPERATING' && vehicle.currentStationId)
              .map(vehicle => {
                const station = stationById.get(vehicle.currentStationId!)
                if (!station) return null
                const scheduledToMove = line.status === 'OPERATING' && shouldVehicleMove(vehicle.id, currentTick + 1, line.mode)
                const nextStation = scheduledToMove ? nextStationOnLine(line, vehicle) : null
                const point = stationPoint(station)
                const nextPoint = nextStation ? stationPoint(nextStation) : point
                const lineNo = line.name.match(/\d+/)?.[0] ?? line.name.slice(0, 1)
                const progress = nextStation ? motionProgress : 0
                const trainX = point.x + (nextPoint.x - point.x) * progress
                const trainY = point.y + (nextPoint.y - point.y) * progress
                const rawAngle = nextStation
                  ? Math.atan2(nextPoint.y - point.y, nextPoint.x - point.x) * 180 / Math.PI
                  : 0
                // 왼쪽 방향 이동 시 180° 회전으로 뒤집히지 않게 좌우 반전으로 처리
                const trainFlipped = Math.abs(rawAngle) > 90
                const trainAngle = trainFlipped ? rawAngle - 180 * Math.sign(rawAngle) : rawAngle
                const dragging = vehicleDrag?.active && vehicleDrag.vehicleId === vehicle.id
                return (
                  <g
                    key={vehicle.id}
                    transform={`translate(${trainX} ${trainY}) rotate(${trainAngle})${trainFlipped ? ' scale(-1,1)' : ''}`}
                    className={`${styles.trainIcon} ${vehicle.id === selectedVehicleId ? styles.selectedTrain : ''} ${dragging ? styles.trainDragging : ''}`}
                    onClick={event => { event.stopPropagation(); selectVehicle(line.id, vehicle.id) }}
                    onPointerDown={event => beginVehiclePointerDrag(event, line.id, vehicle.id)}
                    role="button"
                    tabIndex={0}
                    aria-label={`${line.name} 차량 선택`}
                    aria-pressed={vehicle.id === selectedVehicleId}
                    data-vehicle-id={vehicle.id}
                    data-from-station={station.id}
                    data-to-station={nextStation?.id ?? station.id}
                    data-motion-progress={progress.toFixed(3)}
                    data-move-interval={vehicleTiming(vehicle.id, line.mode).interval}
                    data-map-interactive="true"
                  >
                    <rect x="-3.7" y="-2" width="7.4" height="4" rx="1.2" fill={LINE_COLORS[line.color]} className={styles.trainBody} />
                    <rect x="-2.8" y="-1.2" width="1.55" height="1.25" rx=".28" className={styles.trainWindow} />
                    <rect x="-.65" y="-1.2" width="1.55" height="1.25" rx=".28" className={styles.trainWindow} />
                    <circle cx="-2.15" cy="1.85" r=".56" className={styles.trainWheel} />
                    <circle cx="2.15" cy="1.85" r=".56" className={styles.trainWheel} />
                    <text x="2.2" y=".55" textAnchor="middle" className={styles.trainNumber} transform={trainFlipped ? 'scale(-1,1)' : undefined}>{lineNo}</text>
                  </g>
                )
              }))}

            {/* 역 이름은 항상 최상단 (SVG는 그리는 순서 = z-order) */}
            <g className={styles.stationLabelLayer}>
              {state.city.stations.map(station => (
                <text
                  key={`label-${station.id}`}
                  transform={`translate(${station.posX} ${station.posY}) scale(${mapScale})`}
                  y={station.name === '서면역' ? 4.9 : -3.15}
                  textAnchor="middle"
                  className={styles.stationLabel}
                >{station.name}</text>
              ))}
            </g>
          </svg>

          <div className={styles.mapLegend}>
            {sortedLines.map(line => (
              <button
                key={line.id}
                className={line.id === selectedLineId ? styles.mapLegendActive : ''}
                onClick={() => selectLine(line.id)}
              >
                <i style={{ background: LINE_COLORS[line.color] }} />{line.name}{line.status === 'SUSPENDED' ? ' · 폐쇄' : ''}
              </button>
            ))}
          </div>

          <div className={styles.stationLegend} aria-label="역 종류">
            <span><i className={styles.regularStationMark} />일반역</span>
            <span><i className={styles.interchangeStationMark} />환승역</span>
            <span><i className={styles.busStopMark} />버스 정류장</span>
            <span><i className={styles.depotMark} />차고지</span>
          </div>

          <div className={styles.zoneLegend} aria-label="구역 종류">
            <span><i className={styles.zoneMarkResidential} />주거 구역</span>
            <span><i className={styles.zoneMarkCommercial} />상업 구역</span>
            <span><i className={styles.zoneMarkIndustrial} />산업·오피스 구역</span>
          </div>
        </div>
      </main>

      {vehicleDrag?.active && (
        <div className={styles.vehicleDragGhost} style={{ left: vehicleDrag.x, top: vehicleDrag.y }}>
          <span style={{ background: LINE_COLORS[selectedVehicleLine?.color ?? 'RED'] }} />
          {selectedVehicleLine?.name} 차량
        </div>
      )}
    </div>
  )
}
