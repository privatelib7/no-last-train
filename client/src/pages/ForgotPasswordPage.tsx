import { useState, type FormEvent } from 'react'
import { forgotPassword } from '../api/auth'
import styles from './AuthPage.module.css'

interface Props {
  onBack: () => void
  onGoLogin: () => void
}

export default function ForgotPasswordPage({ onBack, onGoLogin }: Props) {
  const [identifier, setIdentifier] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [resetUrl, setResetUrl] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (loading) return
    setError(null)
    setLoading(true)
    try {
      const result = await forgotPassword(identifier.trim())
      setSent(true)
      setResetUrl(result.resetUrl ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '재설정 메일 발송에 실패했습니다.')
    } finally {
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.header}>
            <div className={styles.titleKo}>메일을 확인해주세요</div>
            <p className={styles.subtitle}>
              해당 계정이 있다면 비밀번호 재설정 메일을 보냈습니다.
              <br />
              메일함·스팸함을 확인한 뒤 링크를 눌러 새 비밀번호를 설정하세요.
            </p>
          </div>

          {resetUrl && (
            <p className={styles.subtitle}>
              메일이 안 보이면 아래 링크로 바로 재설정하세요.
              <br />
              <a className={styles.switchLink} href={resetUrl}>
                비밀번호 재설정하기
              </a>
            </p>
          )}

          <button className={styles.submitBtn} type="button" onClick={onGoLogin}>
            로그인 화면으로 이동
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <button className={styles.backBtn} onClick={onBack} type="button" title="타이틀로">
          <span className={styles.backArrow}>←</span>
        </button>

        <div className={styles.header}>
          <div className={styles.titleKo}>비밀번호 찾기</div>
          <p className={styles.subtitle}>가입한 아이디 또는 이메일을 입력하면 재설정 메일을 보내드립니다.</p>
        </div>

        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span className={styles.label}>아이디 또는 이메일</span>
            <input
              className={styles.input}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoComplete="username"
              placeholder="아이디 또는 이메일을 입력하세요"
              required
            />
          </label>

          {error && <p className={styles.errorText}>{error}</p>}

          <button className={styles.submitBtn} type="submit" disabled={loading}>
            {loading ? '전송 중…' : '재설정 메일 보내기'}
          </button>
        </form>

        <p className={styles.switchText}>
          <button className={styles.switchLink} type="button" onClick={onGoLogin}>
            로그인 화면으로 돌아가기
          </button>
        </p>
      </div>
    </div>
  )
}
