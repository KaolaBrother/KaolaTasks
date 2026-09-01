import { X509Certificate, createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Issue #48 — local (MCP process-level) root-CA trust core.
 *
 * Fail-closed fingerprint verification, install into `$KAOLA_HOME/trust/`, status,
 * uninstall, and export of `NODE_EXTRA_CA_CERTS` for the local `kaola-mcp` bridge only.
 * This module never fetches a CA from an origin (no TOFU), never writes system trust
 * stores, and never executes elevation commands.
 */

export const TRUST_DIR_NAME = 'trust'
export const TRUST_ROOT_CA_FILE = 'root-ca.pem'

const CERT_BEGIN = '-----BEGIN CERTIFICATE-----'
const CERT_END = '-----END CERTIFICATE-----'
const PRIVATE_KEY_MARKER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/

export type TrustVerifyCode =
  | 'empty_pem'
  | 'private_key_present'
  | 'certificate_count'
  | 'unparseable'
  | 'not_a_ca'
  | 'fingerprint_mismatch'

export type TrustVerifyOk = {
  ok: true
  fingerprintSha256: string
  pem: string
  subject: string
}

export type TrustVerifyErr = {
  ok: false
  code: TrustVerifyCode
  message: string
}

export type TrustInstallOk = {
  ok: true
  pemPath: string
  fingerprintSha256: string
  nodeExtraCaCerts: string
}

export type TrustInstallErr = {
  ok: false
  code: TrustVerifyCode | 'source_unreadable'
  message: string
}

export type TrustStatus =
  | {
      installed: false
      pemPath: string
      ready: false
    }
  | {
      installed: true
      pemPath: string
      fingerprintSha256: string | null
      ready: boolean
      code?: TrustVerifyCode | 'unreadable'
      message?: string
    }

export type TrustUninstallResult = {
  removed: boolean
  pemPath: string
}

export type McpTrustEnv = {
  NODE_EXTRA_CA_CERTS: string
}

export type SystemTrustPlatform = 'darwin' | 'win32' | 'linux-debian' | 'linux-fedora'

export type SystemTrustPlan = {
  platform: SystemTrustPlatform
  requiresElevation: true
  /** Operator-run commands only. This module never executes them. */
  commands: readonly string[]
  note: string
}

/** Resolve `$KAOLA_HOME`, matching the stdio bridge (`KAOLA_HOME` or `~/.kaola`). */
export function resolveKaolaHome(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
  const override = env.KAOLA_HOME
  if (typeof override === 'string' && override.length > 0) return override
  return join(homedir(), '.kaola')
}

export function trustDir(kaolaHome: string): string {
  return join(kaolaHome, TRUST_DIR_NAME)
}

export function trustRootCaPath(kaolaHome: string): string {
  return join(trustDir(kaolaHome), TRUST_ROOT_CA_FILE)
}

/** Strip colons/spaces; lowercase. Empty input stays empty. */
export function normalizeFingerprintSha256(value: string): string {
  return String(value).replace(/[:\s]/g, '').toLowerCase()
}

/**
 * SHA-256 fingerprint of the certificate DER, hex lowercase without colons —
 * comparable to `openssl x509 -fingerprint -sha256` after stripping separators.
 */
export function certificateSha256Fingerprint(pemOrCert: string | Buffer | X509Certificate): string {
  const cert = pemOrCert instanceof X509Certificate ? pemOrCert : new X509Certificate(pemOrCert)
  return normalizeFingerprintSha256(cert.fingerprint256)
}

/**
 * Fail-closed verification of a public root CA PEM against an out-of-band SHA-256 fingerprint.
 * Rejects private-key material, anything other than exactly one CERTIFICATE block, unparseable
 * PEM, non-CA certificates, and fingerprint mismatch.
 */
export function verifyRootCaPem(pemText: string, expectedFingerprint: string): TrustVerifyOk | TrustVerifyErr {
  const raw = typeof pemText === 'string' ? pemText : ''
  if (raw.trim().length === 0) {
    return { ok: false, code: 'empty_pem', message: 'PEM is empty' }
  }
  if (PRIVATE_KEY_MARKER.test(raw)) {
    return {
      ok: false,
      code: 'private_key_present',
      message: 'PEM contains private key material; root private keys must never be distributed to clients',
    }
  }

  const beginCount = countOccurrences(raw, CERT_BEGIN)
  const endCount = countOccurrences(raw, CERT_END)
  if (beginCount !== 1 || endCount !== 1) {
    return {
      ok: false,
      code: 'certificate_count',
      message: `PEM must contain exactly one CERTIFICATE block (found begin=${beginCount} end=${endCount})`,
    }
  }

  let cert: X509Certificate
  try {
    cert = new X509Certificate(raw)
  } catch {
    return { ok: false, code: 'unparseable', message: 'PEM could not be parsed as an X.509 certificate' }
  }

  if (!cert.ca) {
    return {
      ok: false,
      code: 'not_a_ca',
      message: 'certificate is not a CA (basicConstraints CA must be true)',
    }
  }

  const fingerprintSha256 = certificateSha256Fingerprint(cert)
  const expected = normalizeFingerprintSha256(expectedFingerprint)
  if (expected.length === 0 || fingerprintSha256 !== expected) {
    return {
      ok: false,
      code: 'fingerprint_mismatch',
      message: 'certificate SHA-256 fingerprint does not match the out-of-band expected value',
    }
  }

  const begin = raw.indexOf(CERT_BEGIN)
  const end = raw.indexOf(CERT_END)
  const pem = `${raw.slice(begin, end + CERT_END.length)}\n`

  return {
    ok: true,
    fingerprintSha256,
    pem,
    subject: cert.subject,
  }
}

/**
 * Verify `sourcePemPath`, then atomically install the public root CA into
 * `$KAOLA_HOME/trust/root-ca.pem` (0700 dir / 0600 file). Does not set process env and does
 * not touch system trust stores. On success, `nodeExtraCaCerts` is the absolute path callers
 * may put in the local MCP bridge `NODE_EXTRA_CA_CERTS` (DEBUG_PRIVATE_CA only).
 */
export function installRootCa(options: {
  kaolaHome: string
  sourcePemPath: string
  expectedFingerprint: string
}): TrustInstallOk | TrustInstallErr {
  const kaolaHome = resolve(options.kaolaHome)
  const sourcePemPath = resolve(options.sourcePemPath)
  let sourceText: string
  try {
    sourceText = readFileSync(sourcePemPath, 'utf8')
  } catch {
    return {
      ok: false,
      code: 'source_unreadable',
      message: `cannot read source PEM at ${sourcePemPath}`,
    }
  }

  const verified = verifyRootCaPem(sourceText, options.expectedFingerprint)
  if (!verified.ok) return verified

  const pemPath = trustRootCaPath(kaolaHome)
  ensureDirSecure(dirname(pemPath))
  writeFileAtomic(pemPath, verified.pem)

  return {
    ok: true,
    pemPath,
    fingerprintSha256: verified.fingerprintSha256,
    nodeExtraCaCerts: pemPath,
  }
}

/**
 * Report whether a local root CA is installed under `$KAOLA_HOME/trust/`.
 * When `expectedFingerprint` is provided, `ready` is true only if the on-disk PEM still
 * verifies against it (fail closed if the file was replaced). Without an expected fingerprint,
 * `ready` is true only when the file is a single public CA certificate with no private key.
 */
export function statusRootCa(options: {
  kaolaHome: string
  expectedFingerprint?: string
}): TrustStatus {
  const pemPath = trustRootCaPath(resolve(options.kaolaHome))
  if (!existsSync(pemPath)) {
    return { installed: false, pemPath, ready: false }
  }

  let text: string
  try {
    text = readFileSync(pemPath, 'utf8')
  } catch {
    return {
      installed: true,
      pemPath,
      fingerprintSha256: null,
      ready: false,
      code: 'unreadable',
      message: 'installed trust PEM exists but cannot be read',
    }
  }

  const expected =
    typeof options.expectedFingerprint === 'string' && options.expectedFingerprint.length > 0
      ? options.expectedFingerprint
      : null

  if (expected != null) {
    const verified = verifyRootCaPem(text, expected)
    if (!verified.ok) {
      return {
        installed: true,
        pemPath,
        fingerprintSha256: tryFingerprint(text),
        ready: false,
        code: verified.code,
        message: verified.message,
      }
    }
    return {
      installed: true,
      pemPath,
      fingerprintSha256: verified.fingerprintSha256,
      ready: true,
    }
  }

  // No expected fingerprint: still reject private keys / non-CA / multi-cert, but do not
  // invent a TOFU success path for callers that later skip fingerprint checks.
  const structural = verifyRootCaStructure(text)
  if (!structural.ok) {
    return {
      installed: true,
      pemPath,
      fingerprintSha256: tryFingerprint(text),
      ready: false,
      code: structural.code,
      message: structural.message,
    }
  }
  return {
    installed: true,
    pemPath,
    fingerprintSha256: structural.fingerprintSha256,
    ready: true,
  }
}

/**
 * Remove `$KAOLA_HOME/trust/root-ca.pem` (and the empty `trust/` directory when possible).
 * Never deletes `device.json`, Claim receipts, or other KAOLA_HOME contents.
 */
export function uninstallRootCa(options: { kaolaHome: string }): TrustUninstallResult {
  const pemPath = trustRootCaPath(resolve(options.kaolaHome))
  let removed = false
  if (existsSync(pemPath)) {
    unlinkSync(pemPath)
    removed = true
  }
  const dir = trustDir(resolve(options.kaolaHome))
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: false, force: false })
    } catch {
      // Non-empty or busy — leave the directory; PEM removal is what matters.
    }
  }
  return { removed, pemPath }
}

