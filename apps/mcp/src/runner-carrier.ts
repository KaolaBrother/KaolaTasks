import { isAbsolute } from 'node:path'

// ---------------------------------------------------------------------------------------
// Issue #34 -- explicit Kaola Project Runner carrier compatibility.
//
// A pure module: no I/O, no process spawning, no network. It only interprets the caller's
// local environment (never an MCP tool parameter -- explicit Runner intent is local-only) and
// produces plain data for main.ts to act on. It binds to the pinned Runner measurement recorded
// for Issue #34 (kaola-project-runner @ commit fa19c63d), not to whatever the external repo
// exposes later.
// ---------------------------------------------------------------------------------------

/** The pinned Runner snapshot identity. The Runner carries no semver and no tag, so the commit
 * hash IS the version. */
export const RUNNER_SNAPSHOT_COMMIT = 'fa19c63d'

/** The pinned runtime-variant fixture table (scripts/kaola-tmux.sh:51 in the snapshot).
 * Acceptance binds to this recorded list, not to whatever the external repo exposes later. */
export const RUNNER_VARIANTS: ReadonlyArray<{ id: string; binary: string }> = [
  { id: 'grok', binary: 'grok' },
  { id: 'claude-code', binary: 'claude' },
  { id: 'opencode', binary: 'opencode' },
  { id: 'kimi-cli', binary: 'kimi' },
  { id: 'cursor-cli', binary: 'cursor-agent' },
]

const RUNNER_IDS = new Set(RUNNER_VARIANTS.map((v) => v.id))

export type CarrierIntent =
  | { carrier: 'direct' }
  | { carrier: 'runner'; runner: string; repo: string; session: string }
  | { carrier: 'advisory'; observation: string }

/**
 * Reads ONLY KAOLA_CARRIER / KAOLA_RUNNER / KAOLA_RUNNER_SESSION / KAOLA_RUNNER_REPO from the
 * given env map. Never throws and never silently falls back to 'direct' for a case that should
 * be advisory -- an unrecognized carrier value, an unknown/missing runner id, a missing/empty
 * session, or a missing/non-absolute repo are all reported as a legible advisory observation
 * instead.
 *
 * The absolute-path check on KAOLA_RUNNER_REPO is a syntactic precondition only: confirming the
 * path is an *existing git top-level* would require filesystem I/O, which this module's pure
 * contract explicitly excludes.
 */
export function resolveCarrierIntent(env: Record<string, string | undefined>): CarrierIntent {
  const carrier = typeof env.KAOLA_CARRIER === 'string' ? env.KAOLA_CARRIER : ''

  if (carrier.length === 0 || carrier === 'direct') return { carrier: 'direct' }

  if (carrier !== 'runner') {
    return {
      carrier: 'advisory',
      observation: `unrecognized KAOLA_CARRIER value "${carrier}" (expected "direct" or "runner")`,
    }
  }

  const runner = typeof env.KAOLA_RUNNER === 'string' ? env.KAOLA_RUNNER : ''
  if (runner.length === 0 || !RUNNER_IDS.has(runner)) {
    return {
      carrier: 'advisory',
      observation:
        `unknown or missing KAOLA_RUNNER "${runner}" (expected one of: ${[...RUNNER_IDS].join(', ')})`,
    }
  }

  const session = typeof env.KAOLA_RUNNER_SESSION === 'string' ? env.KAOLA_RUNNER_SESSION : ''
  if (session.length === 0) {
    return {
      carrier: 'advisory',
      observation: 'missing or empty KAOLA_RUNNER_SESSION for an explicit runner carrier selection',
    }
  }

  const repo = typeof env.KAOLA_RUNNER_REPO === 'string' ? env.KAOLA_RUNNER_REPO : ''
  if (repo.length === 0 || !isAbsolute(repo)) {
    return {
      carrier: 'advisory',
      observation:
        `KAOLA_RUNNER_REPO must be an absolute path to the pre-existing git top-level (got ${JSON.stringify(repo)})`,
    }
  }

  return { carrier: 'runner', runner, repo, session }
}

/**
 * Serializes (repo, session) into the single string persisted verbatim into the Claim
 * receipt's existing `runner_session` field (frozen by Issue #32 as a single `string | null`).
 * Throws when `repo` is not absolute or `session` is empty. The encoding is a JSON object --
 * unconstrained beyond "throws on invalid input, round-trips" per the test author's resolved
 * ambiguity D -- so a session name containing delimiter-hostile characters still round-trips.
 */
export function runnerSessionLocator(repo: string, session: string): string {
  if (typeof repo !== 'string' || !isAbsolute(repo)) {
    throw new TypeError('runnerSessionLocator: repo must be an absolute path')
  }
  if (typeof session !== 'string' || session.length === 0) {
    throw new TypeError('runnerSessionLocator: session must be a non-empty string')
  }
  return JSON.stringify({ repo, session })
}

/**
 * Defensive counterpart to runnerSessionLocator: never throws. Returns null for
 * null/undefined/non-JSON/garbage/incomplete input; otherwise the exact { repo, session } that
 * produced the string. Lets a fresh bridge process reading only the receipt recover the same
 * locator without starting anything.
 */
export function parseRunnerSessionLocator(
  value: string | null | undefined,
): { repo: string; session: string } | null {
  if (typeof value !== 'string' || value.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const repo = (parsed as Record<string, unknown>).repo
  const session = (parsed as Record<string, unknown>).session
  if (typeof repo !== 'string' || typeof session !== 'string') return null
  return { repo, session }
}

/** The exact forwarding pattern the pinned Runner's own `start` command uses
 * (scripts/kaola-tmux.sh:403: CLAUDE_*|GROK_*|OPENCODE_*|KIMI_*|CURSOR_*|FAKE_*). */
const FORWARD_PATTERN = /^(CLAUDE_|GROK_|OPENCODE_|KIMI_|CURSOR_|FAKE_)/

/**
 * Pure, read-only projection of `env` onto the keys a Runner `start` invocation would forward.
 * Never mutates `env`. This lets the bridge (and the acceptance suite) reason about what would
 * be forwarded without this module itself ever spawning anything.
 */
export function runnerForwardedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(env)) {
    if (!FORWARD_PATTERN.test(key)) continue
    const value = env[key]
    if (typeof value !== 'string') continue
    out[key] = value
  }
  return out
}
