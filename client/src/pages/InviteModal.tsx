import { useState } from 'react'
import styles from './InviteModal.module.css'

interface Props {
  cityId: string
  onClose: () => void
}

export default function InviteModal({ cityId, onClose }: Props) {
  const [copied, setCopied] = useState(false)

  const shareUrl = `${window.location.origin}${window.location.pathname}?city=${cityId}`

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

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>링크 공유</div>
            <p className={styles.subtitle}>링크를 받은 사람이 로그인하면 바로 이 관제실에서 플레이할 수 있어요.</p>
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
      </div>
    </div>
  )
}
