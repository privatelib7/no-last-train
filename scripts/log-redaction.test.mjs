import assert from 'node:assert/strict'
import test from 'node:test'
import { redactLogLine } from './log-redaction.mjs'

test('process output redacts emails, URL tokens, assignments, and bearer tokens', () => {
  const line = [
    'mail for person@example.com',
    'http://localhost/?verifyToken=secret-value',
    'password=plain-text',
    'Authorization: Bearer abc.def.ghi',
  ].join(' | ')

  const redacted = redactLogLine(line)
  assert.equal(redacted.includes('person@example.com'), false)
  assert.equal(redacted.includes('secret-value'), false)
  assert.equal(redacted.includes('plain-text'), false)
  assert.equal(redacted.includes('abc.def.ghi'), false)
  assert.match(redacted, /\[REDACTED_EMAIL\]/)
  assert.match(redacted, /verifyToken=\[REDACTED\]/)
})
