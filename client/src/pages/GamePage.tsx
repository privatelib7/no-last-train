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
  type CityMotionSnapshot,
  type CityState,
  type GameLine,
  type Station,
  type Vehicle,
} from '../api/game'
import type { AuthSession } from '../api/auth'
import { updateRoomTitle } from '../api/cities'
import { leaveCursor, syncCursor, type RemoteCursor } from '../api/cursors'
import { connectRealtime } from '../api/realtime'
import { notifyEmergency } from '../lib/notifications'
import { playGoalUnlockSfx } from '../lib/sfx'
import InviteModal from './InviteModal'
import CitySettingsModal from './CitySettingsModal'
import { getCityMap, polyPath, type CityMapDef } from '../maps'
import { depotTerminusOf } from '../vehicle-motion'
import LiveTransitLayer, { type HudSample, type MotionDrive } from './LiveTransitLayer'
import styles from './GamePage.module.css'

interface Props {
  cityId: string
  session: AuthSession | null
  onBack: () => void
  onRequireLogin: () => void
}

type DragTarget = { kind: 'STATION'; id: string } | null

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

/** Ctrl/Cmd+Z 로 되돌릴 구간 연결 (연장·첫 구간·중간 삽입) */
type SegmentUndoEntry = {
  lineId: string
  addedStationIds: string[]
}

const LIVE_TICK_MS = 3000
// HUD 시계(일차·시각)가 밀린 틱을 따라잡을 때도 이 배수를 넘지 않는 속도로만 전진한다
// (그냥 서버 값으로 스냅하면 시계가 훅 튀어 보인다).
// 커서: 움직일 때는 200ms, 가만히 있을 때는 2초 하트비트 (예전 45ms는 DB/액션을 굶김)
const CURSOR_MOVE_SYNC_MS = 200
const CURSOR_HEARTBEAT_MS = 2000
const CURSOR_MOVE_THRESHOLD = 0.35
// 서버 cursor-presence.ts 의 CURSOR_COLORS 와 동일한 팔레트 (본인 아바타 색 계산용)
const PRESENCE_COLORS = ['#ff6f91', '#4fc9a8', '#5b8cf2', '#ffb648', '#a77dfb', '#3ecbd0', '#f4886b'] as const
// 차량이 승차로 번 돈을 옆에 잠깐 띄워 보여주는 연출 지속 시간·떠오르는 높이
// 서버 actions 라우트의 MAX_VEHICLES_PER_LINE 과 같아야 한다
const MAX_VEHICLES_PER_LINE = 8
// 전철·버스 글리프 축소 배율 — 역/선로에 비해 차량이 너무 커 보이지 않게 한다
const INITIAL_MAP_VIEW: MapView = { x: 0, y: 0, width: 100, height: 100 }

const LINE_COLORS: Record<string, string> = {
  RED: '#E9783C',
  BLUE: '#3F8EDB',
  GREEN: '#55A96A',
  YELLOW: '#E1B735',
  PURPLE: '#8E6CC1',
}

// 지형(물)은 클라이언트만 알고 있으므로, 서버가 계획한 신설역 좌표는 여기서 가장 가까운 땅으로 당긴다.
function snapToLand(map: CityMapDef, posX: number, posY: number) {
  if (map.isLand(posX, posY)) return { posX, posY }
  for (let radius = 1; radius <= 12; radius += 1) {
    for (let step = 0; step < 16; step += 1) {
      const angle = (step / 16) * Math.PI * 2
      const x = Math.round(Math.max(4, Math.min(96, posX + Math.cos(angle) * radius)) * 10) / 10
      const y = Math.round(Math.max(4, Math.min(92, posY + Math.sin(angle) * radius)) * 10) / 10
      if (map.isLand(x, y)) return { posX: x, posY: y }
    }
  }
  return null
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

// 프레즌스 동그라미에 넣을 닉네임 이니셜 (한글은 첫 글자, 영문은 앞 두 글자)
function getInitials(nickname: string) {
  const trimmed = nickname.trim()
  if (!trimmed) return '?'
  const first = trimmed[0]
  return /[a-zA-Z]/.test(first) ? trimmed.slice(0, 2).toUpperCase() : first
}

function colorForPlayerId(playerId: string) {
  let hash = 0
  for (let i = 0; i < playerId.length; i++) {
    hash = (hash * 31 + playerId.charCodeAt(i)) >>> 0
  }
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length]
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
  if (vehicle.isSpare) return '대기'
  if (vehicle.status === 'OPERATING') return '운행 중'
  if (vehicle.status === 'LOANED') return '지원 운행'
  if (vehicle.status === 'MAINTENANCE') return '정비 중'
  return '운행 불가'
}

function orderedVehicles(line: GameLine) {
  return line.vehicles.slice().sort((a, b) => a.id.localeCompare(b.id))
}

/** 선택 노선의 빈 노선이거나, 한쪽이 종점이고 다른 쪽이 노선 밖이면 연장 가능 */
function canExtendLine(line: GameLine, fromStationId: string, toStationId: string) {
  const stations = orderedStations(line)
  if (stations.length === 0) return true
  const fromOn = stations.some(station => station.id === fromStationId)
  const toOn = stations.some(station => station.id === toStationId)
  if (fromOn === toOn) return false
  const onLineId = fromOn ? fromStationId : toStationId
  return stations[0].id === onLineId || stations[stations.length - 1].id === onLineId
}

