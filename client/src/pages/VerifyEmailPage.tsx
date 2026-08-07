import { useEffect, useState } from 'react'
import { verifyEmail } from '../api/auth'
import styles from './AuthPage.module.css'

interface Props {
  token: string
  onGoLogin: () => void
}

type Status = 'checking' | 'success' | 'error'

export default function VerifyEmailPage({ token, onGoLogin }: Props) {
  const [status, setStatus] = useState<Status>('checking')
  const [message, setMessage] = useState('인증을 확인하는 중입니다…')

  useEffect(() => {
    let cancelled = false
    verifyEmail(token)
      .then((result) => {
        if (cancelled) return
        setStatus('success')
        setMessage(result.message)
      })
      .catch((err) => {
        if (cancelled) return
        setStatus('error')
        setMessage(err instanceof Error ? err.message : '인증에 실패했습니다.')
      })
    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.titleKo}>
            {status === 'checking' && '이메일 인증'}
            {status === 'success' && '인증 완료'}
            {status === 'error' && '인증 실패'}
          </div>
          <p className={styles.subtitle}>{message}</p>
        </div>

        {status !== 'checking' && (
          <button className={styles.submitBtn} type="button" onClick={onGoLogin}>
            로그인하러 가기
          </button>
        )}
      </div>
    </div>
  )
}
