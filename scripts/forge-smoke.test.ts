import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveSmokeListenHost,
  waitForForgeHead,
  waitForUatFlag,
} from './forge-smoke.ts'

const DUMMY_SPEC = {
  kind: 'gitlab' as const,
  tokenEnv: 'GITLAB_TOKEN' as const,
  baseUrl: 'https://gitlab.example.invalid',
  fullName: 'acme/app',
  issueWebUrl: (n: number) => `https://gitlab.example.invalid/acme/app/-/issues/${n}`,
  prWebUrl: (n: number) => `https://gitlab.example.invalid/acme/app/-/merge_requests/${n}`,
}

const savedHoldTimeout = process.env.UAT_HOLD_TIMEOUT_MS

afterEach(() => {
  if (savedHoldTimeout === undefined) delete process.env.UAT_HOLD_TIMEOUT_MS
  else process.env.UAT_HOLD_TIMEOUT_MS = savedHoldTimeout
})

function holdDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-uat-flag-'))
  mkdirSync(dir, { recursive: true })
  return dir
}

function abortTimeoutError(): Error {
  const err = new Error('The operation was aborted due to timeout')
  err.name = 'TimeoutError'
  return err
}

describe('waitForUatFlag (issue #56 Path C hold)', () => {
  it('missing go waits until the hold timeout; fail mentions waiting, not an unexpected flag', async () => {
    process.env.UAT_HOLD_TIMEOUT_MS = '700'
    const dir = holdDir()
    try {
      const started = Date.now()
      await assert.rejects(
        () => waitForUatFlag(dir, 'round-done', []),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /timed out waiting/)
          assert.doesNotMatch(err.message, /unexpected UAT flag/)
          return true
        },
      )
      assert.ok(
        Date.now() - started >= 600,
        'a missing flag must wait out the hold timeout rather than reject immediately',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('empty go waits the same as missing', async () => {
    process.env.UAT_HOLD_TIMEOUT_MS = '700'
    const dir = holdDir()
    writeFileSync(join(dir, 'go'), '')
    try {
      await assert.rejects(
        () => waitForUatFlag(dir, 'round-done', []),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /timed out waiting/)
          assert.doesNotMatch(err.message, /unexpected UAT flag/)
          return true
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('whitespace-only go waits the same as missing', async () => {
    process.env.UAT_HOLD_TIMEOUT_MS = '700'
    const dir = holdDir()
    writeFileSync(join(dir, 'go'), '  \n\t  \n')
    try {
      await assert.rejects(
        () => waitForUatFlag(dir, 'approved', []),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /timed out waiting/)
          assert.doesNotMatch(err.message, /unexpected UAT flag/)
          return true
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('non-empty unexpected go rejects immediately with redacted actual and expected', async () => {
    const holdMs = 2_000
    process.env.UAT_HOLD_TIMEOUT_MS = String(holdMs)
    const dir = holdDir()
    writeFileSync(join(dir, 'go'), 'nope')
    try {
      const started = Date.now()
      await assert.rejects(
        () => waitForUatFlag(dir, 'round-done', []),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /unexpected UAT flag/)
          assert.ok(err.message.includes(JSON.stringify('nope')))
          assert.match(err.message, /want round-done/)
          assert.doesNotMatch(err.message, /timed out waiting/)
          return true
        },
      )
      const elapsed = Date.now() - started
      assert.ok(
        elapsed < 400,
        `wrong non-empty content must fail immediately, well under the ${holdMs}ms hold timeout; elapsed ${elapsed}ms`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unexpected go never includes the passed secret in the rejection message', async () => {
    process.env.UAT_HOLD_TIMEOUT_MS = '2000'
    const dir = holdDir()
    const secret = 'glpat-super-secret-pat-value'
    writeFileSync(join(dir, 'go'), `wrong-${secret}`)
    try {
      const started = Date.now()
      await assert.rejects(
        () => waitForUatFlag(dir, 'round-done', [secret]),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /unexpected UAT flag/)
          assert.ok(err.message.includes(JSON.stringify('wrong-***')))
          assert.equal(err.message.includes(secret), false)
          return true
        },
      )
      const elapsed = Date.now() - started
      assert.ok(elapsed < 400, `secret-bearing wrong flag must reject immediately; elapsed ${elapsed}ms`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exact expected after trim resolves and unlinks go', async () => {
    process.env.UAT_HOLD_TIMEOUT_MS = '2000'
    const dir = holdDir()
    const flag = join(dir, 'go')
    writeFileSync(flag, '  round-done\n')
    try {
      await waitForUatFlag(dir, 'round-done', [])
      assert.equal(existsSync(flag), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveSmokeListenHost (issue #57)', () => {
  it('Path B (web=false) is always 127.0.0.1 even when UAT_WEB_HOST is 0.0.0.0', () => {
    assert.equal(resolveSmokeListenHost(false, { UAT_WEB_HOST: '0.0.0.0' }), '127.0.0.1')
    assert.equal(resolveSmokeListenHost(false, { UAT_WEB_HOST: '10.0.0.8' }), '127.0.0.1')
    assert.equal(resolveSmokeListenHost(false, {}), '127.0.0.1')
  })

  it('Path C default listen is 127.0.0.1 when UAT_WEB_HOST is unset', () => {
    assert.equal(resolveSmokeListenHost(true, {}), '127.0.0.1')
  })

  it('Path C default listen is 127.0.0.1 when UAT_WEB_HOST is empty', () => {
    assert.equal(resolveSmokeListenHost(true, { UAT_WEB_HOST: '' }), '127.0.0.1')
  })

  it('Path C honors UAT_WEB_HOST=0.0.0.0 when set', () => {
    assert.equal(resolveSmokeListenHost(true, { UAT_WEB_HOST: '0.0.0.0' }), '0.0.0.0')
  })

  it('Path C honors another explicit UAT_WEB_HOST', () => {
    assert.equal(resolveSmokeListenHost(true, { UAT_WEB_HOST: '10.1.2.3' }), '10.1.2.3')
  })
})

describe('waitForForgeHead (issue #58 continue-poll)', () => {
  it('one injected getPullRequest TimeoutError then a matching sha still resolves', async () => {
    const expected = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    let calls = 0
    await waitForForgeHead('gitlab', DUMMY_SPEC, 'tok', 'https://gitlab.example.invalid/acme/app/-/merge_requests/1', expected, {
      deadlineMs: 2_000,
      pollDelayMs: 0,
      getPullRequest: async () => {
        calls += 1
        if (calls === 1) throw abortTimeoutError()
        return { head_sha: expected }
      },
    })
    assert.ok(calls >= 2, `waiter must continue after the first timeout; calls=${calls}`)
  })

  it('one injected abort-timeout via getHead then a matching sha still resolves', async () => {
    const expected = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    let calls = 0
    await waitForForgeHead('gitlab', DUMMY_SPEC, 'tok', 'https://gitlab.example.invalid/acme/app/-/merge_requests/1', expected, {
      deadlineMs: 2_000,
      pollDelayMs: 0,
      getHead: async () => {
        calls += 1
        if (calls === 1) {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        }
        return expected
      },
    })
    assert.ok(calls >= 2, `waiter must continue after the first abort timeout; calls=${calls}`)
  })

  it('injected sha mismatch then match still resolves (issue #54)', async () => {
    const expected = 'cccccccccccccccccccccccccccccccccccccccc'
    let calls = 0
    await waitForForgeHead('gitlab', DUMMY_SPEC, 'tok', 'https://gitlab.example.invalid/acme/app/-/merge_requests/1', expected, {
      deadlineMs: 2_000,
      pollDelayMs: 0,
      getPullRequest: async () => {
        calls += 1
        if (calls === 1) return { head_sha: 'dddddddddddddddddddddddddddddddddddddddd' }
        return { head_sha: expected }
      },
    })
    assert.equal(calls, 2)
  })
})
