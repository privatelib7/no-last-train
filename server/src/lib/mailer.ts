import nodemailer from 'nodemailer'

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
})

export function buildVerifyUrl(token: string) {
  const baseUrl = process.env.APP_BASE_URL ?? 'http://localhost:5173'
  return `${baseUrl}/?verifyToken=${encodeURIComponent(token)}`
}

export function buildResetUrl(token: string) {
  const baseUrl = process.env.APP_BASE_URL ?? 'http://localhost:5173'
  return `${baseUrl}/?resetToken=${encodeURIComponent(token)}`
}

export async function sendVerificationEmail(to: string, token: string) {
  const fromUser = process.env.GMAIL_USER
  if (!fromUser) throw new Error('GMAIL_USER가 설정되지 않았습니다.')

  const verifyUrl = buildVerifyUrl(token)
  const isLocalLink = /localhost|127\.0\.0\.1/.test(verifyUrl)

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[mail] verification link for ${to}: ${verifyUrl}`)
    if (isLocalLink) {
      console.warn(
        '[mail] APP_BASE_URL이 localhost라 Gmail이 스팸으로 분류하기 쉽습니다. 화면의 인증 링크를 쓰거나 공개 HTTPS URL을 설정하세요.',
      )
    }
  }

  const text = [
    '막차는 없다 회원가입 확인',
    '',
    '안녕하세요.',
    '계정을 활성화하려면 아래 주소를 브라우저에서 열어주세요.',
    '',
    verifyUrl,
    '',
    '이 안내는 24시간 동안만 유효합니다.',
    '요청하지 않았다면 이 메일은 무시하셔도 됩니다.',
    '',
    '- 막차는 없다',
  ].join('\n')

  const html = `
<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#F0EDE8;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F0EDE8;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#FAFAF7;border:1px solid #D4CFC8;border-radius:12px;padding:32px 28px;font-family:'Apple SD Gothic Neo',Malgun Gothic,sans-serif;color:#1A1613;">
          <tr>
            <td>
              <p style="margin:0 0 8px;font-size:13px;color:#7A7265;letter-spacing:0.04em;">NO LAST TRAIN</p>
              <h1 style="margin:0 0 20px;font-size:22px;font-weight:700;line-height:1.3;">가입 확인</h1>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#1A1613;">
                안녕하세요.<br />
                막차는 없다 계정 인증을 위해 아래 버튼을 눌러 주세요.
              </p>
              <p style="margin:28px 0;" align="center">
                <a href="${verifyUrl}"
                   style="display:inline-block;background:#E07B35;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:700;">
                  계정 인증하기
                </a>
              </p>
              <p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:#7A7265;word-break:break-all;">
                버튼이 열리지 않으면 이 주소를 복사해 브라우저에 붙여 넣으세요.<br />
                ${verifyUrl}
              </p>
              <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#A89F95;">
                본 메일은 계정 확인용입니다. 24시간 후 만료됩니다.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim()

  await transporter.sendMail({
    from: {
      name: '막차는 없다',
      address: fromUser,
    },
    replyTo: fromUser,
    to,
    subject: '막차는 없다 가입 확인',
    text,
    html,
    headers: {
      'X-Priority': '3',
      'X-Mailer': 'NoLastTrain',
    },
  })

  return verifyUrl
}

export async function sendPasswordResetEmail(to: string, token: string) {
  const fromUser = process.env.GMAIL_USER
  if (!fromUser) throw new Error('GMAIL_USER가 설정되지 않았습니다.')

  const resetUrl = buildResetUrl(token)
  const isLocalLink = /localhost|127\.0\.0\.1/.test(resetUrl)

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[mail] password reset link for ${to}: ${resetUrl}`)
    if (isLocalLink) {
      console.warn(
        '[mail] APP_BASE_URL이 localhost라 Gmail이 스팸으로 분류하기 쉽습니다. 화면의 재설정 링크를 쓰거나 공개 HTTPS URL을 설정하세요.',
      )
    }
  }

  const text = [
    '막차는 없다 비밀번호 재설정',
    '',
    '안녕하세요.',
    '비밀번호를 재설정하려면 아래 주소를 브라우저에서 열어주세요.',
    '',
    resetUrl,
    '',
    '이 안내는 1시간 동안만 유효합니다.',
    '요청하지 않았다면 이 메일은 무시하셔도 됩니다.',
    '',
    '- 막차는 없다',
  ].join('\n')

  const html = `
<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#F0EDE8;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F0EDE8;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#FAFAF7;border:1px solid #D4CFC8;border-radius:12px;padding:32px 28px;font-family:'Apple SD Gothic Neo',Malgun Gothic,sans-serif;color:#1A1613;">
          <tr>
            <td>
              <p style="margin:0 0 8px;font-size:13px;color:#7A7265;letter-spacing:0.04em;">NO LAST TRAIN</p>
              <h1 style="margin:0 0 20px;font-size:22px;font-weight:700;line-height:1.3;">비밀번호 재설정</h1>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#1A1613;">
                안녕하세요.<br />
                아래 버튼을 눌러 새 비밀번호를 설정해 주세요.
              </p>
              <p style="margin:28px 0;" align="center">
                <a href="${resetUrl}"
                   style="display:inline-block;background:#E07B35;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:700;">
                  비밀번호 재설정하기
                </a>
              </p>
              <p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:#7A7265;word-break:break-all;">
                버튼이 열리지 않으면 이 주소를 복사해 브라우저에 붙여 넣으세요.<br />
                ${resetUrl}
              </p>
              <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#A89F95;">
                본 메일은 비밀번호 재설정 요청에 의해 발송되었습니다. 1시간 후 만료됩니다.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim()

  await transporter.sendMail({
    from: {
      name: '막차는 없다',
      address: fromUser,
    },
    replyTo: fromUser,
    to,
    subject: '막차는 없다 비밀번호 재설정',
    text,
    html,
    headers: {
      'X-Priority': '3',
      'X-Mailer': 'NoLastTrain',
    },
  })

  return resetUrl
}
