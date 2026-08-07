import { readFileSync } from 'fs'
import { resolve } from 'path'
import nodemailer from 'nodemailer'

for (const line of readFileSync(resolve(__dirname, '../.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2].trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1)
  }
  process.env[m[1]] ??= v
}

async function main() {
  console.log('USER', process.env.GMAIL_USER ? 'set' : 'missing')
  console.log('PASS', process.env.GMAIL_APP_PASSWORD ? `set len=${process.env.GMAIL_APP_PASSWORD.length}` : 'missing')

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  })

  try {
    await transporter.verify()
    console.log('VERIFY_OK')
    const info = await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.argv[2] || 'plib7070@gmail.com',
      subject: '[막차는 없다] SMTP 테스트',
      text: `메일 발송 테스트입니다. ${new Date().toISOString()}`,
    })
    console.log('SEND_OK', info.messageId, info.response)
  } catch (e) {
    console.error('FAIL', e)
    process.exit(1)
  }
}

main()