function lineHasStation(line: GameLine, stationId: string) {
  return line.lineStations.some(item => item.stationId === stationId)
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

// 버스 노선은 A노선·B노선…으로 표기한다. 예전에 "A"로만 저장된 노선도 같게 보이도록 보정.
function lineDisplayName(name: string) {
  return /^[A-Z]$/.test(name) ? `${name}노선` : name
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
  const [stationDrag, setStationDrag] = useState<StationLinkDrag | null>(null)
  const [segmentDrag, setSegmentDrag] = useState<SegmentDrag | null>(null)
  const [dragTarget, setDragTarget] = useState<DragTarget>(null)
  const [mapView, setMapView] = useState<MapView>(INITIAL_MAP_VIEW)
  const [isMapPanning, setIsMapPanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorStatus, setErrorStatus] = useState<number | null>(null)
  const [errorLeaving, setErrorLeaving] = useState(false)
  const [successToast, setSuccessToast] = useState<string | null>(null)
  const [successLeaving, setSuccessLeaving] = useState(false)
  const prevGoalsCompletedRef = useRef<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [hudSample, setHudSample] = useState<HudSample>({ continuousTick: 0, waitingPassengers: 0 })
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [showCitySettingsModal, setShowCitySettingsModal] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)
  const [commandInput, setCommandInput] = useState('')
  const [commandBusy, setCommandBusy] = useState(false)
  const [commandMessages, setCommandMessages] = useState<CityCommandMessage[]>([{
    id: 0,
    role: 'assistant',
    text: '역과 노선 이름을 사용해 운영 명령을 내려주세요. 노선 건설·연장, 역 신설, 차량 구매와 배차, 일괄 운행 조정까지 맡길 수 있고 한 문장에 여러 지시를 담아도 됩니다.',
  }])
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([])
  const cursorPosRef = useRef<{ x: number; y: number; ts: number } | null>(null)
  const cursorLastSentRef = useRef<{ x: number; y: number } | null>(null)
  const stationDragRef = useRef<StationLinkDrag | null>(null)
  const segmentDragRef = useRef<SegmentDrag | null>(null)
  const suppressStationClick = useRef(false)
  const suppressLineClick = useRef(false)
  const mapPanRef = useRef<MapPanState | null>(null)
  const suppressMapClick = useRef(false)
  const mapRef = useRef<SVGSVGElement | null>(null)
  const stateRef = useRef<CityState | null>(null)
  const performActionRef = useRef<((action: CityAction) => Promise<CityState | null>) | null>(null)
  const undoLastSegmentRef = useRef<(() => Promise<void>) | null>(null)
  const createLineRef = useRef<((mode: 'SUBWAY' | 'BUS') => Promise<void>) | null>(null)
  const setLineVehicleServiceRef = useRef<((inService: boolean) => Promise<void>) | null>(null)
  const busyRef = useRef(false)
  const selectedLineIdRef = useRef('')
  const selectedVehicleIdRef = useRef('')
  const selectedStationIdRef = useRef('')
  const linesSectionRef = useRef<HTMLElement | null>(null)
  const stationSectionRef = useRef<HTMLElement | null>(null)
  const stationRenameInputRef = useRef<HTMLInputElement | null>(null)
  const commandSectionRef = useRef<HTMLElement | null>(null)
  const commandInputRef = useRef<HTMLTextAreaElement | null>(null)
  const segmentUndoStackRef = useRef<SegmentUndoEntry[]>([])
  const commandMessageId = useRef(0)
  const commandLogRef = useRef<HTMLDivElement | null>(null)
  const emergencyCityRef = useRef<string | null>(null)
  const cashEmergencyRef = useRef(false)
  const gameOverRiskRef = useRef(false)
  const gameOverFiredRef = useRef(false)
  /** 서버 /motion 스냅샷 — LiveTransitLayer가 읽어 차량 좌표를 그린다 */
  const motionRef = useRef<CityMotionSnapshot | null>(null)
  const motionClockOffsetRef = useRef(0)
  const motionDriveRef = useRef<MotionDrive | null>(null)
  /** motion 폴링 성공 횟수 — 밀린 틱을 몰아가는 중인지 판단하려면 최소 두 번은 받아봐야 한다 */
  const motionPollCountRef = useRef(0)
  /** 이 도시가 로딩 화면을 벗어난 시각 — motion이 계속 실패해도 로딩에 영원히 갇히지 않게 상한을 둔다 */
  const readyGateStartedAtRef = useRef<number | null>(null)
  /** 최초 진입 때 지도를 한 번이라도 보여준 적이 있으면, 그 뒤로는 밀린 틱이 감지돼도
   *  전체 화면을 다시 로딩 화면으로 덮지 않는다 — 플레이 도중 UI가 통째로 사라지면서
   *  버튼 클릭이 씹히는 것처럼 보이던 원인. 이후의 따라잡기는 차량/시계 보간이 알아서 흡수한다. */
  const hasRevealedMapRef = useRef(false)
  /** 로딩 화면 진행률 계산용 — 이 도시를 열었을 때 기준으로 밀린 틱이 얼마나 있었는지 스냅샷 */
  const loadingBacklogRef = useRef<{ initialTick: number; estimatedPendingTicks: number } | null>(null)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    selectedLineIdRef.current = selectedLineId
  }, [selectedLineId])

  useEffect(() => {
    selectedVehicleIdRef.current = selectedVehicleId
  }, [selectedVehicleId])

  useEffect(() => {
    selectedStationIdRef.current = selectedStationId
  }, [selectedStationId])

  // 오른쪽 하단 에러 토스트: 5초 뒤 페이드아웃 후 제거
  useEffect(() => {
    if (!error) {
      setErrorLeaving(false)
      return
    }
    setErrorLeaving(false)
    const fadeTimer = window.setTimeout(() => setErrorLeaving(true), 5000)
    const clearTimer = window.setTimeout(() => {
      setError(null)
      setErrorStatus(null)
      setErrorLeaving(false)
    }, 5600)
    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(clearTimer)
    }
  }, [error])

  // 단계 목표 달성 시 초록 토스트 + 해금 효과음
  useEffect(() => {
    if (!state) return
    const completed = state.city.goalsCompleted
    const prev = prevGoalsCompletedRef.current
    prevGoalsCompletedRef.current = completed
    if (prev === null || completed <= prev) return
    setSuccessToast(`${completed}단계 목표 달성 완료!`)
    setSuccessLeaving(false)
    playGoalUnlockSfx()
  }, [state?.city.id, state?.city.goalsCompleted])

  useEffect(() => {
    if (!successToast) {
      setSuccessLeaving(false)
      return
    }
    setSuccessLeaving(false)
    const fadeTimer = window.setTimeout(() => setSuccessLeaving(true), 5000)
    const clearTimer = window.setTimeout(() => {
      setSuccessToast(null)
      setSuccessLeaving(false)
    }, 5600)
    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(clearTimer)
    }
  }, [successToast])

  // ESC / A 운영관 / B 짓기 / C 지하철 / V 버스 / F 노선 / T 역관리 / G 운행 / H 대기 / Ctrl·Cmd+Z
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedStationId('')
        setStationBuildMode(false)
        setMoveStationMode(false)
        setError(null)
        if (document.activeElement instanceof HTMLElement) {
          const tag = document.activeElement.tagName
          if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement.isContentEditable) {
            document.activeElement.blur()
          }
        }
        return
      }

      const target = event.target as HTMLElement | null
      const typing = Boolean(
        target
        && (target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
          || target.isContentEditable),
      )

      const isUndo = (event.key === 'z' || event.key === 'Z')
        && (event.ctrlKey || event.metaKey)
        && !event.shiftKey
      if (isUndo) {
        if (typing) return
        event.preventDefault()
        void undoLastSegmentRef.current?.()
        return
      }

      if (typing || event.ctrlKey || event.metaKey || event.altKey) return
      if (stateRef.current?.city.status === 'GAME_OVER' || busyRef.current) return

      if (event.key === 'a' || event.key === 'A') {
        event.preventDefault()
        commandSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        window.setTimeout(() => commandInputRef.current?.focus(), 50)
        return
      }

      if (event.key === 'b' || event.key === 'B') {
        event.preventDefault()
        setStationBuildMode(current => !current)
        setMoveStationMode(false)
        setSelectedVehicleId('')
        setError(null)
        return
      }

      if (event.key === 'c' || event.key === 'C') {
        event.preventDefault()
        void createLineRef.current?.('SUBWAY')
        return
      }

      if (event.key === 'v' || event.key === 'V') {
        event.preventDefault()
        void createLineRef.current?.('BUS')
        return
      }

      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault()
        const lines = (stateRef.current?.city.lines ?? [])
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
        if (lines.length > 0) {
          const currentIndex = lines.findIndex(line => line.id === selectedLineIdRef.current)
          const next = lines[(currentIndex + 1) % lines.length]
          setSelectedLineId(next.id)
          setSelectedVehicleId('')
          setError(null)
        }
        linesSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        return
      }

      if (event.key === 't' || event.key === 'T') {
        event.preventDefault()
        if (!selectedStationIdRef.current) {
          setError('먼저 지도에서 역을 선택한 뒤 T를 누르세요.')
          return
        }
        setMoveStationMode(false)
        setError(null)
        stationSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        window.setTimeout(() => {
          const input = stationRenameInputRef.current
          if (!input) return
          input.focus()
          input.select()
        }, 50)
        return
      }

      if (event.key === 'g' || event.key === 'G') {
        event.preventDefault()
        void setLineVehicleServiceRef.current?.(true)
        return
      }

      if (event.key === 'h' || event.key === 'H') {
        event.preventDefault()
        void setLineVehicleServiceRef.current?.(false)
      }
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
    setSelectedLineId(current => (
      next.city.lines.some(line => line.id === current) ? current : firstLine?.id ?? ''
    ))
    setSelectedStationId(current => (
      next.city.stations.some(station => station.id === current) ? current : ''
    ))
    return next
  }

  useEffect(() => {
    let cancelled = false
    segmentUndoStackRef.current = []
    motionRef.current = null
    motionDriveRef.current = null
    motionPollCountRef.current = 0
    readyGateStartedAtRef.current = Date.now()
    hasRevealedMapRef.current = false
    loadingBacklogRef.current = null
    setHudSample({ continuousTick: 0, waitingPassengers: 0 })
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
        if (status === 404) {
          // 삭제된 도시 ID가 localStorage에 남은 경우 등 — 로비로 복귀
          onBack()
          return
        }
        setError(err instanceof Error ? err.message : '도시를 불러오지 못했습니다.')
        setErrorStatus(status)
      })
    return () => { cancelled = true }
  }, [cityId, session?.token, onBack])

  // 도시 상태·차량 위치를 서버가 밀어주는 WebSocket 구독 — 예전 2500ms/500ms
  // HTTP 폴링을 대체한다. 액션(역 짓기 등)은 여전히 HTTP REST로 남아 있다.
  useEffect(() => {
    const connection = connectRealtime(cityId, session?.token, {
      onCity: next => {
        setState(next)
        setError(null)
        setErrorStatus(null)
      },
      onMotion: next => {
        motionPollCountRef.current += 1
        motionClockOffsetRef.current = next.serverNow - Date.now()
        motionRef.current = next
        const fingerprint = [
          next.currentTick,
          ...next.vehicles.map(v =>
            `${v.id}:${v.currentStationId}:${v.direction}:${Math.round((v.segmentProgressMinutes || 0) * 2) / 2}:${v.status}:${v.isSpare ? 1 : 0}`,
          ),
        ].join('|')
        const prev = motionDriveRef.current
        const gameMinutesPerWallSecond = next.gameMinutesPerWallSecond
          || (next.gameMinutesPerTick / (next.liveTickMs / 1000))
        if (!prev || prev.fingerprint !== fingerprint) {
          // 차량 DB/틱이 바뀜 → 서버 syncTick·속도로 리베이스.
          // 브로드캐스트 사이에 실제 틱이 2개 이상 진행됐으면(자리 비움 뒤 밀린 틱 따라잡기)
          // 순항 속도로는 다음 메시지가 오기 전에 못 따라잡으므로 스냅으로 전환한다.
          const tickDelta = prev ? next.currentTick - prev.currentTick : 0
          motionDriveRef.current = {
            fingerprint,
            currentTick: next.currentTick,
            baseSyncTick: next.syncTick,
            baseServerNow: next.serverNow,
            vehicles: next.vehicles,
            liveTickMs: next.liveTickMs,
            gameMinutesPerTick: next.gameMinutesPerTick,
            gameMinutesPerWallSecond,
            physics: next.physics,
            catchingUp: tickDelta > 1,
            stationStats: next.stationStats,
          }
        } else {
          // 같은 DB 틱이어도 서버가 매 메시지마다 계산한 x/y·dwell·대기 승객 수는 계속 갱신된다.
          // (예전에는 vehicles를 안 고쳐 클라이언트가 오래된 좌표를 붙잡고 있었다.)
          prev.catchingUp = false
          prev.vehicles = next.vehicles
          prev.physics = next.physics
          prev.liveTickMs = next.liveTickMs
          prev.gameMinutesPerTick = next.gameMinutesPerTick
          prev.gameMinutesPerWallSecond = gameMinutesPerWallSecond
          prev.stationStats = next.stationStats
          const predicted = prev.baseSyncTick
            + (next.serverNow - prev.baseServerNow) / prev.liveTickMs
          if (next.syncTick > predicted + 0.02) {
            prev.baseSyncTick = next.syncTick
            prev.baseServerNow = next.serverNow
          }
        }
      },
      onError: message => {
        setError(message)
      },
    })
    return () => connection.close()
  }, [cityId, session?.token])

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

  // 커서/프레즌스: 이동 시에만 빠르게, 유휴 시에는 하트비트만 (액션 API와 DB 경쟁 완화)
  useEffect(() => {
    const token = session?.token
    if (!token) return
    let cancelled = false
    let inflight = false
    let lastSentAt = 0

    const pushCursors = async () => {
      if (cancelled || inflight) return
      const pos = cursorPosRef.current
      const x = pos?.x ?? cursorLastSentRef.current?.x ?? 50
      const y = pos?.y ?? cursorLastSentRef.current?.y ?? 50
      const prev = cursorLastSentRef.current
      const moved = !prev || Math.hypot(x - prev.x, y - prev.y) >= CURSOR_MOVE_THRESHOLD
      const interval = moved ? CURSOR_MOVE_SYNC_MS : CURSOR_HEARTBEAT_MS
      if (lastSentAt > 0 && Date.now() - lastSentAt < interval) return

      inflight = true
      try {
        const result = await syncCursor(cityId, token, x, y)
        if (cancelled) return
        lastSentAt = Date.now()
        cursorLastSentRef.current = { x, y }
        setRemoteCursors(prev => {
          const next = result.cursors
          if (
            prev.length === next.length
            && prev.every((item, i) => (
              item.playerId === next[i].playerId
              && item.x === next[i].x
              && item.y === next[i].y
              && item.nickname === next[i].nickname
            ))
          ) return prev
          return next
        })
      } catch {
        // 일시 네트워크 오류는 다음 틱에서 재시도 — 기존 표시는 유지
      } finally {
        inflight = false
      }
    }

    const timer = window.setInterval(() => { void pushCursors() }, CURSOR_MOVE_SYNC_MS)
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

  // 차량/시민 애니메이션 rAF 는 LiveTransitLayer 안에서만 돈다.
  // 여기서 setState 하면 사이드바·HUD까지 30fps로 다시 그려져 버벅인다.

  // 본인 + 다른 접속자를 상단 프레즌스 동그라미로 표시
  const presencePlayers = useMemo(() => {
    const others = new Map(
      remoteCursors.map(cursor => [
        cursor.playerId,
        { playerId: cursor.playerId, nickname: cursor.nickname, color: cursor.color },
      ]),
    )
    if (!session) return [...others.values()]
    const me = {
      playerId: session.playerId,
      nickname: session.nickname ?? session.username ?? '나',
      color: colorForPlayerId(session.playerId),
    }
    others.delete(session.playerId)
    return [me, ...others.values()]
  }, [remoteCursors, session])

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
  // 차고지 스퍼가 붙는 쪽 종점 (depot 좌표에 더 가까운 끝)
  const depotTerminusByStationId = useMemo(() => {
    const byStation = new Map<string, GameLine[]>()
    for (const line of sortedLines) {
      const terminus = depotTerminusOf(line)
      if (!terminus) continue
      const list = byStation.get(terminus.id) ?? []
      list.push(line)
      byStation.set(terminus.id, list)
    }
    return byStation
  }, [sortedLines])
  const mapDef = getCityMap(state?.city.mapKey)
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

  // 응급 상황(운영자금 마이너스 · 파산·행복도 위험 · 게임오버) 진입 순간에만 한 번씩 크롬 알림을 띄운다.
  // 도시를 새로 열었을 때 이미 위험한 상태였다면 그건 "방금 벌어진 일"이 아니므로 기준선만 세우고 알리지 않는다.
  useEffect(() => {
    if (!state) return
    const isNewCity = emergencyCityRef.current !== cityId
    emergencyCityRef.current = cityId

    const cashNegative = state.city.cashBalance < 0
    const bankruptcyRisk = state.city.cashBalance <= state.economyRules.bankruptLimit
    const happinessRisk = state.city.happiness <= state.economyRules.criticalHappiness
    const gameOverRisk = bankruptcyRisk || happinessRisk
    const gameOver = state.city.status === 'GAME_OVER'
    const roomTitle = state.city.roomTitle

    if (isNewCity) {
      cashEmergencyRef.current = cashNegative
      gameOverRiskRef.current = gameOverRisk
      gameOverFiredRef.current = gameOver
      return
    }

    if (cashNegative && !cashEmergencyRef.current) {
      void notifyEmergency(
        `${roomTitle} — 운영자금 마이너스`,
        '운영자금이 바닥났습니다. 노선을 점검해주세요.',
        `nlt-cash-${cityId}`,
      )
    }
    cashEmergencyRef.current = cashNegative

    if (gameOverRisk && !gameOverRiskRef.current) {
      void notifyEmergency(
        `${roomTitle} — 게임오버 위험`,
        bankruptcyRisk
          ? '파산 위험 상태입니다. 회복하지 못하면 곧 경영이 종료됩니다.'
          : '시민 행복도가 위험 수준입니다. 회복하지 못하면 곧 경영이 종료됩니다.',
        `nlt-risk-${cityId}`,
      )
    }
    gameOverRiskRef.current = gameOverRisk

    if (gameOver && !gameOverFiredRef.current) {
      void notifyEmergency(
        `${roomTitle} — 게임 오버`,
        state.city.gameOverReason === 'GOAL_DEADLINE'
          ? '경영 목표를 기한 안에 달성하지 못해 경영이 종료되었습니다.'
          : '경영이 종료되었습니다. 도시로 돌아가 다시 시작해보세요.',
        `nlt-gameover-${cityId}`,
      )
    }
    gameOverFiredRef.current = gameOver
  }, [state, cityId])

  useEffect(() => {
    if (!selectedVehicleId || !state) return
    const stillExists = state.city.lines.some(line => line.vehicles.some(vehicle => vehicle.id === selectedVehicleId))
    if (!stillExists) setSelectedVehicleId('')
  }, [selectedVehicleId, state])

  const pushSegmentUndo = (entry: SegmentUndoEntry) => {
    segmentUndoStackRef.current = [...segmentUndoStackRef.current.slice(-19), entry]
  }

  const performAction = async (action: CityAction) => {
    let pendingUndo: SegmentUndoEntry | null = null
    if (action.type === 'BUILD_SEGMENT') {
      const line = stateRef.current?.city.lines.find(item => item.id === action.lineId)
      if (line) {
        const onLine = new Set(line.lineStations.map(item => item.stationId))
        pendingUndo = onLine.size === 0
          ? { lineId: action.lineId, addedStationIds: [action.fromStationId, action.toStationId] }
          : {
              lineId: action.lineId,
              addedStationIds: [onLine.has(action.fromStationId) ? action.toStationId : action.fromStationId],
            }
      }
    } else if (action.type === 'INSERT_STATION') {
      pendingUndo = { lineId: action.lineId, addedStationIds: [action.stationId] }
    }

    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await executeCityAction(cityId, action, session?.token)
      // 서버가 이미 확정한 결과를 loadCity()의 네트워크 왕복을 기다리지 않고 먼저
      // 반영한다 — 역/노선 짓기 체감 지연의 실제 원인은 낙관적 UI가 없어서가 아니라
      // 성공 응답을 버리고 도시 전체를 다시 받아온 뒤에야 그리기 때문이었다.
      // line/station 응답에는 lineStations·vehicles 같은 연관 배열이 없어(방금
      // 만든 행 그대로라) 빈 배열로 채우고, 뒤이은 loadCity()가 정확히 맞춘다.
      if (action.type === 'BUILD_STATION' && result.station) {
        const station = result.station
        const cost = stateRef.current?.economyRules.buildCosts.station ?? 0
        const base = stateRef.current
        if (!base) return null
        const patched: CityState = {
          ...base,
          city: { ...base.city, stations: [...base.city.stations, station], cashBalance: base.city.cashBalance - cost },
          stationStats: [...base.stationStats, { stationId: station.id, waitingCount: 0, congestion: 0 }],
        }
        setState(patched)
        void loadCity()
        return patched
      }
      if (action.type === 'CREATE_LINE' && result.line) {
        const line: GameLine = { ...result.line, lineStations: [], vehicles: [], policies: [] }
        const cost = (action.mode === 'BUS'
          ? stateRef.current?.economyRules.buildCosts.busLine
          : stateRef.current?.economyRules.buildCosts.subwayLine) ?? 0
        const base = stateRef.current
        if (base) {
          setState({
            ...base,
            city: { ...base.city, lines: [...base.city.lines, line], cashBalance: base.city.cashBalance - cost },
          })
        }
      }
      const next = await loadCity()
      if (pendingUndo) pushSegmentUndo(pendingUndo)
      if (action.type === 'REMOVE_VEHICLE') setSelectedVehicleId('')
      if (action.type === 'RESET_CITY') {
        segmentUndoStackRef.current = []
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
      busyRef.current = false
      setBusy(false)
    }
  }
  performActionRef.current = performAction

  const undoLastSegment = async () => {
    if (busyRef.current) return
    const stack = segmentUndoStackRef.current
    const entry = stack[stack.length - 1]
    if (!entry) {
      setError('되돌릴 구간 연결이 없습니다.')
      return
    }
    segmentUndoStackRef.current = stack.slice(0, -1)

    for (const stationId of [...entry.addedStationIds].reverse()) {
      const line = stateRef.current?.city.lines.find(item => item.id === entry.lineId)
      if (!line?.lineStations.some(item => item.stationId === stationId)) continue
      const next = await performAction({
        type: 'DETACH_STATION',
        lineId: entry.lineId,
        stationId,
      })
      if (!next) {
        // 실패한 항목은 스택에 되돌려 재시도할 수 있게 한다
        segmentUndoStackRef.current = [...segmentUndoStackRef.current, {
          lineId: entry.lineId,
          addedStationIds: entry.addedStationIds.filter(id => {
            const current = stateRef.current?.city.lines.find(item => item.id === entry.lineId)
            return current?.lineStations.some(item => item.stationId === id) ?? false
          }),
        }].filter(item => item.addedStationIds.length > 0)
        return
      }
    }
    setError(null)
  }
  undoLastSegmentRef.current = undoLastSegment

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

    // 여러 액션으로 펼쳐지는 계획은 중간에 실패할 수 있어, 이미 실행된 결과도 함께 보고한다.
    const results: string[] = []
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

      let createdLineId = ''
      for (const action of plan.actions) {
        const request = action.type === 'BUILD_STATION'
          ? (() => {
              const spot = snapToLand(mapDef, action.posX, action.posY)
              if (!spot) throw new Error(`${action.name}을 지을 땅을 찾지 못했습니다. 지도에서 직접 지어주세요.`)
              return { ...action, ...spot }
            })()
          : action
        const result = await executeCityAction(cityId, request, session?.token)
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
      const failure = err instanceof Error ? err.message : '명령을 실행하지 못했습니다.'
      // 앞선 액션이 이미 반영됐을 수 있으므로 화면을 실제 상태로 되돌린다.
      if (results.length > 0) await loadCity().catch(() => null)
      appendCommandMessage({
        role: 'assistant',
        text: results.length > 0 ? `${results.join('\n')}\n${failure}` : failure,
        isError: true,
      })
    } finally {
      setCommandBusy(false)
      setBusy(false)
    }
  }

  const createLine = async (mode: 'SUBWAY' | 'BUS') => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await executeCityAction(cityId, { type: 'CREATE_LINE', mode }, session?.token)
      if (result.line) {
        const line: GameLine = { ...result.line, lineStations: [], vehicles: [], policies: [] }
        const cost = (mode === 'BUS'
          ? stateRef.current?.economyRules.buildCosts.busLine
          : stateRef.current?.economyRules.buildCosts.subwayLine) ?? 0
        setState(current => current && {
          ...current,
          city: { ...current.city, lines: [...current.city.lines, line], cashBalance: current.city.cashBalance - cost },
        })
      }
      await loadCity()
      if (result.line?.id) {
        setSelectedLineId(result.line.id)
        setSelectedVehicleId('')
        setSelectedStationId('')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '노선 생성 오류')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  createLineRef.current = createLine

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

  const setLineVehicleService = async (inService: boolean) => {
    const cityState = stateRef.current
    const lineId = selectedLineIdRef.current
    if (!cityState || !lineId || busyRef.current) return
    const line = cityState.city.lines.find(item => item.id === lineId)
    if (!line) {
      setError('먼저 운영 노선을 선택하세요. (F)')
      return
    }

    const isInService = (vehicle: (typeof line.vehicles)[number]) => (
      vehicle.status === 'OPERATING' && !vehicle.isSpare
    )
    const eligible = (vehicle: (typeof line.vehicles)[number]) => {
      if (!['OPERATING', 'SPARE'].includes(vehicle.status)) return false
      return inService ? !isInService(vehicle) : isInService(vehicle)
    }

    const vehicles = orderedVehicles(line)
    const selectedId = selectedVehicleIdRef.current
    const vehicle = (
      selectedId
        ? vehicles.find(item => item.id === selectedId && eligible(item))
        : undefined
    ) ?? vehicles.find(eligible)

    if (!vehicle) {
      setError(inService
        ? `${line.name}에 운행할 대기 차량이 없습니다.`
        : `${line.name}에 대기시킬 운행 차량이 없습니다.`)
      return
    }

    setSelectedVehicleId(vehicle.id)
    await performActionRef.current?.({
      type: 'SET_VEHICLE_SERVICE',
      lineId: line.id,
      vehicleId: vehicle.id,
      inService,
    })
  }
  setLineVehicleServiceRef.current = setLineVehicleService

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
    // 같은 역을 다시 클릭하면 선택 해제
    if (prevSelectedId === stationId) {
      setSelectedStationId('')
      setRenameValue('')
      return
    }
    setSelectedStationId(stationId)
    setRenameValue(station?.name ?? '')
    if (!prevSelectedId) return

    // 둘 다 선택 노선 위면 단순 재선택
    if (selectedLine && lineHasStation(selectedLine, prevSelectedId) && lineHasStation(selectedLine, stationId)) {
      return
    }

    // ＋로 만든(또는 플레이어 소유) 운영 노선만 이어준다. 없는 노선을 새로 만들지는 않는다.
    const isPlayerOperatedLine = !!selectedLine?.playerId
    if (selectedLine && isPlayerOperatedLine && canExtendLine(selectedLine, prevSelectedId, stationId)) {
      void performAction({
        type: 'BUILD_SEGMENT',
        lineId: selectedLine.id,
        fromStationId: prevSelectedId,
        toStationId: stationId,
      }).then(next => {
        // 연결에 성공하면 마지막 선택 역(B)을 자동 해제
        if (next) {
          setSelectedStationId('')
          setRenameValue('')
        }
      })
    }
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
            <p>이 도시에 접근할 수 없습니다.</p>
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

  // 도시 데이터는 왔지만, 자리를 비운 동안 밀린 틱을 아직 몰아서 따라잡는 중이면
  // 화면을 보여주지 않고 로딩 화면에 그 구간을 숨긴다. 사용자가 실제로 지도를 보는
  // 첫 프레임부터 이미 정상 속도로 움직이는 모습만 보이게 하기 위함.
  // motion을 최소 두 번은 받아봐야 "밀린 틱을 몰아가는 중"인지 판단할 기준(직전 대비 변화량)이
  // 생기고, motion이 계속 실패하는 경우를 대비해 최대 6초까지만 기다린다.
  // 지도를 한 번이라도 보여준 뒤에는(hasRevealedMapRef) 다시는 이 게이트로 전체 화면을
  // 덮지 않는다 — 플레이 도중 틱이 몰아쳐도 화면 전체가 로딩 화면으로 바뀌면서 역 짓기
  // 같은 버튼 클릭이 씹히는 일이 없게 한다. 그 뒤의 따라잡기는 차량/시계 보간이 흡수한다.
  const motionSettleGate = motionDriveRef.current
  const readyGateStartedAt = readyGateStartedAtRef.current ?? Date.now()
  const motionSettled = hasRevealedMapRef.current
    || state.city.status !== 'ACTIVE'
    || (motionPollCountRef.current >= 2 && !!motionSettleGate && !motionSettleGate.catchingUp)
    || (Date.now() - readyGateStartedAt > 6000)

  if (!motionSettled) {
    // 진행률 표시용 — 이 도시를 열었을 때 얼마나 밀려 있었는지 최초 한 번만 스냅샷을 찍고,
    // 그 이후 실제로 따라잡은 틱 수 비율로 진행률을 계산한다.
    if (!loadingBacklogRef.current) {
      const lastTickAtMs = Date.parse(state.city.lastTickAt)
      const estimatedPendingTicks = state.city.status === 'ACTIVE' && Number.isFinite(lastTickAtMs)
        ? Math.max(0, (Date.now() - lastTickAtMs) / LIVE_TICK_MS)
        : 0
      loadingBacklogRef.current = { initialTick: state.city.currentTick, estimatedPendingTicks }
    }
    const backlog = loadingBacklogRef.current
    const caughtUpTicks = Math.max(0, (motionSettleGate?.currentTick ?? backlog.initialTick) - backlog.initialTick)
    const tickProgress = backlog.estimatedPendingTicks > 0.1
      ? Math.min(1, caughtUpTicks / backlog.estimatedPendingTicks)
      : 1
    // motion이 안 오는 등 틱 기준 진행률이 안 움직이는 경우를 대비해, 시간 기준 진행률과
    // 둘 중 더 큰 쪽을 보여준다 — 진행 바가 멈춰 보이지 않게 하기 위함.
    const timeProgress = Math.min(1, (Date.now() - readyGateStartedAt) / 6000)
    const loadingProgress = Math.max(tickProgress, timeProgress)
    return (
      <div className={styles.loadingPage}>
        <div className={styles.loadingContent}>
          <div className={styles.loadingStatus}>
            <span className={styles.loadingDot} />
            <span>도시 로딩 중{caughtUpTicks >= 1 ? ` · 밀린 시간 따라잡는 중` : ''}</span>
          </div>
          <div className={styles.loadingProgressTrack}>
            <div
              className={styles.loadingProgressFill}
              style={{ width: `${Math.round(loadingProgress * 100)}%` }}
            />
          </div>
        </div>
      </div>
    )
  }
  hasRevealedMapRef.current = true

  const motionSnap = motionRef.current
  const motionDrive = motionDriveRef.current
  const currentTick = motionDrive?.currentTick ?? motionSnap?.currentTick ?? state.city.currentTick
  // HUD 시계/대기인원은 LiveTransitLayer가 500ms마다 샘플링해 올려준다.
  const continuousTick = hudSample.continuousTick > 0 ? hudSample.continuousTick : currentTick
  const currentGameDay = Math.floor(continuousTick / TICKS_PER_DAY) + 1
  const mapScale = mapView.width / 100
  const selectedStation = stationById.get(selectedStationId) ?? null
  const gameHour = (continuousTick / TICKS_PER_HOUR) % 24
  const isWeekend = Math.floor(continuousTick / TICKS_PER_DAY) % 7 >= 5
  const elapsedSeconds = continuousTick * (LIVE_TICK_MS / 1000)
  // 사이드바 차량 상태는 motion 스냅샷만 가볍게 읽는다(전체 리렌더 유발 없음).
  const motionVehicleById = new Map((motionDrive?.vehicles ?? motionSnap?.vehicles ?? []).map(item => [item.id, item]))
  const latestMetric = state.city.ticks[0]
  const serviceScore = latestMetric?.serviceScore ?? 100
  const totalVehicles = state.city.lines.reduce((sum, line) => sum + line.vehicles.length, 0)
  const waitingPassengers = hudSample.waitingPassengers
    || state.stationStats.reduce((sum, stat) => sum + stat.waitingCount, 0)
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
  // 새 역을 끼울 만큼 떨어진 종점 쌍을 찾아 "사이에 새 역" 예시를 만든다 (서버 최소 간격 6과 동일)
  for (const line of sortedLines) {
    const [head, tail] = [line.lineStations[0]?.station, line.lineStations[line.lineStations.length - 1]?.station]
    if (!head || !tail || head.id === tail.id) continue
    if (Math.hypot(head.posX - tail.posX, head.posY - tail.posY) < 6) continue
    commandExamples.push(`${head.name}과 ${tail.name} 사이에 새 역을 지어줘.`)
    break
  }
  const primaryCommandLine = sortedLines[0]
  if (primaryCommandLine) {
    commandExamples.push(`${primaryCommandLine.name}에 차량 한 대 더 구매해줘.`)
    commandExamples.push(`${primaryCommandLine.name} 차량 전부 운행에 투입해줘.`)
  }
  if (sortedLines.length > 1) {
    commandExamples.push('모든 노선 운행을 재개해줘.')
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
            {state.isOwner && session && (
              <button
                className={styles.inviteButton}
                onClick={() => setShowCitySettingsModal(true)}
                aria-label="관제실 설정"
                title="관제실 설정"
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M19.4 13.5a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V19.5a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H4.5a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H10a1.65 1.65 0 0 0 1-1.51V4.5a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V10a1.65 1.65 0 0 0 1.51 1H19.5a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>관제실 설정</span>
              </button>
            )}
            {session && (
              <button
                className={styles.inviteButton}
                onClick={() => setShowInviteModal(true)}
                aria-label="관제실 링크 공유"
                title="링크 공유"
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M10 13a5 5 0 0 0 7.54.54l1.91-1.91a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54L4.55 12.4a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>공유</span>
              </button>
            )}
          </div>
        </div>

        {session && showInviteModal && (
          <InviteModal
            cityId={cityId}
            onClose={() => setShowInviteModal(false)}
          />
        )}

        {state.isOwner && session && showCitySettingsModal && (
          <CitySettingsModal
            cityId={cityId}
            roomTitle={state.city.roomTitle}
            playerToken={session.token}
            onClose={() => setShowCitySettingsModal(false)}
            onDeleted={() => {
              setShowCitySettingsModal(false)
              onBack()
            }}
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
                ? '기한 안에 매출 목표를 달성하지 못해 경영이 종료되었습니다.'
                : `기한 안에 목표를 달성하면 지원금 ${formatMoney(state.economyRules.goalRewardCash)}과 8,000점을 받고 다음 목표가 열립니다.`}</p>
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

        {state.isOwner && (
          <section className={styles.controlSection} ref={commandSectionRef}>
            <div className={styles.sectionHeading}>
              <span>AI</span>
              <h2>도시 운영관 · A</h2>
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
                <div
                  className={styles.aiCommandExamples}
                  role="region"
                  tabIndex={0}
                  aria-label="도시 운영 명령 예시, 좌우로 스크롤 가능"
                >
                  {commandExamples.map(example => (
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
                  ref={commandInputRef}
                  value={commandInput}
                  onChange={event => setCommandInput(event.target.value)}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' || event.shiftKey) return
                    event.preventDefault()
                    void runCityCommand(commandInput)
                  }}
                  placeholder="예: 1호선을 시청역 방향으로 연장하고 차량 한 대 더 사줘."
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

        <section className={styles.controlSection} ref={linesSectionRef}>
          <div className={styles.sectionHeading}><span>01</span><h2>운영 노선 · F</h2></div>
          <div className={styles.lineTabs}>
            {sortedLines.map(line => (
              <button
                key={line.id}
                className={line.id === selectedLineId ? styles.lineTabActive : ''}
                onClick={() => selectLine(line.id)}
              >
                <i style={{ background: LINE_COLORS[line.color] }} />
                <span>{lineDisplayName(line.name)}</span>
                <small>{line.status === 'SUSPENDED' ? '폐쇄' : '운행'}</small>
              </button>
            ))}
          </div>
          <div className={styles.newLineRow}>
            <button onClick={() => void createLine('SUBWAY')} disabled={busy || isGameOver}>＋ 지하철 · {formatMoney(state.economyRules.buildCosts.subwayLine)} · C</button>
            <button onClick={() => void createLine('BUS')} disabled={busy || isGameOver}>＋ 버스 · {formatMoney(state.economyRules.buildCosts.busLine)} · V</button>
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
            <div className={styles.sectionHeading}>
              <span>02</span>
              <h2>{selectedLine.mode === 'BUS' ? '차량' : '철도 차량'} · 운행 G · 대기 H</h2>
            </div>
            <div className={styles.vehicleList}>
              {orderedVehicles(selectedLine).map((vehicle, index) => {
                const synced = motionVehicleById.get(vehicle.id)
                const fromStation = synced?.fromStationId ? stationById.get(synced.fromStationId) : null
                const toStation = synced?.toStationId ? stationById.get(synced.toStationId) : null
                const isDwelling = selectedLine.status === 'OPERATING' && vehicle.status === 'OPERATING' && !!synced?.isDwelling
                const isMoving = selectedLine.status === 'OPERATING' && vehicle.status === 'OPERATING' && !!toStation && !isDwelling
                const routeStatus = isMoving
                  ? `${fromStation?.name ?? '?'} → ${toStation?.name}`
                  : fromStation?.name ?? '대기'
                const vehicleInService = vehicle.status === 'OPERATING' && !vehicle.isSpare
                return (
                  <div key={vehicle.id} className={styles.vehicleRow}>
                    <button
                      className={`${styles.vehicleCard} ${vehicle.id === selectedVehicleId ? styles.vehicleSelected : ''}`}
                      aria-pressed={vehicle.id === selectedVehicleId}
                      onClick={() => selectVehicle(selectedLine.id, vehicle.id)}
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
                      className={vehicleInService ? styles.storeVehicleButton : styles.startVehicleButton}
                      onClick={() => void performAction({
                        type: 'SET_VEHICLE_SERVICE',
                        lineId: selectedLine.id,
                        vehicleId: vehicle.id,
                        inService: !vehicleInService,
                      })}
                      disabled={busy || !['OPERATING', 'SPARE'].includes(vehicle.status)}
                    >{vehicleInService ? '대기' : '운행'}</button>
                  </div>
                )
              })}
            </div>

            <div className={styles.newLineRow}>
              <button
                onClick={() => void performAction({ type: 'BUY_VEHICLE', lineId: selectedLine.id, count: 1 })}
                disabled={busy || isGameOver || selectedLine.vehicles.length >= MAX_VEHICLES_PER_LINE}
              >
                ＋ 차량 구매 · {formatMoney(selectedLine.mode === 'BUS'
                  ? state.economyRules.buildCosts.busVehicle
                  : state.economyRules.buildCosts.subwayVehicle)}
              </button>
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
          <section className={styles.controlSection} ref={stationSectionRef}>
            <div className={styles.sectionHeading}>
              <span>03</span><h2>역 관리 · T</h2>
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
                  ref={stationRenameInputRef}
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
                    >{lineDisplayName(line.name)}에서 제거</button>
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
      </aside>

      <main className={styles.gameStage}>
        <header className={styles.hudTop}>
          <div className={styles.cityIdentity}>
            <span className={styles.cityName}>{state.city.roomTitle}</span>
            <span>
              {state.city.name} · {Math.floor(continuousTick / TICKS_PER_DAY) + 1}일차{isWeekend ? ' · 주말' : ''} · {formatHour(gameHour)}
            </span>
          </div>
          <div className={styles.hudRight}>
            {presencePlayers.length > 0 && (
              <div className={styles.presenceGroup} aria-label={`현재 접속 중 ${presencePlayers.length}명`}>
                {presencePlayers.slice(0, 5).map(player => (
                  <span
                    key={player.playerId}
                    className={styles.presenceAvatar}
                    style={{ ['--presence-color' as string]: player.color }}
                    data-tooltip={player.nickname}
                  >
                    {player.playerId === state.city.ownerPlayerId && (
                      <span className={styles.presenceOwnerBadge}>관제장</span>
                    )}
                    {getInitials(player.nickname)}
                  </span>
                ))}
                {presencePlayers.length > 5 && (
                  <span className={styles.presenceAvatar} data-tooltip={presencePlayers.slice(5).map(p => p.nickname).join(', ')}>
                    +{presencePlayers.length - 5}
                  </span>
                )}
              </div>
            )}
            <div className={styles.hudStats}>
              <span><small>경영 점수</small><b>{state.city.score.toLocaleString('ko-KR')}</b></span>
              <span><small>운영 자금</small><b className={state.city.cashBalance < 0 ? styles.dangerValue : ''}>{formatMoney(state.city.cashBalance)}</b></span>
              <span><small>행복도</small><b>{Math.round(state.city.happiness)}%</b></span>
              <span><small>대기 승객</small><b>{waitingPassengers}명</b></span>
              <span><small>서비스 · 차량</small><b>{Math.round(serviceScore)} · {totalVehicles}대</b></span>
              <span className={styles.tickNumber}><small>플레이 시간</small><b>{formatElapsed(elapsedSeconds)}</b></span>
            </div>
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
              >역/정류장 짓기 · {formatMoney(state.economyRules.buildCosts.station)} · B</button>
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
            aria-label={`${mapDef.name} 지형과 일반역, 환승역, 노선`}
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

            {sortedLines.filter(line => line.lineStations.length > 1).map(line => (
              <g
                key={line.id}
                className={line.status === 'SUSPENDED' ? styles.closedLine : ''}
                data-map-interactive="true"
                role="button"
                tabIndex={0}
                aria-label={`${lineDisplayName(line.name)} 선택`}
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
                    style={{ strokeWidth: 1.85 * mapScale }}
                  />
                )}
                <polyline
                  points={linePoints(line)}
                  className={`${styles.linePath} ${line.mode === 'BUS' ? styles.busPath : ''} ${line.id === selectedLineId ? styles.selectedLinePath : ''}`}
                  style={{
                    stroke: LINE_COLORS[line.color],
                    // Mini Metro 느낌: 얇은 선, 줌과 무관하게 화면 기준 두께 유지
                    strokeWidth: (line.mode === 'BUS'
                      ? (line.id === selectedLineId ? 0.75 : 0.55)
                      : (line.id === selectedLineId ? 1.25 : 0.95)) * mapScale,
                    strokeDasharray: line.mode === 'BUS' ? `${1.1 * mapScale} ${0.7 * mapScale}` : undefined,
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
                strokeWidth: 0.95 * mapScale,
                strokeDasharray: `${1.1 * mapScale} ${0.8 * mapScale}`,
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
                    strokeWidth: 0.95 * mapScale,
                    strokeDasharray: `${1.1 * mapScale} ${0.8 * mapScale}`,
                  }}
                />
              )
            })()}

            {state.city.stations.map(station => {
              const point = stationPoint(station)
              const isInterchange = interchangeStationIds.has(station.id)
              const isBusStop = busOnlyStationIds.has(station.id)
              const depotLines = depotTerminusByStationId.get(station.id) ?? []
              const isDepotTerminus = depotLines.length > 0
              const depotLabel = depotLines.map(line => `${lineDisplayName(line.name)} 차고지`).join(' · ')
              const isCurrentVehicleStation = selectedVehicle?.currentStationId === station.id
              const isDropTarget = dragTarget?.kind === 'STATION' && dragTarget.id === station.id
              const highlighted = isCurrentVehicleStation || isDropTarget || station.id === selectedStationId
              const congestion = congestionByStation.get(station.id) ?? 0
              return (
                <g
                  key={station.id}
                  transform={`translate(${point.x} ${point.y}) scale(${mapScale})`}
                  className={`${styles.stationGroup}${isDepotTerminus ? ` ${styles.depotTerminusStation}` : ''}`}
                  onClick={event => handleStationClick(event, station.id)}
                  onPointerDown={event => beginStationLinkDrag(event, station.id)}
                  role="button"
                  tabIndex={0}
                  data-station-id={station.id}
                  data-map-interactive="true"
                  aria-label={`${station.name} ${isBusStop ? '버스 정류장' : isInterchange ? '환승역' : '일반역'}${isDepotTerminus ? ` · ${depotLabel}` : ''} 선택`}
                >
                  <title>{station.name} · {isBusStop ? '버스 정류장' : isInterchange ? '환승역' : '일반역'}{isDepotTerminus ? ` · ${depotLabel}` : ''}</title>
                  {highlighted && <circle r="1.55" className={styles.stationSelection} />}
                  {congestion >= CONGESTION_SATURATED ? (
                    <circle r="1.45" className={styles.saturatedRing} />
                  ) : congestion >= CONGESTION_WARN ? (
                    <circle r="1.35" className={styles.warnRing} />
                  ) : null}
                  {isBusStop ? (
                    <>
                      <rect x="-.8" y="-.8" width="1.6" height="1.6" rx=".28" className={styles.stationHalo} />
                      <rect x="-.55" y="-.55" width="1.1" height="1.1" rx=".22" className={styles.stationNode} />
                    </>
                  ) : isInterchange ? (
                    <>
                      <circle r="1.15" className={styles.stationHalo} />
                      <circle r="0.85" className={styles.stationNode} />
                      <circle r=".35" className={styles.transferCore} />
                    </>
                  ) : (
                    <>
                      <circle r="0.95" className={styles.stationHalo} />
                      <circle r="0.68" className={styles.stationNode} />
                    </>
                  )}
                  {isDepotTerminus && (
                    <text y="2.7" textAnchor="middle" className={styles.depotTerminusLabel}>
                      {depotLabel}
                    </text>
                  )}
                </g>
              )
            })}

            <LiveTransitLayer
              resetKey={cityId}
              city={state.city}
              stationStats={state.stationStats}
              mapDef={mapDef}
              mapScale={mapScale}
              selectedVehicleId={selectedVehicleId}
              motionRef={motionRef}
              motionDriveRef={motionDriveRef}
              motionClockOffsetRef={motionClockOffsetRef}
              stationById={stationById}
              farePerPassenger={state.economyRules.farePerPassenger}
              onSelectVehicle={selectVehicle}
              onHudSample={sample => {
                setHudSample(prev => (
                  prev.waitingPassengers === sample.waitingPassengers
                  && Math.abs(prev.continuousTick - sample.continuousTick) < 0.08
                    ? prev
                    : sample
                ))
              }}
            />

            {/* 역 이름은 항상 최상단 (SVG는 그리는 순서 = z-order) */}
            <g className={styles.stationLabelLayer}>
              {state.city.stations.filter(station => !isAutoStationName(station.name)).map(station => (
                <text
                  key={`label-${station.id}`}
                  transform={`translate(${station.posX} ${station.posY}) scale(${mapScale})`}
                  y={station.name === '서면역' ? 4.4 : -2.7}
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
                  <i style={{ background: LINE_COLORS[line.color] }} />{lineDisplayName(line.name)}{line.status === 'SUSPENDED' ? ' · 폐쇄' : ''}
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
                  <span><i className={styles.saturatedMark} />포화</span>
                </div>
                <div className={styles.legendRow} aria-label="구역 종류">
                  <b>구역</b>
                  <span><i className={styles.zoneMarkResidential} />주거</span>
                  <span><i className={styles.zoneMarkCommercial} />상업</span>
                  <span><i className={styles.zoneMarkIndustrial} />산업·오피스</span>
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
                : state.city.gameOverReason === 'HAPPINESS'
                  ? '시민 행복도가 장기간 바닥에 머물러 운영 권한을 잃었습니다.'
                  : '경영 목표를 정해진 기한 안에 달성하지 못해 운영 권한을 잃었습니다.'}
            </p>
            <div className={styles.gameOverStats}>
              <span><small>최종 점수</small><b>{state.city.score.toLocaleString('ko-KR')}</b></span>
              <span><small>누적 매출</small><b>{formatMoney(state.city.totalRevenue)}</b></span>
              <span><small>최종 행복도</small><b>{Math.round(state.city.happiness)}%</b></span>
            </div>
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

      {successToast && (
        <div
          className={`${styles.successToast}${successLeaving ? ` ${styles.successToastLeaving}` : ''}${error ? ` ${styles.successToastStacked}` : ''}`}
          role="status"
        >
          <span>✓</span>
          {successToast}
          <button
            type="button"
            className={styles.successToastClose}
            onClick={() => {
              setSuccessToast(null)
              setSuccessLeaving(false)
            }}
            aria-label="알림 닫기"
          >×</button>
        </div>
      )}

      {error && (
        <div
          className={`${styles.errorToast}${errorLeaving ? ` ${styles.errorToastLeaving}` : ''}`}
          role="alert"
        >
          <span>!</span>
          {error}
          <button
            type="button"
            className={styles.errorToastClose}
            onClick={() => {
              setError(null)
              setErrorStatus(null)
              setErrorLeaving(false)
            }}
            aria-label="알림 닫기"
          >×</button>
        </div>
      )}
    </div>
  )
}
