import { NextResponse } from 'next/server'
import {
  appendLocalDebugEvents,
  isLocalDebugLoggingEnabled,
  type LocalDebugEvent,
  type LocalDebugLevel,
} from '@/lib/local-debug-log'

export const runtime = 'nodejs'

const MAX_BODY_BYTES = 128 * 1024
const LEVELS = new Set<LocalDebugLevel>(['debug', 'info', 'warn', 'error'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEvent(value: unknown): LocalDebugEvent | null {
  if (!isRecord(value) || typeof value.message !== 'string' || value.message.trim() === '') return null

  return {
    message: value.message,
    level: typeof value.level === 'string' && LEVELS.has(value.level as LocalDebugLevel)
      ? value.level as LocalDebugLevel
      : 'info',
    context: value.context,
    stack: typeof value.stack === 'string' ? value.stack : undefined,
    url: typeof value.url === 'string' ? value.url : undefined,
    timestamp: typeof value.timestamp === 'string' ? value.timestamp : undefined,
  }
}

export async function POST(request: Request) {
  if (!isLocalDebugLoggingEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Log payload is too large' }, { status: 413 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  const candidates = isRecord(body) && Array.isArray(body.events) ? body.events : []
  const events = candidates.slice(0, 50).map(parseEvent).filter((event): event is LocalDebugEvent => event !== null)
  if (events.length === 0) {
    return NextResponse.json({ error: 'No valid log events' }, { status: 400 })
  }

  await appendLocalDebugEvents('browser', events)
  return NextResponse.json({ ok: true, count: events.length })
}
