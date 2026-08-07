import { useState, type FormEvent } from 'react'
import { register, resendVerification } from '../api/auth'
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
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null)
  const [resendMessage, setResendMessage] = useState<string | null>(null)

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
      const result = await register(username.trim(), password, email.trim(), nickname.trim() || undefined)
      setSentTo(result.email)
      setVerifyUrl(result.verifyUrl ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '회원가입에 실패했습니다.')
    } finally {
      setLoading(false)
    }
  }

  const handleResend = async () => {
    setResendMessage(null)
    try {
      const result = await resendVerification(username.trim())
      setResendMessage(result.message)
      if (result.verifyUrl) setVerifyUrl(result.verifyUrl)
    } catch (err) {
      setResendMessage(err instanceof Error ? err.message : '재발송에 실패했습니다.')
    }
  }

  if (sentTo) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.header}>
            <div className={styles.titleKo}>인증 메일을 보냈습니다</div>
            <p className={styles.subtitle}>
              <strong>{sentTo}</strong>(으)로 인증 메일을 보냈습니다.
              <br />
              메일함·스팸함을 확인한 뒤 링크를 누르면 로그인할 수 있습니다.
            </p>
          </div>

          {verifyUrl && (
            <p className={styles.subtitle}>
              메일이 안 보이면 아래 링크로 바로 인증하세요.
              <br />
              <a className={styles.switchLink} href={verifyUrl}>
                이메일 인증하기
              </a>
            </p>
          )}

          {resendMessage && <p className={styles.errorText}>{resendMessage}</p>}

          <button className={styles.submitBtn} type="button" onClick={handleResend}>
            인증 메일 다시 보내기
          </button>

          <p className={styles.switchText}>
            <button className={styles.switchLink} type="button" onClick={onGoLogin}>
              로그인 화면으로 이동
            </button>
          </p>
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
              placeholder="인증 메일을 받을 이메일 주소"
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
