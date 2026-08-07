import { useState, type FormEvent } from 'react'
import { resetPassword } from '../api/auth'
import styles from './AuthPage.module.css'

interface Props {
  token: string
  onGoLogin: () => void
}

export default function ResetPasswordPage({ token, onGoLogin }: Props) {
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (loading) return
    setError(null)

    if (password.length < 8) {
      setError('비밀번호는 8자 이상이어야 합니다.')
      return
    }
    if (password !== passwordConfirm) {
      setError('비밀번호가 일치하지 않습니다.')
      return
    }

    setLoading(true)
    try {
      await resetPassword(token, password)
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '비밀번호 재설정에 실패했습니다.')
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.header}>
            <div className={styles.titleKo}>재설정 완료</div>
            <p className={styles.subtitle}>비밀번호가 재설정되었습니다. 새 비밀번호로 로그인해주세요.</p>
          </div>

          <button className={styles.submitBtn} type="button" onClick={onGoLogin}>
            로그인하러 가기
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.titleKo}>새 비밀번호 설정</div>
          <p className={styles.subtitle}>새로 사용할 비밀번호를 입력해주세요.</p>
        </div>

        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span className={styles.label}>새 비밀번호</span>
            <input
              className={styles.input}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="8자 이상"
              required
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>새 비밀번호 확인</span>
            <input
              className={styles.input}
              type="password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              autoComplete="new-password"
              placeholder="비밀번호를 다시 입력하세요"
              required
            />
          </label>

          {error && <p className={styles.errorText}>{error}</p>}

          <button className={styles.submitBtn} type="submit" disabled={loading}>
            {loading ? '변경 중…' : '비밀번호 변경'}
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
