const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi
const sensitiveQueryPattern = /([?&][^=&\s]*(?:password|passcode|token|secret|api[-_]?key)[^=&\s]*=)[^&#\s]*/gi
const sensitiveAssignmentPattern = /((?:password|passcode|token|authorization|cookie|secret|api[-_]?key|session|credential)\s*["']?\s*[:=]\s*["']?)[^"',&\s}]*/gi

export function redactLogLine(value) {
  return value
    .replace(bearerPattern, 'Bearer [REDACTED]')
    .replace(sensitiveQueryPattern, '$1[REDACTED]')
    .replace(sensitiveAssignmentPattern, '$1[REDACTED]')
    .replace(emailPattern, '[REDACTED_EMAIL]')
}
