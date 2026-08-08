import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeForLocalDebug } from './local-debug-log'

test('local debug logs redact sensitive fields and personal data', () => {
  const sanitized = sanitizeForLocalDebug({
    password: 'plain-text-password',
    nested: {
      playerEmail: 'person@example.com',
      message: 'Contact person@example.com with Bearer abc.def.ghi',
      url: 'http://localhost/reset?token=secret-value&next=/game',
    },
  })

  assert.deepEqual(sanitized, {
    password: '[REDACTED]',
    nested: {
      playerEmail: '[REDACTED]',
      message: 'Contact [REDACTED_EMAIL] with Bearer [REDACTED]',
      url: 'http://localhost/reset?token=[REDACTED]&next=/game',
    },
  })
})
