import { useState, type FormEvent } from 'react'
import { login, resendVerification } from '../api/auth'
import type { AuthSession } from '../api/auth'
import styles from './AuthPage.module.css'

interface Props {
  onBack: () => void
  onGoRegister: () => void
  onGoForgotPassword: () => void
  onLoggedIn: (session: AuthSession) => void
}

export default function LoginPage({ onBack, onGoRegister, onGoForgotPassword, onLoggedIn }: Props) {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [needsVerification, setNeedsVerification] = useState(false)
  const [resendMessage, setResendMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (loading) return
    setError(null)
    setNeedsVerification(false)
    setResendMessage(null)
    setLoading(true)
    try {
      const session = await login(identifier.trim(), password)
      onLoggedIn(session)
    } catch (err) {
      const e2 = err as Error & { code?: string }
      setError(e2 instanceof Error ? e2.message : '로그인에 실패했습니다.')
      setNeedsVerification(e2.code === 'EMAIL_NOT_VERIFIED')
    } finally {
      setLoading(false)
    }
  }

  const handleResend = async () => {
    setResendMessage(null)
    try {
      const result = await resendVerification(identifier.trim())
      setResendMessage(
        result.verifyUrl
          ? `${result.message} (개발용 링크: ${result.verifyUrl})`
          : `${result.message} 스팸함도 확인해보세요.`,
      )
    } catch (err) {
      setResendMessage(err instanceof Error ? err.message : '재발송에 실패했습니다.')
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <button className={styles.backBtn} onClick={onBack} type="button" title="타이틀로">
          <span className={styles.backArrow}>←</span>
        </button>

        <div className={styles.header}>
          <div className={styles.titleKo}>로그인</div>
          <p className={styles.subtitle}>아이디 또는 이메일과 비밀번호로 도시에 접속하세요.</p>
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

          <label className={styles.field}>
            <span className={styles.label}>비밀번호</span>
            <input
              className={styles.input}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="비밀번호를 입력하세요"
              required
            />
          </label>

          {error && <p className={styles.errorText}>{error}</p>}

          {needsVerification && (
            <button className={styles.switchLink} type="button" onClick={handleResend}>
              인증 메일 다시 보내기
            </button>
          )}
          {resendMessage && <p className={styles.subtitle}>{resendMessage}</p>}

          <button className={styles.submitBtn} type="submit" disabled={loading}>
            {loading ? '로그인 중…' : '로그인'}
          </button>
        </form>

        <p className={styles.switchText}>
          <button className={styles.switchLink} type="button" onClick={onGoForgotPassword}>
            비밀번호를 잊으셨나요?
          </button>
        </p>

        <p className={styles.switchText}>
          아직 계정이 없으신가요?{' '}
          <button className={styles.switchLink} type="button" onClick={onGoRegister}>
            회원가입
          </button>
        </p>
      </div>
    </div>
  )
}