/**
 * Export process-level MCP trust env for DEBUG_PRIVATE_CA. Returns `null` unless the installed
 * PEM is ready (and matches `expectedFingerprint` when provided). Never returns an env that
 * would disable TLS verification. Does not mutate `process.env`.
 */
export function exportMcpTrustEnv(options: {
  kaolaHome: string
  expectedFingerprint?: string
}): McpTrustEnv | null {
  const status = statusRootCa(options)
  if (!status.installed || !status.ready) return null
  return { NODE_EXTRA_CA_CERTS: status.pemPath }
}

/**
 * Fail-closed read of a process-level extra CA file (the path typically placed in
 * `NODE_EXTRA_CA_CERTS`). Used by the stdio bridge: Node only loads that env var at
 * process start, so an in-process `env` argument must still be a single public CA
 * cert with no private key or the HTTPS connection is refused.
 */
export function readVerifiedExtraCaPem(pemPath: string): TrustVerifyOk | TrustVerifyErr | { ok: false; code: 'unreadable'; message: string } {
  const resolved = resolve(pemPath)
  let text: string
  try {
    text = readFileSync(resolved, 'utf8')
  } catch {
    return {
      ok: false,
      code: 'unreadable',
      message: `cannot read extra CA PEM at ${resolved}`,
    }
  }
  return verifyRootCaStructure(text)
}

