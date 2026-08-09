import { useState, type FormEvent } from 'react'
import { register } from '../api/auth'
import styles from './AuthPage.module.css'

interface Props {
  onBack: () => void
  onGoLogin: () => void
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function RegisterPage({ onBack, onGoLogin }: Props) {
  const [username, setUsername] = useState('')
  const [nickname, setNickname] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (loading) return
    setError(null)

    if (!USERNAME_PATTERN.test(username.trim())) {
      setError('아이디는 영문/숫자/밑줄 3~20자여야 합니다.')
      return
    }
    if (!EMAIL_PATTERN.test(email.trim())) {
      setError('올바른 이메일 주소를 입력해주세요.')
      return
    }
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
      await register(username.trim(), password, email.trim(), nickname.trim() || undefined)
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '회원가입에 실패했습니다.')
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.header}>
            <div className={styles.titleKo}>가입을 축하드립니다!</div>
            <p className={styles.subtitle}>
              {username}님, 환영합니다.
              <br />
              이제 로그인하고 도시 운영을 시작해보세요.
            </p>
          </div>

          <button className={styles.submitBtn} type="button" onClick={onBack}>
            메인으로
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
          <div className={styles.titleKo}>회원가입</div>
          <p className={styles.subtitle}>아이디와 비밀번호를 만들어 도시 운영을 시작하세요.</p>
        </div>

        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span className={styles.label}>아이디</span>
            <input
              className={styles.input}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              placeholder="영문/숫자/밑줄 3~20자"
              required
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>이메일</span>
            <input
              className={styles.input}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="이메일을 입력하세요"
              required
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>닉네임 (선택)</span>
            <input
              className={styles.input}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              autoComplete="nickname"
              placeholder="게임 안에서 표시될 이름"
              maxLength={20}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>비밀번호</span>
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
            <span className={styles.label}>비밀번호 확인</span>
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
            {loading ? '가입 중…' : '회원가입'}
          </button>
        </form>

        <p className={styles.switchText}>
          이미 계정이 있으신가요?{' '}
          <button className={styles.switchLink} type="button" onClick={onGoLogin}>
            로그인
          </button>
        </p>
      </div>
    </div>
  )
}
