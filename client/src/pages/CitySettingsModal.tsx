import { useState } from 'react'
import { deleteCity } from '../api/cities'
import styles from './CitySettingsModal.module.css'

interface Props {
  cityId: string
  roomTitle: string
  playerToken: string
  onClose: () => void
  onDeleted: () => void
}

export default function CitySettingsModal({ cityId, roomTitle, playerToken, onClose, onDeleted }: Props) {
  const [step, setStep] = useState<'menu' | 'confirmName'>('menu')
  const [nameInput, setNameInput] = useState('')
  const [showConfirmPopup, setShowConfirmPopup] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nameMatches = nameInput === roomTitle

  const backToMenu = () => {
    setStep('menu')
    setNameInput('')
    setError(null)
  }

  const handleConfirmDelete = async () => {
    if (deleting) return
    setDeleting(true)
    setError(null)
    try {
      await deleteCity(cityId, playerToken, roomTitle)
      onDeleted()
    } catch (err) {
      setShowConfirmPopup(false)
      setDeleting(false)
      setError(err instanceof Error ? err.message : '관제실을 삭제하지 못했습니다.')
    }
  }

  return (
    <div className={styles.overlay} onClick={() => { if (!showConfirmPopup) onClose() }}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.title}>관제실 설정</div>
          <button className={styles.closeBtn} onClick={onClose} type="button" title="닫기">
            ✕
          </button>
        </div>

        {step === 'menu' && (
          <button
            className={styles.dangerBtn}
            type="button"
            onClick={() => setStep('confirmName')}
          >
            관제실 삭제
          </button>
        )}

        {step === 'confirmName' && (
          <div className={styles.confirmSection}>
            <p className={styles.warningText}>
              관제실을 삭제하면 역·노선·운행 기록이 모두 사라지고 되돌릴 수 없습니다.
              계속하려면 관제실 이름 <b>{roomTitle}</b>을(를) 그대로 입력하세요.
            </p>
            <input
              className={styles.input}
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder={roomTitle}
              autoFocus
              aria-label="관제실 이름 확인"
            />
            <div className={styles.actionsRow}>
              <button className={styles.cancelBtn} type="button" onClick={backToMenu}>
                취소
              </button>
              <button
                className={styles.dangerBtn}
                type="button"
                disabled={!nameMatches}
                onClick={() => setShowConfirmPopup(true)}
              >
                삭제하기
              </button>
            </div>
          </div>
        )}

        {error && <p className={styles.errorText}>{error}</p>}
      </div>

      {showConfirmPopup && (
        <div className={styles.popupOverlay} onClick={() => !deleting && setShowConfirmPopup(false)}>
          <div className={styles.popupCard} onClick={(e) => e.stopPropagation()}>
            <p className={styles.popupText}>정말 관제실을 삭제하시겠습니까?</p>
            <div className={styles.actionsRow}>
              <button
                className={styles.cancelBtn}
                type="button"
                onClick={() => setShowConfirmPopup(false)}
                disabled={deleting}
              >
                아니오
              </button>
              <button
                className={styles.dangerBtn}
                type="button"
                onClick={() => void handleConfirmDelete()}
                disabled={deleting}
              >
                {deleting ? '삭제 중…' : '예'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
