import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export type LocalDebugLevel = 'debug' | 'info' | 'warn' | 'error'

export type LocalDebugEvent = {
  level?: LocalDebugLevel
  message: string
  context?: unknown
  stack?: string
  url?: string
  timestamp?: string
}

const MAX_STRING_LENGTH = 12_000
const MAX_ARRAY_LENGTH = 50
const MAX_OBJECT_KEYS = 60
const MAX_DEPTH = 5
const SENSITIVE_KEY = /(?:password|passcode|token|authorization|cookie|secret|api[-_]?key|session|credential|email|username)/i
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi
const SENSITIVE_QUERY_PATTERN = /([?&](?:password|passcode|token|secret|api[-_]?key|email|username)=)[^&#\s]*/gi

export function isLocalDebugLoggingEnabled() {
  return process.env.NODE_ENV !== 'production' && process.env.LOCAL_DEBUG_LOG_ENABLED !== '0'
}

function redactString(value: string) {
  return value
    .slice(0, MAX_STRING_LENGTH)
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(SENSITIVE_QUERY_PATTERN, '$1[REDACTED]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
}

export function sanitizeForLocalDebug(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]'

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    }
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => sanitizeForLocalDebug(item, depth + 1, seen))
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]'
    seen.add(value)

    const sanitized: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      sanitized[key] = SENSITIVE_KEY.test(key)
        ? '[REDACTED]'
        : sanitizeForLocalDebug(item, depth + 1, seen)
    }
    return sanitized
  }

  return redactString(String(value))
}

function resolveLogDirectory() {
  const configured = process.env.LOCAL_DEBUG_LOG_DIR
  if (configured) return path.resolve(configured)
  return path.resolve(process.cwd(), '..', '.logs', 'manual')
}

export async function appendLocalDebugEvents(
  source: 'browser' | 'server',
  events: LocalDebugEvent[],
) {
  if (!isLocalDebugLoggingEnabled() || events.length === 0) return

  const logDirectory = resolveLogDirectory()
  await mkdir(logDirectory, { recursive: true })

  const receivedAt = new Date().toISOString()
  const lines = events.slice(0, 50).map((event) => JSON.stringify({
    timestamp: event.timestamp ?? receivedAt,
    receivedAt,
    source,
    level: event.level ?? 'info',
    message: redactString(event.message),
    stack: event.stack ? redactString(event.stack) : undefined,
    url: event.url ? redactString(event.url) : undefined,
    context: sanitizeForLocalDebug(event.context),
  })).join('\n')

  await appendFile(path.join(logDirectory, `${source}.ndjson`), `${lines}\n`, 'utf8')
}
