import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto'
import { promisify } from 'util'

const scrypt = promisify(scryptCallback)
const KEY_LENGTH = 64

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer
  return `${salt}:${derivedKey.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false

  const hashBuffer = Buffer.from(hash, 'hex')
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer
  if (hashBuffer.length !== derivedKey.length) return false

  return timingSafeEqual(hashBuffer, derivedKey)
}

export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/
