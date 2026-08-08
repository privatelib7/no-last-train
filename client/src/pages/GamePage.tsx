import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from 'react'
import {
  ApiError,
  CONGESTION_SATURATED,
  CONGESTION_WARN,
  executeCityAction,
  fetchCity,
  planCityCommand,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  type CityAction,
  type CityState,
  type GameLine,
  type Station,
  type Vehicle,
} from '../api/game'
import type { AuthSession } from '../api/auth'
import { updateRoomTitle } from '../api/cities'
import { fetchCursors, leaveCursor, syncCursor, type RemoteCursor } from '../api/cursors'
import { scheduleMajorEventNotification, subscribePendingNotification } from '../lib/notifications'
import InviteModal from './InviteModal'
import { getCityMap, polyPath } from '../maps'
import { createCitizenJourneys, locateCitizen, type CitizenTravelMode } from '../mobility'
import { locateVehicle } from '../vehicle-motion'
import styles from './GamePage.module.css'

interface Props {
  cityId: string
  session: AuthSession | null
  onBack: () => void
  onRequireLogin: () => void
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

type StationLinkDrag = {
  stationId: string
  startX: number
  startY: number
  x: number
  y: number
  active: boolean
}

type SegmentDrag = {
  lineId: string
  fromStationId: string
  toStationId: string
  startX: number
  startY: number
  x: number
  y: number
  active: boolean
}

type MapView = { x: number; y: number; width: number; height: number }

type MapPanState = {
  pointerId: number
  startX: number
  startY: number
  startView: MapView
  moved: boolean
}

type CityCommandMessage = {
  id: number
  role: 'assistant' | 'user'
  text: string
  isError?: boolean
}

const LIVE_TICK_MS = 3000
const CURSOR_SYNC_MS = 45
const CURSOR_IDLE_TIMEOUT_MS = 2500
const CITIZEN_TIME_SCALE = 0.72
const GAME_MINUTES_PER_TICK = 60 / TICKS_PER_HOUR
const INITIAL_MAP_VIEW: MapView = { x: 0, y: 0, width: 100, height: 100 }

const LINE_COLORS: Record<string, string> = {
  RED: '#E9783C',
  BLUE: '#3F8EDB',
  GREEN: '#55A96A',
  YELLOW: '#E1B735',
  PURPLE: '#8E6CC1',
}

const CITIZEN_MODE_LABELS: Record<CitizenTravelMode, string> = {
  WALK: '역으로 이동 중',
  WAIT: '역에서 대기 중',
  BOARDING: '차량 탑승 중',
}

const CITIZEN_MODE_CLASSES: Record<CitizenTravelMode, string> = {
  WALK: styles.personWalking,
  WAIT: styles.personWaiting,
  BOARDING: styles.personBoarding,
}

function formatHour(hour: number) {
  const normalized = ((hour % 24) + 24) % 24
  const h = Math.floor(normalized)
  const m = Math.floor((normalized - h) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function formatElapsed(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return [hours, minutes, secs].map(value => String(value).padStart(2, '0')).join(':')
}

// 게임 화폐 ₵ 표기 (₵1 = 1만 원)
function formatMoney(value: number) {
  const sign = value < 0 ? '-' : ''
  return `${sign}₵${Math.round(Math.abs(value) / 10_000).toLocaleString('ko-KR')}`
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
  if (vehicle.isSpare) return '차고지 대기'
  if (vehicle.status === 'OPERATING') return '운행 중'
  if (vehicle.status === 'LOANED') return '지원 운행'
  if (vehicle.status === 'MAINTENANCE') return '정비 중'
  return '운행 불가'
}

function orderedVehicles(line: GameLine) {
  return line.vehicles.slice().sort((a, b) => a.id.localeCompare(b.id))
}

function lineHasStation(line: GameLine, stationId: string) {
  return line.lineStations.some(item => item.stationId === stationId)
}

function nearestStationToDepot(line: GameLine) {
  return orderedStations(line).reduce<Station | null>((nearest, station) => {
    if (!nearest) return station
    const currentDistance = Math.hypot(station.posX - line.depotX, station.posY - line.depotY)
    const nearestDistance = Math.hypot(nearest.posX - line.depotX, nearest.posY - line.depotY)
    return currentDistance < nearestDistance ? station : nearest
  }, null)
}

function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}

// 자동 생성 이름(신설역 N)은 라벨을 표시하지 않는다 — 사용자가 이름을 지으면 표시
function isAutoStationName(name: string) {
  return /^신설역 \d+$/.test(name)
}
export default function GamePage({ cityId, session, onBack, onRequireLogin }: Props) {
  const [state, setState] = useState<CityState | null>(null)
  const [selectedLineId, setSelectedLineId] = useState('')
  const [selectedVehicleId, setSelectedVehicleId] = useState('')
  const [stationBuildMode, setStationBuildMode] = useState(false)
  const [stationName, setStationName] = useState('')
  const [selectedStationId, setSelectedStationId] = useState('')
  const [renameValue, setRenameValue] = useState('')
  const [moveStationMode, setMoveStationMode] = useState(false)
  const [legendOpen, setLegendOpen] = useState(false)
  const [vehicleDrag, setVehicleDrag] = useState<VehicleDragState | null>(null)
  const [stationDrag, setStationDrag] = useState<StationLinkDrag | null>(null)
  const [segmentDrag, setSegmentDrag] = useState<SegmentDrag | null>(null)
  const [dragTarget, setDragTarget] = useState<DragTarget>(null)
  const [mapView, setMapView] = useState<MapView>(INITIAL_MAP_VIEW)
  const [isMapPanning, setIsMapPanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorStatus, setErrorStatus] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [clockNowMs, setClockNowMs] = useState(() => Date.now())
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)
  const [notifyStatus, setNotifyStatus] = useState<'idle' | 'pending' | 'sent' | 'denied' | 'unsupported' | 'busy'>('idle')
  const [notifySecondsLeft, setNotifySecondsLeft] = useState(0)
  const [commandInput, setCommandInput] = useState('')
  const [commandBusy, setCommandBusy] = useState(false)
  const [commandMessages, setCommandMessages] = useState<CityCommandMessage[]>([{
    id: 0,
    role: 'assistant',
    text: '역과 노선 이름을 사용해 운영 명령을 내려주세요. 실행 결과를 바로 보고드릴게요.',
  }])
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([])
  const ticking = useRef(false)
  const cursorPosRef = useRef<{ x: number; y: number; ts: number } | null>(null)
  const cursorLastSentRef = useRef<{ x: number; y: number } | null>(null)
  const vehicleDragRef = useRef<VehicleDragState | null>(null)
  const stationDragRef = useRef<StationLinkDrag | null>(null)
  const segmentDragRef = useRef<SegmentDrag | null>(null)
  const suppressStationClick = useRef(false)
  const suppressLineClick = useRef(false)
  const mapPanRef = useRef<MapPanState | null>(null)
  const suppressMapClick = useRef(false)
  const mapRef = useRef<SVGSVGElement | null>(null)
  const stateRef = useRef<CityState | null>(null)
  const performActionRef = useRef<((action: CityAction) => Promise<CityState | null>) | null>(null)
  const commandMessageId = useRef(0)
  const commandLogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  // ESC로 역 선택·건설 모드 전부 해제
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setSelectedStationId('')
      setStationBuildMode(false)
      setMoveStationMode(false)
      setError(null)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    const log = commandLogRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [commandMessages, commandBusy])

