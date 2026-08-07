import { useEffect, useState, type FormEvent } from 'react'
import { createCity, fetchCityNames } from '../api/cities'
import styles from './NewCityModal.module.css'

interface Props {
  playerToken: string
  onClose: () => void
  onCreated: (cityId: string) => void
}

const ROOM_TITLE_ADJECTIVES = [
  '심야',
  '막차',
  '첫차',
  '혼잡',
  '긴급',
  '순환',
  '환승',
  '출근',
  '퇴근',
  '돌발',
  '해무',
  '폭우',
  '고속',
  '지하',
  '야간',
] as const

const ROOM_TITLE_NOUNS = [
  '관제실',
  '운영실',
  '사령실',
  '배차실',
  '통제실',
  '노선팀',
  '차고지',
  '종착역',
  '환승허브',
  '승강장',
] as const

function pickOne<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

function pickRandomRoomTitle() {
  return `${pickOne(ROOM_TITLE_ADJECTIVES)} ${pickOne(ROOM_TITLE_NOUNS)}`
}

export default function NewCityModal({ playerToken, onClose, onCreated }: Props) {
  const [cityNames, setCityNames] = useState<string[]>([])
  const [cityName, setCityName] = useState('')
  const [roomTitle, setRoomTitle] = useState(() => pickRandomRoomTitle())
  const [loadingNames, setLoadingNames] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setLoadingNames(true)
        const names = await fetchCityNames()
        if (cancelled) return
        setCityNames(names)
        setCityName(names[0] ?? '')
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : '도시 목록을 불러오지 못했습니다.')
        }
      } finally {
        if (!cancelled) setLoadingNames(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (creating || loadingNames) return

    const trimmedTitle = roomTitle.trim()
    if (!cityName) {
      setError('운영 도시를 선택해주세요.')
      return
    }
    if (!trimmedTitle) {
      setError('관제실 이름을 입력해주세요.')
      return
    }
    if (trimmedTitle.length > 24) {
      setError('관제실 이름은 24자까지입니다.')
      return
    }

    setError(null)
    setCreating(true)
    try {
      const created = await createCity(playerToken, {
        name: cityName,
        roomTitle: trimmedTitle,
      })
      onCreated(created.cityId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '도시를 만들지 못했습니다.')
      setCreating(false)
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>새 관제실 시작</div>
            <p className={styles.subtitle}>운영 도시를 고르고, 관제실 이름을 입력해주세요.</p>
          </div>
          <button className={styles.closeBtn} onClick={onClose} type="button" title="닫기">
            ✕
          </button>
        </div>

        <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
          <label className={styles.label} htmlFor="city-name">
            운영 도시
          </label>
          <select
            id="city-name"
            className={styles.select}
            value={cityName}
            onChange={(e) => setCityName(e.target.value)}
            disabled={loadingNames || creating || cityNames.length === 0}
          >
            {loadingNames && <option value="">불러오는 중…</option>}
            {!loadingNames && cityNames.length === 0 && <option value="">선택 가능한 도시 없음</option>}
            {cityNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          <label className={styles.label} htmlFor="room-title">
            관제실 이름
          </label>
          <div className={styles.titleRow}>
            <input
              id="room-title"
              className={styles.input}
              type="text"
              value={roomTitle}
              onChange={(e) => setRoomTitle(e.target.value)}
              placeholder="예: 심야 관제실"
              maxLength={24}
              disabled={creating}
            />
            <button
              className={styles.rerollBtn}
              type="button"
              onClick={() => setRoomTitle(pickRandomRoomTitle())}
              disabled={creating}
              title="다른 관제실 이름 뽑기"
            >
              다시 뽑기
            </button>
          </div>
          <p className={styles.hint}>처음엔 랜덤 단어로 정해져요. 원하면 직접 고쳐도 됩니다.</p>

          <button
            className={styles.submitBtn}
            type="submit"
            disabled={creating || loadingNames || !cityName}
          >
            {creating ? '시작 중…' : '관제실 시작'}
          </button>
        </form>

        {error && <p className={styles.errorText}>{error}</p>}
      </div>
    </div>
  )
}
