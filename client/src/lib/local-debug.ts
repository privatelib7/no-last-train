type BrowserDebugLevel = 'debug' | 'info' | 'warn' | 'error'

type BrowserDebugEvent = {
  timestamp: string
  level: BrowserDebugLevel
  message: string
  context?: unknown
  stack?: string
  url: string
}

declare global {
  interface Window {
    __nltLocalDebugInstalled?: boolean
  }
}

const LOG_ENDPOINT = '/api/debug/logs'
const MAX_QUEUE_SIZE = 100
const FLUSH_DELAY_MS = 500

let queue: BrowserDebugEvent[] = []
let flushTimer: number | undefined
let originalFetch: typeof window.fetch | null = null

function safePageUrl() {
  return `${window.location.origin}${window.location.pathname}`
}

function safeRequestUrl(value: string) {
  try {
    const url = new URL(value, window.location.origin)
    return `${url.origin}${url.pathname}`
  } catch {
    return value.split('?')[0]
  }
}

function toLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (depth >= 4) return '[MAX_DEPTH]'

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => toLogValue(item, depth + 1, seen))
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]'
    seen.add(value)
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, item]) => [key, toLogValue(item, depth + 1, seen)]),
    )
  }
  return String(value)
}

function scheduleFlush() {
  if (flushTimer !== undefined) return
  flushTimer = window.setTimeout(() => {
    flushTimer = undefined
    void flushLocalDebugLogs()
  }, FLUSH_DELAY_MS)
}

function enqueue(event: Omit<BrowserDebugEvent, 'timestamp' | 'url'>) {
  if (!import.meta.env.DEV) return
  queue.push({
    ...event,
    timestamp: new Date().toISOString(),
    url: safePageUrl(),
  })
  if (queue.length > MAX_QUEUE_SIZE) queue = queue.slice(-MAX_QUEUE_SIZE)
  scheduleFlush()
}

async function flushLocalDebugLogs() {
  if (!originalFetch || queue.length === 0) return
  const events = queue.splice(0, 50)

  try {
    const response = await originalFetch(LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
      keepalive: true,
    })
    if (!response.ok && response.status >= 500) queue = [...events, ...queue].slice(0, MAX_QUEUE_SIZE)
  } catch {
    queue = [...events, ...queue].slice(0, MAX_QUEUE_SIZE)
  }
}

export function localDebugLog(message: string, context?: unknown, level: BrowserDebugLevel = 'debug') {
  enqueue({ level, message, context: toLogValue(context) })
}

export function installLocalDebugLogging() {
  if (!import.meta.env.DEV || window.__nltLocalDebugInstalled) return
  window.__nltLocalDebugInstalled = true

  const nativeFetch = window.fetch.bind(window)
  originalFetch = nativeFetch

  const nativeWarn = console.warn.bind(console)
  const nativeError = console.error.bind(console)

  console.warn = (...args: unknown[]) => {
    nativeWarn(...args)
    enqueue({ level: 'warn', message: 'console.warn', context: args.map((arg) => toLogValue(arg)) })
  }

  console.error = (...args: unknown[]) => {
    nativeError(...args)
    enqueue({ level: 'error', message: 'console.error', context: args.map((arg) => toLogValue(arg)) })
  }

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const pathname = safeRequestUrl(rawUrl)
    const isLogRequest = new URL(rawUrl, window.location.origin).pathname === LOG_ENDPOINT
    const startedAt = performance.now()

    try {
      const response = await nativeFetch(input, init)
      if (!isLogRequest && !response.ok) {
        enqueue({
          level: response.status >= 500 ? 'error' : 'warn',
          message: 'fetch.response',
          context: {
            method,
            url: pathname,
            status: response.status,
            durationMs: Math.round(performance.now() - startedAt),
          },
        })
      }
      return response
    } catch (error) {
      if (!isLogRequest) {
        enqueue({
          level: 'error',
          message: 'fetch.failed',
          context: {
            method,
            url: pathname,
            durationMs: Math.round(performance.now() - startedAt),
            error: toLogValue(error),
          },
        })
      }
      throw error
    }
  }

  window.addEventListener('error', (event) => {
    enqueue({
      level: 'error',
      message: 'window.error',
      stack: event.error instanceof Error ? event.error.stack : undefined,
      context: {
        message: event.message,
        filename: safeRequestUrl(event.filename),
        line: event.lineno,
        column: event.colno,
      },
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    enqueue({
      level: 'error',
      message: 'window.unhandledrejection',
      stack: event.reason instanceof Error ? event.reason.stack : undefined,
      context: { reason: toLogValue(event.reason) },
    })
  })

  window.addEventListener('pagehide', () => {
    if (queue.length === 0 || !navigator.sendBeacon) return
    const events = queue.splice(0, 50)
    navigator.sendBeacon(
      LOG_ENDPOINT,
      new Blob([JSON.stringify({ events })], { type: 'application/json' }),
    )
  })

  enqueue({
    level: 'info',
    message: 'browser.session.started',
    context: { userAgent: navigator.userAgent },
  })
}