  const loadCity = async () => {
    const next = await fetchCity(cityId, session?.token)
    setState(next)
    const firstLine = next.city.lines.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko'))[0]
    setSelectedLineId(current => current || firstLine?.id || '')
    return next
  }

  useEffect(() => {
    let cancelled = false
    fetchCity(cityId, session?.token)
      .then(next => {
        if (cancelled) return
        setState(next)
        const firstLine = next.city.lines.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko'))[0]
        setSelectedLineId(firstLine?.id ?? '')
      })
      .catch(err => {
        if (cancelled) return
        const status = err instanceof ApiError ? err.status : null
        if (status === 401 || status === 403) {
          setError(err instanceof Error ? err.message : '도시를 불러오지 못했습니다.')
          setErrorStatus(status)
          return
        }
        // 삭제된 도시 ID가 localStorage에 남은 경우 등 — 로비로 복귀
        onBack()
      })
    return () => { cancelled = true }
  }, [cityId, session?.token, onBack])

  useEffect(() => {
    let cancelled = false
    const timer = window.setInterval(async () => {
      if (ticking.current || busy) return
      ticking.current = true
      try {
        const next = await fetchCity(cityId, session?.token)
        if (!cancelled) {
          setState(next)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '자동 운행 연결 오류')
          setErrorStatus(err instanceof ApiError ? err.status : null)
        }
      } finally {
        ticking.current = false
      }
    }, 600)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [busy, cityId, session?.token])

