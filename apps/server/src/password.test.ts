import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

const { hashPassword, verifyPassword } = await import('./password.ts')

describe('password hasher', () => {
  test('correct password verifies; wrong password does not', async () => {
    const password = 'correct-horse-battery'
    const hash = await hashPassword(password)
    assert.equal(await verifyPassword(password, hash), true)
    assert.equal(await verifyPassword('wrong-password', hash), false)
  })

  test('hash is not the plaintext and never equals the password string', async () => {
    const password = 'correct-horse-battery'
    const hash = await hashPassword(password)
    assert.equal(typeof hash, 'string')
    assert.ok(hash.length > 0)
    assert.notEqual(hash, password)
    assert.equal(hash.includes(password), false)
  })

  test('hashPassword rejects an empty password', async () => {
    await assert.rejects(() => hashPassword(''))
  })
})
