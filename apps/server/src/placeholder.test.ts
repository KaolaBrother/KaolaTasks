import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getPlaceholderBody } from './placeholder.ts'

// Fastify (and any other HTTP handler) must call getPlaceholderBody() and send
// its return value as the response body. Do not duplicate the string in the route.

test('getPlaceholderBody returns the pinned non-empty placeholder HTTP body', () => {
  assert.equal(typeof getPlaceholderBody, 'function')
  const body = getPlaceholderBody()
  assert.equal(typeof body, 'string')
  assert.ok(body.length > 0)
  assert.equal(body, '考拉任务服务占位')
})