  // 브라우저 창 전체 포인터 추적 (지도만이 아니라 페이지 전역, 뷰포트 % 좌표 0~100)
  useEffect(() => {
    if (!session) return
    const onMove = (event: globalThis.PointerEvent) => {
      const width = window.innerWidth || 1
      const height = window.innerHeight || 1
      cursorPosRef.current = {
        x: Math.max(0, Math.min(100, (event.clientX / width) * 100)),
        y: Math.max(0, Math.min(100, (event.clientY / height) * 100)),
        ts: Date.now(),
      }
    }
    const onLeaveWindow = () => {
      cursorPosRef.current = null
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('mouseleave', onLeaveWindow)
    window.addEventListener('blur', onLeaveWindow)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeaveWindow)
      window.removeEventListener('blur', onLeaveWindow)
    }
  }, [session])

  // 실시간 커서 동기화 — 창 안이면 POST, 창 밖이면 GET으로 상대 커서만 유지
  useEffect(() => {
    const token = session?.token
    if (!token) return
    let cancelled = false
    let inflight = false

    const pushCursors = async () => {
      if (cancelled || inflight) return
      inflight = true
      try {
        const pos = cursorPosRef.current
        const active = !!pos && Date.now() - pos.ts <= CURSOR_IDLE_TIMEOUT_MS
        const result = active && pos
          ? await syncCursor(cityId, token, pos.x, pos.y)
          : await fetchCursors(cityId, token)
        if (cancelled) return
        if (active && pos) cursorLastSentRef.current = { x: pos.x, y: pos.y }
        setRemoteCursors(result.cursors)
      } catch {
        // 일시 네트워크 오류는 다음 틱에서 재시도 — 기존 표시는 유지
      } finally {
        inflight = false
      }
    }

    const timer = window.setInterval(() => { void pushCursors() }, CURSOR_SYNC_MS)
    void pushCursors()
    return () => {
      cancelled = true
      window.clearInterval(timer)
      cursorPosRef.current = null
      cursorLastSentRef.current = null
      setRemoteCursors([])
      void leaveCursor(cityId, token)
    }
  }, [cityId, session?.token])

  useEffect(() => {
    let animationFrame = 0
    const animate = () => {
      setClockNowMs(Date.now())
      animationFrame = window.requestAnimationFrame(animate)
    }

    animationFrame = window.requestAnimationFrame(animate)
    return () => window.cancelAnimationFrame(animationFrame)
  }, [])

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
  const citizenJourneys = useMemo(() => {
    if (!state) return []
    const waiting = state.stationStats.reduce((sum, station) => sum + station.waitingCount, 0)
    const tick = state.city.currentTick
    return createCitizenJourneys({
      seed: state.city.seed,
      waitingCount: waiting,
      gameHour: (tick / TICKS_PER_HOUR) % 24,
      weekend: Math.floor(tick / TICKS_PER_DAY) % 7 >= 5,
      stations: state.city.stations,
      lines: state.city.lines,
      map: mapDef,
    })
  }, [state, mapDef])
  const congestionByStation = useMemo(
    () => new Map(state?.stationStats.map(stat => [stat.stationId, stat.congestion]) ?? []),
    [state],
  )

  const beginEditTitle = () => {
    if (!state?.isOwner || !session) return
    setTitleDraft(state.city.roomTitle)
    setEditingTitle(true)
  }

  const cancelEditTitle = () => {
    setEditingTitle(false)
    setTitleDraft('')
  }

  const saveRoomTitle = async () => {
    if (!state || !session || titleSaving) return
    const nextTitle = titleDraft.trim()
    if (!nextTitle) {
      setError('방제목을 입력해주세요.')
      return
    }
    if (nextTitle === state.city.roomTitle) {
      cancelEditTitle()
      return
    }
    setTitleSaving(true)
    setError(null)
    try {
      const updated = await updateRoomTitle(cityId, session.token, nextTitle)
      setState(current =>
        current
          ? { ...current, city: { ...current.city, roomTitle: updated.roomTitle } }
          : current,
      )
      cancelEditTitle()
    } catch (err) {
      setError(err instanceof Error ? err.message : '방제목을 바꾸지 못했습니다.')
    } finally {
      setTitleSaving(false)
    }
  }

  // 알림 예약은 모듈 전역 타이머라 로비로 나가도 유지된다. UI만 구독한다.
  useEffect(() => {
    return subscribePendingNotification((next) => {
      if (!next) {
        setNotifyStatus((prev) => (prev === 'pending' ? 'sent' : prev))
        setNotifySecondsLeft(0)
        return
      }
      setNotifyStatus('pending')
      setNotifySecondsLeft(Math.max(0, Math.ceil((next.firesAt - Date.now()) / 1000)))
    })
  }, [])

  useEffect(() => {
    if (notifyStatus !== 'pending') return
    const timer = window.setInterval(() => {
      setNotifySecondsLeft((prev) => Math.max(0, prev - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [notifyStatus])

  useEffect(() => {
    if (notifyStatus !== 'sent' && notifyStatus !== 'denied' && notifyStatus !== 'unsupported' && notifyStatus !== 'busy') {
      return
    }
    const timer = window.setTimeout(() => setNotifyStatus('idle'), 4000)
    return () => window.clearTimeout(timer)
  }, [notifyStatus])

  // 주요 이벤트 크롬 알림 테스트 — 버튼을 누르면 5초 뒤에 알림을 띄운다.
  const handleTestNotification = async () => {
    if (!state || notifyStatus === 'pending') return
    const result = await scheduleMajorEventNotification(state.city.roomTitle, 5000)
    if (result === 'scheduled') {
      setNotifyStatus('pending')
      setNotifySecondsLeft(5)
    } else {
      setNotifyStatus(result)
    }
  }

  useEffect(() => {
    if (!selectedVehicleId || !state) return
    const stillExists = state.city.lines.some(line => line.vehicles.some(vehicle => vehicle.id === selectedVehicleId))
    if (!stillExists) setSelectedVehicleId('')
  }, [selectedVehicleId, state])

  const performAction = async (action: CityAction) => {
    setBusy(true)
    setError(null)
    try {
      await executeCityAction(cityId, action, session?.token)
      const next = await loadCity()
      if (action.type === 'REMOVE_VEHICLE') setSelectedVehicleId('')
      if (action.type === 'RESET_CITY') {
        setStationBuildMode(false)
        setMoveStationMode(false)
        setSelectedVehicleId('')
        setSelectedStationId('')
      }
      return next
    } catch (err) {
      setError(err instanceof Error ? err.message : '작업 실행 오류')
      return null
    } finally {
      setBusy(false)
    }
  }
  performActionRef.current = performAction

  const appendCommandMessage = (message: Omit<CityCommandMessage, 'id'>) => {
    commandMessageId.current += 1
    setCommandMessages(current => [...current, { ...message, id: commandMessageId.current }])
  }

  const runCityCommand = async (rawCommand: string) => {
    const command = rawCommand.trim()
    if (!command || busy || commandBusy || !state?.isOwner) return

    appendCommandMessage({ role: 'user', text: command })
    setCommandInput('')
    setCommandBusy(true)
    setBusy(true)
    setError(null)

    try {
      const plan = await planCityCommand(cityId, command, session?.token)
      if (!plan.ok) {
        appendCommandMessage({
          role: 'assistant',
          text: `${plan.reason}\n${plan.suggestion}`,
          isError: true,
        })
        return
      }

      const results: string[] = []
      let createdLineId = ''
      for (const action of plan.actions) {
        const result = await executeCityAction(cityId, action, session?.token)
        results.push(result.message)
        if (result.line?.id) createdLineId = result.line.id
      }
      await loadCity()
      if (createdLineId) {
        setSelectedLineId(createdLineId)
        setSelectedVehicleId('')
        setSelectedStationId('')
      }
      appendCommandMessage({
        role: 'assistant',
        text: results.join('\n') || plan.summary,
      })
    } catch (err) {
      appendCommandMessage({
        role: 'assistant',
        text: err instanceof Error ? err.message : '명령을 실행하지 못했습니다.',
        isError: true,
      })
    } finally {
      setCommandBusy(false)
      setBusy(false)
    }
  }

  const createLine = async (mode: 'SUBWAY' | 'BUS') => {
    setBusy(true)
    setError(null)
    try {
      const result = await executeCityAction(cityId, { type: 'CREATE_LINE', mode }, session?.token)
      await loadCity()
      if (result.line?.id) {
        setSelectedLineId(result.line.id)
        setSelectedVehicleId('')
        setSelectedStationId('')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '노선 생성 오류')
    } finally {
      setBusy(false)
    }
  }

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

  const beginSegmentDrag = (event: PointerEvent<SVGGElement>, line: GameLine) => {
    if (event.button !== 0 || busy || stationBuildMode || moveStationMode) return
    const matrix = mapRef.current?.getScreenCTM()
    if (!matrix) return
    const pointer = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    const stations = orderedStations(line)
    let best: { fromStationId: string; toStationId: string; dist: number } | null = null
    for (let index = 0; index < stations.length - 1; index++) {
      const a = stations[index]
      const b = stations[index + 1]
      const dist = pointSegmentDistance(pointer.x, pointer.y, a.posX, a.posY, b.posX, b.posY)
      if (!best || dist < best.dist) best = { fromStationId: a.id, toStationId: b.id, dist }
    }
    if (!best) return
    event.stopPropagation()
    const next: SegmentDrag = {
      lineId: line.id,
      fromStationId: best.fromStationId,
      toStationId: best.toStationId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
    }
    segmentDragRef.current = next
    setSegmentDrag(next)
  }

  const beginStationLinkDrag = (event: PointerEvent<SVGGElement>, stationId: string) => {
    if (event.button !== 0 || busy || stationBuildMode || moveStationMode) return
    event.stopPropagation()
    const next: StationLinkDrag = {
      stationId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
    }
    stationDragRef.current = next
    setStationDrag(next)
  }

  const handleStationClick = (event: MouseEvent<SVGGElement>, stationId: string) => {
    event.stopPropagation()
    if (suppressStationClick.current) {
      suppressStationClick.current = false
      return
    }
    if (busy) return
    const station = stationById.get(stationId)
    const prevSelectedId = selectedStationId
    setSelectedStationId(stationId)
    setRenameValue(station?.name ?? '')
    // 역 두 개를 연달아 클릭하면 선택된 노선으로 바로 연결 (성공 시 두 번째 역에서 체인 계속)
    if (!prevSelectedId || prevSelectedId === stationId || !selectedLine) return
    const fromOnLine = lineHasStation(selectedLine, prevSelectedId)
    const toOnLine = lineHasStation(selectedLine, stationId)
    if (fromOnLine && toOnLine) return // 둘 다 이미 노선 위 — 단순 재선택으로 취급
    void performAction({
      type: 'BUILD_SEGMENT',
      lineId: selectedLine.id,
      fromStationId: prevSelectedId,
      toStationId: stationId,
    })
  }

  const handleMapClick = (event: MouseEvent<SVGSVGElement>) => {
    if (suppressMapClick.current) {
      suppressMapClick.current = false
      return
    }
    if (busy) return
    if (!stationBuildMode && !moveStationMode) {
      // 빈 지도 클릭 → 역 선택 해제 (연속 클릭 연결 시작점도 초기화)
      setSelectedStationId('')
      return
    }
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
    // 기본 이름은 비어 있는 신설역 번호를 찾는다 (삭제·중복으로 인한 충돌 방지)
    const usedNames = new Set(state!.city.stations.map(item => item.name))
    let nextNumber = state!.city.stations.length + 1
    while (usedNames.has(`신설역 ${nextNumber}`)) nextNumber++
    const name = stationName.trim() || `신설역 ${nextNumber}`
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

      if (sourceLine && vehicle && depotLineId && depotLineId !== sourceLine.id) {
        if (vehicle.status !== 'SPARE' || !vehicle.isSpare) {
          setError('운행 차량은 입고 버튼을 누른 뒤 다른 차고지로 이동해주세요.')
          return
        }
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
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp, { once: true })
    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
    }
  }, [draggedVehicleId])

  // 역에서 다른 역으로 끌어당겨 선로 연결
  const draggedStationId = stationDrag?.stationId
  useEffect(() => {
    if (!draggedStationId) return

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const current = stationDragRef.current
      if (!current) return
      const active = current.active || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 6
      const next = { ...current, x: event.clientX, y: event.clientY, active }
      stationDragRef.current = next
      setStationDrag(next)
      if (!active) return
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-station-id]')
      const targetId = target?.getAttribute('data-station-id')
      setDragTarget(targetId && targetId !== current.stationId ? { kind: 'STATION', id: targetId } : null)
    }

    const handlePointerUp = (event: globalThis.PointerEvent) => {
      const current = stationDragRef.current
      stationDragRef.current = null
      setStationDrag(null)
      setDragTarget(null)
      if (!current?.active) return
      suppressStationClick.current = true
      window.setTimeout(() => { suppressStationClick.current = false }, 0)
      const targetId = document.elementFromPoint(event.clientX, event.clientY)
        ?.closest('[data-station-id]')?.getAttribute('data-station-id')
      if (!targetId || targetId === current.stationId || !selectedLineId) return
      const cityState = stateRef.current
      const dragLine = cityState?.city.lines.find(item => item.id === selectedLineId)
      const fromStation = cityState?.city.stations.find(s => s.id === current.stationId)
      const toStation = cityState?.city.stations.find(s => s.id === targetId)
      if (!dragLine || !fromStation || !toStation) return
      void performActionRef.current?.({
        type: 'BUILD_SEGMENT',
        lineId: selectedLineId,
        fromStationId: current.stationId,
        toStationId: targetId,
      })
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp, { once: true })
    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
    }
  }, [draggedStationId, selectedLineId])

  // 선로 구간을 끌어 다른 역을 경유하도록 삽입
  const draggedSegmentKey = segmentDrag ? `${segmentDrag.lineId}:${segmentDrag.fromStationId}` : null
  useEffect(() => {
    if (!draggedSegmentKey) return

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const current = segmentDragRef.current
      if (!current) return
      const active = current.active || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 6
      const next = { ...current, x: event.clientX, y: event.clientY, active }
      segmentDragRef.current = next
      setSegmentDrag(next)
      if (!active) return
      const targetId = document.elementFromPoint(event.clientX, event.clientY)
        ?.closest('[data-station-id]')?.getAttribute('data-station-id')
      const valid = targetId && targetId !== current.fromStationId && targetId !== current.toStationId
      setDragTarget(valid ? { kind: 'STATION', id: targetId } : null)
    }

    const handlePointerUp = (event: globalThis.PointerEvent) => {
      const current = segmentDragRef.current
      segmentDragRef.current = null
      setSegmentDrag(null)
      setDragTarget(null)
      if (!current?.active) return
      suppressLineClick.current = true
      window.setTimeout(() => { suppressLineClick.current = false }, 0)
      const targetId = document.elementFromPoint(event.clientX, event.clientY)
        ?.closest('[data-station-id]')?.getAttribute('data-station-id')
      if (!targetId || targetId === current.fromStationId || targetId === current.toStationId) return
      void performActionRef.current?.({
        type: 'INSERT_STATION',
        lineId: current.lineId,
        fromStationId: current.fromStationId,
        toStationId: current.toStationId,
        stationId: targetId,
      })
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp, { once: true })
    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
    }
  }, [draggedSegmentKey])

  if (!state) {
    if (errorStatus === 401) {
      return (
        <div className={styles.loadingPage}>
          <div className={styles.accessScreen}>
            <p>로그인이 필요합니다.</p>
            <button className={styles.accessActionBtn} onClick={onRequireLogin} type="button">
              로그인하러 가기
            </button>
          </div>
        </div>
      )
    }

    if (errorStatus === 403) {
      return (
        <div className={styles.loadingPage}>
          <div className={styles.accessScreen}>
            <p>이 도시에 접근 권한이 없습니다.<br />초대받은 이메일 계정으로 로그인했는지 확인해주세요.</p>
            <button className={styles.accessActionBtn} onClick={onBack} type="button">
              돌아가기
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className={styles.loadingPage}>
        <span className={styles.loadingDot} />
        {error ?? '도시 로딩 중'}
      </div>
    )
  }

  const currentTick = state.city.currentTick
  const lastTickAtMs = Date.parse(state.city.lastTickAt)
  const liveElapsedTicks = state.city.status === 'ACTIVE' && Number.isFinite(lastTickAtMs)
    ? Math.max(0, (clockNowMs - lastTickAtMs) / LIVE_TICK_MS)
    : 0
  const continuousTick = currentTick + liveElapsedTicks
  const currentGameDay = Math.floor(continuousTick / TICKS_PER_DAY) + 1
  const liveElapsedGameMinutes = liveElapsedTicks * GAME_MINUTES_PER_TICK
  // 확대해도 역·글씨·점이 화면 기준 크기를 유지하도록 counter-scale
  const mapScale = mapView.width / 100
  const selectedStation = stationById.get(selectedStationId) ?? null
  const gameHour = (continuousTick / TICKS_PER_HOUR) % 24
  // 서버 isWeekendTick과 동일 공식 (1게임일 = 144틱, 7일 주기 중 6·7일차)
  const isWeekend = Math.floor(continuousTick / TICKS_PER_DAY) % 7 >= 5
  const elapsedSeconds = continuousTick * (LIVE_TICK_MS / 1000)
  const journeyTime = continuousTick * CITIZEN_TIME_SCALE
  const movingCitizens = citizenJourneys.map(journey => ({
    ...journey,
    position: locateCitizen(journey, journeyTime),
  }))
  const vehicleMotionById = new Map(
    state.city.lines.flatMap(line => orderedVehicles(line).map(vehicle => [
      vehicle.id,
      locateVehicle(
        line,
        vehicle,
        line.status === 'OPERATING' && vehicle.status === 'OPERATING' && !vehicle.isSpare
          ? liveElapsedGameMinutes
          : 0,
      ),
    ] as const)),
  )
  // 서버는 3초 경제 틱 끝에 승차를 확정한다. 화면에서는 차량이 역에 실제로
  // 도착한 프레임부터 예상 승차 인원을 먼저 반영해 대기열이 늦게 사라지지 않게 한다.
  const waitingByStation = new Map(state.stationStats.map(stat => [stat.stationId, stat.waitingCount]))
  for (const line of state.city.lines) {
    if (line.status !== 'OPERATING') continue
    for (const vehicle of orderedVehicles(line)) {
      if (vehicle.status !== 'OPERATING' || vehicle.isSpare) continue
      const motion = vehicleMotionById.get(vehicle.id)
      for (const stationId of motion?.arrivedStationIds ?? []) {
        const waiting = waitingByStation.get(stationId) ?? 0
        waitingByStation.set(stationId, Math.max(0, waiting - vehicle.capacity))
      }
    }
  }
  const latestMetric = state.city.ticks[0]
  const serviceScore = latestMetric?.serviceScore ?? 100
  const totalVehicles = state.city.lines.reduce((sum, line) => sum + line.vehicles.length, 0)
  const waitingPassengers = [...waitingByStation.values()].reduce((sum, waiting) => sum + waiting, 0)
  const goalProgress = state.city.revenueGoal > 0
    ? Math.min(100, (state.city.totalRevenue / state.city.revenueGoal) * 100)
    : 0
  const goalJustReached = state.city.goalsCompleted > 0 && state.city.goalReachedAtTick === currentTick
  const goalDaysRemaining = state.city.goalDeadlineDay - currentGameDay
  const goalDeadlineStatus = goalDaysRemaining > 0
    ? `D-${goalDaysRemaining}`
    : goalDaysRemaining === 0
      ? '오늘 마감'
      : `${Math.abs(goalDaysRemaining)}일 초과`
  const isGameOver = state.city.status === 'GAME_OVER'
  const bankruptcyRisk = state.city.cashBalance <= state.economyRules.bankruptLimit
  const happinessRisk = state.city.happiness <= state.economyRules.criticalHappiness
  const riskTicks = bankruptcyRisk ? state.city.insolvencyTicks : happinessRisk ? state.city.unhappyTicks : 0
  const graceRemaining = Math.max(0, state.economyRules.gameOverGraceTicks - riskTicks)
  const graceHours = Math.ceil(graceRemaining / TICKS_PER_HOUR)
  const commandExamples: string[] = []
  const [firstCommandStation, secondCommandStation] = state.city.stations
  if (firstCommandStation && secondCommandStation) {
    commandExamples.push(`${firstCommandStation.name}과 ${secondCommandStation.name} 사이에 새로운 노선을 건설해 줘.`)
  }
  for (const line of sortedLines) {
    if (line.lineStations.length === 0) continue
    const target = state.city.stations.find(station => !lineHasStation(line, station.id))
    if (!target) continue
    commandExamples.push(`${line.name}을 ${target.name} 방향으로 연장해줘.`)
    break
  }

  return (
    <div className={styles.page}>
      <aside className={styles.controlRoom}>
        <div className={styles.controlHeader}>
          <div className={styles.controlHeaderTop}>
            <button className={styles.backButton} onClick={onBack} aria-label="도시 선택으로 돌아가기">←</button>
            <div className={styles.controlIdentity}>
              <span>{state.city.name.toUpperCase()} CONTROL</span>
              {editingTitle ? (
                <form
                  className={styles.titleEditForm}
                  onSubmit={event => {
                    event.preventDefault()
                    void saveRoomTitle()
                  }}
                >
                  <input
                    className={styles.titleEditInput}
                    value={titleDraft}
                    onChange={event => setTitleDraft(event.target.value)}
                    maxLength={24}
                    autoFocus
                    aria-label="방제목"
                  />
                  <button className={styles.titleSaveBtn} type="submit" disabled={titleSaving}>
                    {titleSaving ? '…' : '저장'}
                  </button>
                  <button className={styles.titleCancelBtn} type="button" onClick={cancelEditTitle} disabled={titleSaving}>
                    취소
                  </button>
                </form>
              ) : (
                <div className={styles.titleRow}>
                  <h1>{state.city.roomTitle}</h1>
                  {state.isOwner && session && (
                    <button
                      className={styles.titleEditBtn}
                      type="button"
                      onClick={beginEditTitle}
                      title="방제목 바꾸기"
                      aria-label="방제목 바꾸기"
                    >
                      수정
                    </button>
                  )}
                </div>
              )}
            </div>
            {session && (
              <button
                className={styles.inviteButton}
                onClick={() => setShowInviteModal(true)}
                aria-label="이 도시에 사람 초대하기"
                title="초대"
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="9.5" cy="8.5" r="3.1" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M3.5 19c0-3 2.7-5.2 6-5.2s6 2.2 6 5.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M17.5 7.5v5M15 10h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
                <span>초대</span>
              </button>
            )}
          </div>
          <div className={styles.headerActions}>
            <button
              className={styles.notifyButton}
              onClick={() => void handleTestNotification()}
              disabled={notifyStatus === 'pending'}
              type="button"
              aria-label="주요 이벤트 알림 테스트"
              title="5초 후 크롬 알림을 띄웁니다"
            >
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 4.5c-2.9 0-5 2.2-5 5v2.4c0 .6-.2 1.2-.6 1.7l-1.1 1.4c-.6.8 0 1.9 1 1.9h11.4c1 0 1.6-1.1 1-1.9l-1.1-1.4c-.4-.5-.6-1.1-.6-1.7V9.5c0-2.8-2.1-5-5-5z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
                <path d="M10.3 18.5a1.9 1.9 0 0 0 3.4 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <span>
                {notifyStatus === 'pending' && `${notifySecondsLeft || 1}초 후 알림…`}
                {notifyStatus === 'sent' && '알림 전송됨'}
                {notifyStatus === 'denied' && '알림 차단됨'}
                {notifyStatus === 'unsupported' && '알림 미지원'}
                {notifyStatus === 'busy' && '이미 예약됨'}
                {notifyStatus === 'idle' && '알림 테스트'}
              </span>
            </button>
          </div>
        </div>

        {session && showInviteModal && (
          <InviteModal
            cityId={cityId}
            playerToken={session.token}
            onClose={() => setShowInviteModal(false)}
          />
        )}

        <div className={`${styles.liveStatus} ${goalJustReached ? styles.goalLiveStatus : ''} ${isGameOver ? styles.stoppedStatus : ''}`}>
          <span className={styles.liveDot} />
          <b>{isGameOver ? '경영 종료' : goalJustReached ? `${state.city.goalsCompleted}개 목표 완료 · 새 목표 시작` : `${state.city.goalLevel}단계 목표 진행 중`}</b>
        </div>

        <section className={`${styles.controlSection} ${styles.goalSection}`}>
          <div className={styles.sectionHeading}><span>★</span><h2>이번 경영 목표</h2></div>
          <div className={`${styles.goalCard} ${goalJustReached ? styles.goalCardReached : ''}`}>
            <div className={styles.goalCardTop}>
              <span>{state.city.goalLevel}단계 · {state.city.goalDeadlineDay}일차까지</span>
              <b>{formatMoney(state.city.totalRevenue)} <small>/ {formatMoney(state.city.revenueGoal)}</small></b>
            </div>
            <div className={`${styles.goalMeta} ${goalDaysRemaining < 0 ? styles.goalMetaOverdue : ''}`}>
              <span>현재 {currentGameDay}일차</span>
              <b>{goalDeadlineStatus}</b>
              <span>완료 {state.city.goalsCompleted}개</span>
            </div>
            <div className={styles.progressTrack} aria-label={`매출 목표 ${Math.round(goalProgress)}%`}>
              <i style={{ width: `${goalProgress}%` }} />
            </div>
            <p>{goalJustReached
              ? '이전 목표 보상을 지급하고 더 높은 다음 목표를 설정했습니다.'
              : goalDaysRemaining < 0
                ? '기한이 지났습니다. 매출 목표를 달성하면 다음 단계로 계속 진행할 수 있습니다.'
                : '기한 안에 목표를 달성하면 지원금 ₵2,000과 5,000점을 받고 다음 목표가 열립니다.'}</p>
          </div>
          <div className={styles.economyGrid}>
            <span><small>운영 자금</small><b className={state.city.cashBalance < 0 ? styles.dangerValue : ''}>{formatMoney(state.city.cashBalance)}</b></span>
            <span><small>시민 행복도</small><b className={happinessRisk ? styles.dangerValue : ''}>{Math.round(state.city.happiness)}%</b></span>
          </div>
          <div className={styles.happinessTrack} aria-label={`시민 행복도 ${Math.round(state.city.happiness)}%`}>
            <i style={{ width: `${state.city.happiness}%` }} />
          </div>
          {(bankruptcyRisk || happinessRisk) && !isGameOver && (
            <p className={styles.riskWarning} role="status">
              {bankruptcyRisk ? '파산 위험' : '행복도 위험'} · 약 {graceHours}게임시간 안에 회복하세요
            </p>
          )}
        </section>

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
          <div className={styles.newLineRow}>
            <button onClick={() => void createLine('SUBWAY')} disabled={busy || isGameOver}>＋ 지하철 · ₵2,000</button>
            <button onClick={() => void createLine('BUS')} disabled={busy || isGameOver}>＋ 버스 · ₵600</button>
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
          {selectedLine && (
            <button
              className={styles.removeVehicleButton}
              onClick={() => {
                void performAction({ type: 'REMOVE_LINE', lineId: selectedLine.id }).then(next => {
                  if (!next) return
                  const remaining = next.city.lines.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko'))[0]
                  setSelectedLineId(remaining?.id ?? '')
                  setSelectedVehicleId('')
                })
              }}
              disabled={busy}
            >{selectedLine.name} 노선 삭제</button>
          )}
        </section>

        {selectedLine && (
          <section className={styles.controlSection}>
            <div className={styles.sectionHeading}><span>02</span><h2>{selectedLine.mode === 'BUS' ? '차량' : '철도 차량'}</h2></div>
            <div className={styles.vehicleList}>
              {orderedVehicles(selectedLine).map((vehicle, index) => {
                const motion = vehicleMotionById.get(vehicle.id)
                const station = motion?.fromStation
                const isDwelling = selectedLine.status === 'OPERATING' && vehicle.status === 'OPERATING' && motion?.isDwelling
                const isMoving = selectedLine.status === 'OPERATING' && vehicle.status === 'OPERATING' && motion?.toStation && !isDwelling
                const routeStatus = isMoving
                  ? `${station?.name} → ${motion.toStation?.name}`
                  : station?.name ?? `${selectedLine.name} 차고지`
                return (
                  <div key={vehicle.id} className={styles.vehicleRow}>
                    <button
                      className={`${styles.vehicleCard} ${vehicle.id === selectedVehicleId ? styles.vehicleSelected : ''}`}
                      aria-pressed={vehicle.id === selectedVehicleId}
                      onClick={() => selectVehicle(selectedLine.id, vehicle.id)}
                      onPointerDown={event => beginVehiclePointerDrag(event, selectedLine.id, vehicle.id)}
                    >
                      <span
                        className={`${styles.trainBadge} ${selectedLine.mode === 'BUS' ? styles.busBadge : ''}`}
                        style={{ background: LINE_COLORS[selectedLine.color] }}
                      >
                        <i /><i /><b>{index + 1}</b>
                      </span>
                      <span>
                        <b>{selectedLine.name} 차량 {index + 1}</b>
                        <small>{routeStatus} · {trainStatus(vehicle)}</small>
                      </span>
                    </button>
                    <button
                      className={vehicle.status === 'OPERATING' && !vehicle.isSpare ? styles.storeVehicleButton : styles.startVehicleButton}
                      onClick={() => void performAction({
                        type: 'SET_VEHICLE_SERVICE',
                        lineId: selectedLine.id,
                        vehicleId: vehicle.id,
                        inService: !(vehicle.status === 'OPERATING' && !vehicle.isSpare),
                      })}
                      disabled={busy || !['OPERATING', 'SPARE'].includes(vehicle.status)}
                    >{vehicle.status === 'OPERATING' && !vehicle.isSpare ? '입고' : '운행'}</button>
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
            <div className={styles.sectionHeading}>
              <span>03</span><h2>역 관리</h2>
              <button
                className={styles.deselectButton}
                onClick={() => {
                  setSelectedStationId('')
                  setMoveStationMode(false)
                }}
                aria-label="역 선택 해제 (ESC)"
                title="선택 해제 (ESC)"
              >✕</button>
            </div>
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
                setError(null)
              }}
              disabled={busy}
            >{moveStationMode ? '옮길 위치를 지도에서 클릭' : `${selectedStation.name} 위치 이동`}</button>
            {(() => {
              // 환승역은 특정 노선에서만 뺄 수 있는 선택지를 제공
              const servingLines = sortedLines.filter(line => lineHasStation(line, selectedStation.id))
              if (servingLines.length < 2) return null
              return (
                <div className={styles.newLineRow}>
                  {servingLines.map(line => (
                    <button
                      key={line.id}
                      onClick={() => void performAction({
                        type: 'DETACH_STATION',
                        lineId: line.id,
                        stationId: selectedStation.id,
                      })}
                      disabled={busy}
                    >{line.name}에서 제거</button>
                  ))}
                </div>
              )
            })()}
            <button
              className={styles.removeVehicleButton}
              onClick={() => {
                void performAction({ type: 'REMOVE_STATION', stationId: selectedStation.id }).then(next => {
                  if (next) setSelectedStationId('')
                })
              }}
              disabled={busy}
            >{selectedStation.name} 완전 삭제</button>
          </section>
        )}

        {error && <div className={styles.operationError} role="alert">! {error}</div>}

        {state.isOwner && (
          <section className={`${styles.controlSection} ${styles.aiCommandSection}`}>
            <div className={styles.sectionHeading}>
              <span>AI</span>
              <h2>도시 운영관</h2>
              <small>명령 즉시 실행</small>
            </div>
            <div className={styles.aiCommandPanel}>
              <div className={styles.aiChatLog} role="log" aria-live="polite" ref={commandLogRef}>
                {commandMessages.map(message => (
                  <div
                    key={message.id}
                    className={`${styles.aiMessage} ${message.role === 'user' ? styles.aiMessageUser : styles.aiMessageAssistant} ${message.isError ? styles.aiMessageError : ''}`}
                  >
                    <small>{message.role === 'user' ? '나' : 'AI 운영관'}</small>
                    <p>{message.text}</p>
                  </div>
                ))}
                {commandBusy && (
                  <div className={`${styles.aiMessage} ${styles.aiMessageAssistant} ${styles.aiMessagePending}`}>
                    <small>AI 운영관</small>
                    <p><i /> 명령을 검토하고 있습니다.</p>
                  </div>
                )}
              </div>
              {commandExamples.length > 0 && (
                <div className={styles.aiCommandExamples} aria-label="도시 운영 명령 예시">
                  {commandExamples.slice(0, 2).map(example => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => setCommandInput(example)}
                      disabled={busy || commandBusy || isGameOver}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              )}
              <form
                className={styles.aiCommandForm}
                onSubmit={event => {
                  event.preventDefault()
                  void runCityCommand(commandInput)
                }}
              >
                <textarea
                  value={commandInput}
                  onChange={event => setCommandInput(event.target.value)}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' || event.shiftKey) return
                    event.preventDefault()
                    void runCityCommand(commandInput)
                  }}
                  placeholder="예: 1호선을 시청역 방향으로 연장해줘."
                  maxLength={300}
                  rows={2}
                  disabled={busy || commandBusy || isGameOver}
                  aria-label="AI 도시 운영 명령"
                />
                <button type="submit" disabled={busy || commandBusy || isGameOver || !commandInput.trim()}>
                  {commandBusy ? '실행 중' : '명령 실행'}
                </button>
              </form>
            </div>
          </section>
        )}
      </aside>

      <main className={styles.gameStage}>
        <header className={styles.hudTop}>
          <div className={styles.cityIdentity}>
            <span className={styles.cityName}>{state.city.roomTitle}</span>
            <span>
              {state.city.name} · {Math.floor(continuousTick / TICKS_PER_DAY) + 1}일차{isWeekend ? ' · 주말' : ''} · {formatHour(gameHour)}
            </span>
          </div>
          <div className={styles.hudStats}>
            <span><small>경영 점수</small><b>{state.city.score.toLocaleString('ko-KR')}</b></span>
            <span><small>운영 자금</small><b className={state.city.cashBalance < 0 ? styles.dangerValue : ''}>{formatMoney(state.city.cashBalance)}</b></span>
            <span><small>행복도</small><b>{Math.round(state.city.happiness)}%</b></span>
            <span><small>대기 승객</small><b>{waitingPassengers}명</b></span>
            <span><small>서비스 · 차량</small><b>{Math.round(serviceScore)} · {totalVehicles}대</b></span>
            <span className={styles.tickNumber}><small>플레이 시간</small><b>{formatElapsed(elapsedSeconds)}</b></span>
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
                  setMoveStationMode(false)
                  setSelectedVehicleId('')
                  setError(null)
                }}
                disabled={isGameOver}
              >＋ 역 짓기 · ₵800</button>
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

            <g
              className={styles.peopleLayer}
              clipPath="url(#city-land-clip)"
              aria-label={`외부에서 역과 정류장으로 이동하는 시민 ${movingCitizens.length}명`}
              data-moving-citizen-count={movingCitizens.length}
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
                    data-citizen-id={citizen.id}
                    data-travel-mode={position.mode}
                    data-target-station={citizen.targetStationId}
                    data-access-mode={citizen.accessMode}
                    data-land-safe={citizen.landSafe}
                    data-leg-progress={position.progress.toFixed(3)}
                  >
                    <title>{citizen.targetStationName} · {CITIZEN_MODE_LABELS[position.mode]}</title>
                  </circle>
                )
              })}
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
                  style={{
                    stroke: LINE_COLORS[line.color],
                    strokeWidth: 1.15 * mapScale,
                    strokeDasharray: `${1.4 * mapScale} ${1.2 * mapScale}`,
                  }}
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
                onClick={event => {
                  event.stopPropagation()
                  if (suppressLineClick.current) {
                    suppressLineClick.current = false
                    return
                  }
                  selectLine(line.id)
                }}
                onPointerDown={event => beginSegmentDrag(event, line)}
              >
                {line.mode !== 'BUS' && (
                  <polyline
                    points={linePoints(line)}
                    className={styles.lineShadow}
                    style={{ strokeWidth: 4.2 * mapScale }}
                  />
                )}
                <polyline
                  points={linePoints(line)}
                  className={`${styles.linePath} ${line.mode === 'BUS' ? styles.busPath : ''} ${line.id === selectedLineId ? styles.selectedLinePath : ''}`}
                  style={{
                    stroke: LINE_COLORS[line.color],
                    // 줌과 무관하게 화면 기준 두께 유지
                    strokeWidth: (line.mode === 'BUS'
                      ? (line.id === selectedLineId ? 1.7 : 1.25)
                      : (line.id === selectedLineId ? 2.9 : 2.25)) * mapScale,
                    strokeDasharray: line.mode === 'BUS' ? `${2 * mapScale} ${1.2 * mapScale}` : undefined,
                  }}
                />
              </g>
            ))}

            {segmentDrag?.active && (() => {
              const matrix = mapRef.current?.getScreenCTM()
              const from = stationById.get(segmentDrag.fromStationId)
              const to = stationById.get(segmentDrag.toStationId)
              const line = sortedLines.find(item => item.id === segmentDrag.lineId)
              if (!matrix || !from || !to) return null
              const cursor = new DOMPoint(segmentDrag.x, segmentDrag.y).matrixTransform(matrix.inverse())
              const ghostStyle = {
                stroke: LINE_COLORS[line?.color ?? 'RED'],
                strokeWidth: 2.25 * mapScale,
                strokeDasharray: `${2 * mapScale} ${1.5 * mapScale}`,
              }
              return (
                <>
                  <line x1={from.posX} y1={from.posY} x2={cursor.x} y2={cursor.y} className={styles.linkGhost} style={ghostStyle} />
                  <line x1={cursor.x} y1={cursor.y} x2={to.posX} y2={to.posY} className={styles.linkGhost} style={ghostStyle} />
                </>
              )
            })()}

            {stationDrag?.active && (() => {
              const matrix = mapRef.current?.getScreenCTM()
              const source = stationById.get(stationDrag.stationId)
              if (!matrix || !source) return null
              const cursor = new DOMPoint(stationDrag.x, stationDrag.y).matrixTransform(matrix.inverse())
              return (
                <line
                  x1={source.posX}
                  y1={source.posY}
                  x2={cursor.x}
                  y2={cursor.y}
                  className={styles.linkGhost}
                  style={{
                    stroke: LINE_COLORS[selectedLine?.color ?? 'RED'],
                    strokeWidth: 2.25 * mapScale,
                    strokeDasharray: `${2 * mapScale} ${1.5 * mapScale}`,
                  }}
                />
              )
            })()}

            {state.city.stations.map(station => {
              const point = stationPoint(station)
              const isInterchange = interchangeStationIds.has(station.id)
              const isBusStop = busOnlyStationIds.has(station.id)
              const isCurrentVehicleStation = selectedVehicle?.currentStationId === station.id
              const isDropTarget = dragTarget?.kind === 'STATION' && dragTarget.id === station.id
              const highlighted = isCurrentVehicleStation || isDropTarget || station.id === selectedStationId
              const congestion = congestionByStation.get(station.id) ?? 0
              return (
                <g
                  key={station.id}
                  transform={`translate(${point.x} ${point.y}) scale(${mapScale})`}
                  className={styles.stationGroup}
                  onClick={event => handleStationClick(event, station.id)}
                  onPointerDown={event => beginStationLinkDrag(event, station.id)}
                  role="button"
                  tabIndex={0}
                  data-station-id={station.id}
                  data-map-interactive="true"
                  aria-label={`${station.name} ${isBusStop ? '버스 정류장' : isInterchange ? '환승역' : '일반역'} 선택`}
                >
                  <title>{station.name} · {isBusStop ? '버스 정류장' : isInterchange ? '환승역' : '일반역'}</title>
                  {highlighted && <circle r="3.3" className={styles.stationSelection} />}
                  {congestion >= CONGESTION_SATURATED ? (
                    <circle r="3" className={styles.saturatedRing} />
                  ) : congestion >= CONGESTION_WARN ? (
                    <circle r="2.8" className={styles.warnRing} />
                  ) : null}
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
              // 아직 역이 없는 신설 노선은 차고지를 그리지 않는다 (첫 구간 부설 시 종점 옆에 등장)
              if (line.lineStations.length === 0) return null
              const spareCount = line.vehicles.filter(vehicle => vehicle.isSpare).length
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

            {state.city.lines.flatMap(line => orderedVehicles(line)
              .filter(vehicle => vehicle.status === 'OPERATING' && !vehicle.isSpare && vehicle.currentStationId)
              .map(vehicle => {
                const motion = vehicleMotionById.get(vehicle.id)
                const station = motion?.fromStation
                const nextStation = motion?.toStation
                if (!motion || !station || motion.x === null || motion.y === null) return null
                const lineNo = line.name.match(/\d+/)?.[0] ?? line.name.slice(0, 1)
                const progress = line.status === 'OPERATING' ? motion.progress : 0
                const trainX = motion.x
                const trainY = motion.y
                const rawAngle = nextStation
                  ? Math.atan2(nextStation.posY - station.posY, nextStation.posX - station.posX) * 180 / Math.PI
                  : 0
                // 왼쪽 방향 이동 시 180° 회전으로 뒤집히지 않게 좌우 반전으로 처리
                const trainFlipped = Math.abs(rawAngle) > 90
                const trainAngle = trainFlipped ? rawAngle - 180 * Math.sign(rawAngle) : rawAngle
                const dragging = vehicleDrag?.active && vehicleDrag.vehicleId === vehicle.id
                return (
                  <g
                    key={vehicle.id}
                    transform={`translate(${trainX} ${trainY}) rotate(${trainAngle})${trainFlipped ? ' scale(-1,1)' : ''} scale(${mapScale})`}
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
                    data-segment-minutes={motion.segmentDurationMinutes}
                    data-motion-state={motion.isDwelling ? 'DWELLING' : 'MOVING'}
                    data-dwell-remaining={motion.dwellRemainingMinutes.toFixed(3)}
                    data-map-interactive="true"
                  >
                    {line.mode === 'BUS' ? (
                      <>
                        {/* 버스: 둥근 차체 + 넓은 창 + 문 + 지붕 표시등 */}
                        <rect x="-3" y="-2.1" width="6" height="4.2" rx="1.6" fill={LINE_COLORS[line.color]} className={styles.trainBody} />
                        <rect x="-2.2" y="-1.35" width="2.7" height="1.35" rx=".3" className={styles.trainWindow} />
                        <rect x="1" y="-1.15" width="1.15" height="2.5" rx=".22" className={styles.busDoor} />
                        <circle cx="-1.6" cy="2.05" r=".56" className={styles.trainWheel} />
                        <circle cx="1.6" cy="2.05" r=".56" className={styles.trainWheel} />
                        <text x="-.6" y=".9" textAnchor="middle" className={styles.trainNumber} transform={trainFlipped ? 'scale(-1,1)' : undefined}>{lineNo}</text>
                      </>
                    ) : (
                      <>
                        {/* 팬터그래프: 지붕 접이식 집전장치 + 가선 접촉봉 */}
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

            {/* 역 이름은 항상 최상단 (SVG는 그리는 순서 = z-order) */}
            <g className={styles.stationLabelLayer}>
              {state.city.stations.filter(station => !isAutoStationName(station.name)).map(station => (
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

          <div className={styles.mapPanel}>
            <div className={styles.mapPanelLines} aria-label="운영 노선 선택">
              {sortedLines.map(line => (
                <button
                  key={line.id}
                  className={line.id === selectedLineId ? styles.mapLegendActive : ''}
                  onClick={() => selectLine(line.id)}
                >
                  <i style={{ background: LINE_COLORS[line.color] }} />{line.name}{line.status === 'SUSPENDED' ? ' · 폐쇄' : ''}
                </button>
              ))}
              <button
                className={styles.legendToggle}
                onClick={() => setLegendOpen(current => !current)}
                aria-expanded={legendOpen}
              >범례 {legendOpen ? '▴' : '▾'}</button>
            </div>
            {legendOpen && (
              <div className={styles.legendBody}>
                <div className={styles.legendRow} aria-label="역 종류">
                  <b>역</b>
                  <span><i className={styles.regularStationMark} />일반</span>
                  <span><i className={styles.interchangeStationMark} />환승</span>
                  <span><i className={styles.busStopMark} />버스 정류장</span>
                  <span><i className={styles.depotMark} />차고지</span>
                  <span><i className={styles.saturatedMark} />포화</span>
                </div>
                <div className={styles.legendRow} aria-label="구역 종류">
                  <b>구역</b>
                  <span><i className={styles.zoneMarkResidential} />주거</span>
                  <span><i className={styles.zoneMarkCommercial} />상업</span>
                  <span><i className={styles.zoneMarkIndustrial} />산업·오피스</span>
                </div>
                <div className={styles.legendRow} aria-label="시민 이동 상태">
                  <b>시민</b>
                  <span><i className={styles.walkingCitizenMark} />도보</span>
                  <span><i className={styles.waitingCitizenMark} />역 대기</span>
                  <span><i className={styles.boardingCitizenMark} />탑승</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {isGameOver && (
        <div className={styles.gameOverOverlay} role="dialog" aria-modal="true" aria-labelledby="game-over-title">
          <div className={styles.gameOverCard}>
            <span className={styles.gameOverEyebrow}>CITY OPERATIONS REPORT</span>
            <h2 id="game-over-title">GAME OVER</h2>
            <p className={styles.gameOverReason}>
              {state.city.gameOverReason === 'BANKRUPT'
                ? '운영 적자가 장기간 이어져 더는 대중교통을 유지할 수 없습니다.'
                : '시민 행복도가 장기간 바닥에 머물러 운영 권한을 잃었습니다.'}
            </p>
            <div className={styles.gameOverStats}>
              <span><small>최종 점수</small><b>{state.city.score.toLocaleString('ko-KR')}</b></span>
              <span><small>누적 매출</small><b>{formatMoney(state.city.totalRevenue)}</b></span>
              <span><small>최종 행복도</small><b>{Math.round(state.city.happiness)}%</b></span>
            </div>
            <p className={styles.restartHint}>현재 도시와 건설한 노선은 유지하고, 자금·매출·행복도만 초기화합니다.</p>
            <div className={styles.gameOverActions}>
              <button onClick={onBack}>도시 선택</button>
              <button
                className={styles.restartButton}
                onClick={() => void performAction({ type: 'RESET_CITY' })}
                disabled={busy}
              >{busy ? '준비 중…' : '같은 도시로 다시 시작'}</button>
            </div>
          </div>
        </div>
      )}

      {vehicleDrag?.active && (
        <div className={styles.vehicleDragGhost} style={{ left: vehicleDrag.x, top: vehicleDrag.y }}>
          <span style={{ background: LINE_COLORS[selectedVehicleLine?.color ?? 'RED'] }} />
          {selectedVehicleLine?.name} 차량
        </div>
      )}

      {/* 브라우저 창 전체(뷰포트)에 다른 사용자 커서 표시 */}
      <div className={styles.pageCursorLayer} aria-hidden="true">
        {remoteCursors.map(cursor => (
          <div
            key={cursor.playerId}
            className={styles.pageRemoteCursor}
            style={{
              left: `${cursor.x}%`,
              top: `${cursor.y}%`,
              ['--cursor-color' as string]: cursor.color,
            }}
          >
            <div className={styles.pageRemoteCursorBob}>
              <svg width="28" height="28" viewBox="0 0 28 28" className={styles.pageRemoteCursorSvg}>
                <path d="M4 2 L22 12.5 L11 14.5 Z" fill="var(--cursor-color)" stroke="rgba(255,255,255,.92)" strokeWidth="1.6" strokeLinejoin="round" />
                <circle cx="14.5" cy="17.5" r="7.2" fill="var(--cursor-color)" stroke="rgba(255,255,255,.92)" strokeWidth="1.5" />
                <circle cx="12.2" cy="16.6" r="1.15" fill="#26201a" />
                <circle cx="16.8" cy="16.6" r="1.15" fill="#26201a" />
                <path d="M12.2 19.4 Q14.5 21.1 16.8 19.4" fill="none" stroke="#26201a" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </div>
            <span className={styles.pageRemoteCursorLabel}>{cursor.nickname}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