/**
 * Describe explicit system/browser trust elevation for operators. Never executes commands and
 * never claims silent install succeeded — macOS/Windows/Linux elevation stays a separate,
 * human-authorized step from MCP process-level trust.
 */
export function systemTrustElevationPlan(
  platform: SystemTrustPlatform,
  pemPath: string,
): SystemTrustPlan {
  const path = resolve(pemPath)
  switch (platform) {
    case 'darwin':
      return {
        platform,
        requiresElevation: true,
        commands: [`security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${shellSingleQuote(path)}`],
        note: 'Requires macOS administrator authentication. NODE_EXTRA_CA_CERTS is not browser trust.',
      }
    case 'win32':
      return {
        platform,
        requiresElevation: true,
        commands: [`certutil -addstore Root ${shellSingleQuote(path)}`],
        note: 'Requires Windows UAC elevation. NODE_EXTRA_CA_CERTS is not browser trust.',
      }
    case 'linux-debian':
      return {
        platform,
        requiresElevation: true,
        commands: [
          `sudo cp ${shellSingleQuote(path)} /usr/local/share/ca-certificates/kaola-dev-root.crt`,
          'sudo update-ca-certificates',
        ],
        note: 'Debian/Ubuntu path. Do not mix with Fedora/RHEL trust anchor commands. Requires root. NODE_EXTRA_CA_CERTS is not browser trust.',
      }
    case 'linux-fedora':
      return {
        platform,
        requiresElevation: true,
        commands: [`sudo trust anchor ${shellSingleQuote(path)}`],
        note: 'Fedora/RHEL path. Do not mix with Debian update-ca-certificates. Requires root. NODE_EXTRA_CA_CERTS is not browser trust.',
      }
  }
}

function verifyRootCaStructure(pemText: string): TrustVerifyOk | TrustVerifyErr {
  // Use a sentinel fingerprint derived from the cert itself so structural checks reuse the
  // same private-key / single-CERT / CA gates without a separate parser path.
  if (pemText.trim().length === 0) {
    return { ok: false, code: 'empty_pem', message: 'PEM is empty' }
  }
  if (PRIVATE_KEY_MARKER.test(pemText)) {
    return {
      ok: false,
      code: 'private_key_present',
      message: 'PEM contains private key material; root private keys must never be distributed to clients',
    }
  }
  const beginCount = countOccurrences(pemText, CERT_BEGIN)
  const endCount = countOccurrences(pemText, CERT_END)
  if (beginCount !== 1 || endCount !== 1) {
    return {
      ok: false,
      code: 'certificate_count',
      message: `PEM must contain exactly one CERTIFICATE block (found begin=${beginCount} end=${endCount})`,
    }
  }
  let cert: X509Certificate
  try {
    cert = new X509Certificate(pemText)
  } catch {
    return { ok: false, code: 'unparseable', message: 'PEM could not be parsed as an X.509 certificate' }
  }
  if (!cert.ca) {
    return {
      ok: false,
      code: 'not_a_ca',
      message: 'certificate is not a CA (basicConstraints CA must be true)',
    }
  }
  const fingerprintSha256 = certificateSha256Fingerprint(cert)
  const begin = pemText.indexOf(CERT_BEGIN)
  const end = pemText.indexOf(CERT_END)
  return {
    ok: true,
    fingerprintSha256,
    pem: `${pemText.slice(begin, end + CERT_END.length)}\n`,
    subject: cert.subject,
  }
}

function tryFingerprint(pemText: string): string | null {
  try {
    return certificateSha256Fingerprint(pemText)
  } catch {
    return null
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  while (from < haystack.length) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    count += 1
    from = idx + needle.length
  }
  return count
}

function ensureDirSecure(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

function writeFileAtomic(path: string, contents: string): void {
  const tmpPath = `${path}.tmp-${process.pid}-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8)}`
  writeFileSync(tmpPath, contents, { mode: 0o600, encoding: 'utf8' })
  chmodSync(tmpPath, 0o600)
  renameSync(tmpPath, path)
  chmodSync(path, 0o600)
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
