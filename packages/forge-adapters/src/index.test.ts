import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getForgeAdaptersHealth } from './index.ts'

test('getForgeAdaptersHealth returns the pinned non-empty forge-adapters package health string', () => {
  assert.equal(typeof getForgeAdaptersHealth, 'function')
  const value = getForgeAdaptersHealth()
  assert.equal(typeof value, 'string')
  assert.ok(value.length > 0)
  assert.equal(value, 'kaola-forge-adapters-ready')
})
