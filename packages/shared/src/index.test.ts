import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSharedHealth } from './index.ts'

test('getSharedHealth returns the pinned non-empty shared package health string', () => {
  assert.equal(typeof getSharedHealth, 'function')
  const value = getSharedHealth()
  assert.equal(typeof value, 'string')
  assert.ok(value.length > 0)
  assert.equal(value, 'kaola-shared-ready')
})
