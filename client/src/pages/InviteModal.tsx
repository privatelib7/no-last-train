import { useEffect, useState, type FormEvent } from 'react'
import { addInvite, fetchInvites, type CityInvite } from '../api/invites'
import styles from './InviteModal.module.css'

interface Props {
  cityId: string
  playerToken: string
  onClose: () => void
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function InviteModal({ cityId, playerToken, onClose }: Props) {
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null)
  const [invites, setInvites] = useState<CityInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const [copied, setCopied] = useState(false)

  const shareUrl = `${window.location.origin}${window.location.pathname}?city=${cityId}`

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setLoading(true)
        setLoadError(null)
        const data = await fetchInvites(cityId, playerToken)
        if (!cancelled) {
          setOwnerEmail(data.ownerEmail)
          setInvites(data.invites)
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : '초대 목록을 불러오지 못했습니다.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [cityId, playerToken])

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
    } catch {
      window.prompt('아래 링크를 복사하세요', shareUrl)
      setCopied(true)
    } finally {
      setTimeout(() => setCopied(false), 1800)
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (submitting) return
    const normalized = email.trim().toLowerCase()
    if (!EMAIL_PATTERN.test(normalized)) {
      setSubmitError('올바른 이메일 주소를 입력해주세요.')
      return
    }

    setSubmitting(true)
    setSubmitError(null)
    try {
      const invite = await addInvite(cityId, playerToken, normalized)
      setInvites((prev) => (prev.some((i) => i.email === invite.email) ? prev : [...prev, invite]))
      setEmail('')
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : '초대에 실패했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>이 도시에 초대</div>
            <p className={styles.subtitle}>초대된 이메일로 로그인한 사람만 이 도시에 접근할 수 있어요.</p>
          </div>
          <button className={styles.closeBtn} onClick={onClose} type="button" title="닫기">
            ✕
          </button>
        </div>

        <div className={styles.linkRow}>
          <span className={styles.linkText}>{shareUrl}</span>
          <button
            className={`${styles.copyBtn} ${copied ? styles.copyBtnCopied : ''}`}
            onClick={() => void handleCopyLink()}
            type="button"
          >
            {copied ? '복사됨' : '링크 복사'}
          </button>
        </div>

        <div className={styles.divider} />

        <div className={styles.sectionLabel}>이메일로 초대</div>
        <form className={styles.inviteForm} onSubmit={handleSubmit}>
          <input
            className={styles.emailInput}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="example@gmail.com"
          />
          <button className={styles.addBtn} type="submit" disabled={submitting}>
            {submitting ? '추가 중…' : '추가'}
          </button>
        </form>
        {submitError && <p className={styles.errorText}>{submitError}</p>}

        {loading && <p className={styles.stateText}>불러오는 중…</p>}
        {loadError && <p className={styles.errorText}>{loadError}</p>}

        {!loading && !loadError && (
          <div className={styles.inviteList}>
            {ownerEmail && (
              <div className={`${styles.inviteRow} ${styles.ownerRow}`}>
                <span className={styles.inviteEmail}>{ownerEmail}</span>
                <span className={styles.ownerBadge}>관제장</span>
              </div>
            )}
            {invites
              .filter((invite) => invite.email !== ownerEmail)
              .map((invite) => (
                <div key={invite.email} className={styles.inviteRow}>
                  <span className={styles.inviteEmail}>{invite.email}</span>
                  <span className={styles.memberBadge}>관제원</span>
                </div>
              ))}
            {!ownerEmail && invites.length === 0 && (
              <p className={styles.stateText}>아직 초대된 사람이 없습니다.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
