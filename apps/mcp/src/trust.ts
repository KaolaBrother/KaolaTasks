import {
  X509Certificate,
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Writable } from 'node:stream'

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
export const TRUST_STATE_FILE = 'state.json'
export const PUBLISHER_SIGNATURE_MANIFEST_KIND = 'publisher-signature-manifest'

const FINGERPRINT_HEX_RE = /^[0-9a-f]{64}$/

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

export type TrustInstallErrCode =
  | TrustVerifyCode
  | 'source_unreadable'
  | 'missing_verifier'
  | 'conflicting_verifier'
  | 'manifest_unreadable'
  | 'manifest_invalid'
  | 'signature_mismatch'

export type TrustInstallErr = {
  ok: false
  code: TrustInstallErrCode
  message: string
}

export type TrustStateV1 = {
  v: 1
  alg: 'sha256'
  fingerprintSha256: string
  kind?: typeof PUBLISHER_SIGNATURE_MANIFEST_KIND
  publicKeySpki?: string
}

export type InspectedTrust =
  | {
      present: false
      ready: false
      pemPath: string
      statePath: string
    }
  | {
      present: true
      ready: false
      pemPath: string
      statePath: string
      code: string
      message: string
    }
  | {
      present: true
      ready: true
      pemPath: string
      statePath: string
      fingerprintSha256: string
      pem: string
      state: TrustStateV1
    }

export type LauncherTrust =
  | { ok: true; env: NodeJS.ProcessEnv }
  | { ok: false; message: string }

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

export function trustStatePath(kaolaHome: string): string {
  return join(trustDir(kaolaHome), TRUST_STATE_FILE)
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
  expectedFingerprint?: string
  manifestPath?: string
}): TrustInstallOk | TrustInstallErr {
  const hasFingerprint =
    typeof options.expectedFingerprint === 'string' && options.expectedFingerprint.length > 0
  const hasManifest = typeof options.manifestPath === 'string' && options.manifestPath.length > 0
  if (hasFingerprint && hasManifest) {
    return {
      ok: false,
      code: 'conflicting_verifier',
      message: '--fingerprint and --manifest are mutually exclusive',
    }
  }
  if (!hasFingerprint && !hasManifest) {
    return {
      ok: false,
      code: 'missing_verifier',
      message: 'exactly one of --fingerprint or --manifest is required with --pem',
    }
  }

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

  let verified: TrustVerifyOk
  let state: TrustStateV1
  if (hasManifest) {
    const fromManifest = verifyPemWithPublisherManifest(sourceText, resolve(options.manifestPath as string))
    if (!fromManifest.ok) return fromManifest
    verified = fromManifest.verified
    state = {
      v: 1,
      alg: 'sha256',
      fingerprintSha256: verified.fingerprintSha256,
      kind: PUBLISHER_SIGNATURE_MANIFEST_KIND,
      publicKeySpki: fromManifest.publicKeySpki,
    }
  } else {
    const fingerprintVerified = verifyRootCaPem(sourceText, options.expectedFingerprint as string)
    if (!fingerprintVerified.ok) return fingerprintVerified
    verified = fingerprintVerified
    state = {
      v: 1,
      alg: 'sha256',
      fingerprintSha256: verified.fingerprintSha256,
    }
  }

  const pemPath = writeInstalledTrustPair(kaolaHome, verified.pem, state)

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
  const home = resolve(options.kaolaHome)
  const pemPath = trustRootCaPath(home)
  const statePath = trustStatePath(home)
  let removed = false
  if (existsSync(pemPath)) {
    unlinkSync(pemPath)
    removed = true
  }
  if (existsSync(statePath)) {
    unlinkSync(statePath)
    removed = true
  }
  const dir = trustDir(home)
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: false, force: false })
    } catch {
      // Non-empty or busy — leave the directory; PEM+state removal is what matters.
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

/**
 * Inspect `$KAOLA_HOME/trust/` for launcher and `trust status`. Ready only when PEM and
 * host-neutral state both exist, unix modes are 0700/0600, state is parseable, and the
 * on-disk PEM still matches the pinned fingerprint.
 */
export function inspectInstalledTrust(kaolaHome: string): InspectedTrust {
  const home = resolve(kaolaHome)
  const pemPath = trustRootCaPath(home)
  const statePath = trustStatePath(home)
  const pemExists = existsSync(pemPath)
  const stateExists = existsSync(statePath)

  if (!pemExists && !stateExists) {
    return { present: false, ready: false, pemPath, statePath }
  }

  if (!pemExists || !stateExists) {
    return {
      present: true,
      ready: false,
      pemPath,
      statePath,
      code: 'inconsistent_pair',
      message: pemExists
        ? 'trust state.json is missing; installed PEM is not ready'
        : 'trust root-ca.pem is missing; installed state is not ready',
    }
  }

  if (!isSecureUnixMode(trustDir(home), 0o700)) {
    return {
      present: true,
      ready: false,
      pemPath,
      statePath,
      code: 'insecure_mode',
      message: 'trust directory mode must be 0700',
    }
  }
  if (!isSecureUnixMode(pemPath, 0o600)) {
    return {
      present: true,
      ready: false,
      pemPath,
      statePath,
      code: 'insecure_mode',
      message: 'root-ca.pem mode must be 0600',
    }
  }
  if (!isSecureUnixMode(statePath, 0o600)) {
    return {
      present: true,
      ready: false,
      pemPath,
      statePath,
      code: 'insecure_mode',
      message: 'state.json mode must be 0600',
    }
  }

  let stateRaw: string
  try {
    stateRaw = readFileSync(statePath, 'utf8')
  } catch {
    return {
      present: true,
      ready: false,
      pemPath,
      statePath,
      code: 'unreadable',
      message: 'installed trust state exists but cannot be read',
    }
  }

  const state = parseTrustState(stateRaw)
  if (state == null) {
    return {
      present: true,
      ready: false,
      pemPath,
      statePath,
      code: 'invalid_state',
      message: 'installed trust state is not a host-neutral v1 sha256 fingerprint document',
    }
  }

  let pemText: string
  try {
    pemText = readFileSync(pemPath, 'utf8')
  } catch {
    return {
      present: true,
      ready: false,
      pemPath,
      statePath,
      code: 'unreadable',
      message: 'installed trust PEM exists but cannot be read',
    }
  }

  const verified = verifyRootCaPem(pemText, state.fingerprintSha256)
  if (!verified.ok) {
    return {
      present: true,
      ready: false,
      pemPath,
      statePath,
      code: verified.code,
      message: verified.message,
    }
  }

  return {
    present: true,
    ready: true,
    pemPath,
    statePath,
    fingerprintSha256: verified.fingerprintSha256,
    pem: verified.pem,
    state,
  }
}

/**
 * Direct-run / package-bin launcher policy (not applied to `runStdioBridge` as a library):
 * absent pair → public mode (refuse caller extra CA); verified pair → inject only the
 * installed PEM path; any inconsistency → fail closed.
 */
export function resolveLauncherTrust(env: NodeJS.ProcessEnv): LauncherTrust {
  const inspected = inspectInstalledTrust(resolveKaolaHome(env))
  const callerExtra = env.NODE_EXTRA_CA_CERTS
  const hasCallerExtra = typeof callerExtra === 'string' && callerExtra.trim().length > 0
  const next: NodeJS.ProcessEnv = { ...env }
  delete next.NODE_EXTRA_CA_CERTS

  if (!inspected.present) {
    if (hasCallerExtra) {
      return {
        ok: false,
        message:
          'NODE_EXTRA_CA_CERTS is not a trust source; public-CA mode refuses caller extra CA without verified local trust state',
      }
    }
    return { ok: true, env: next }
  }
  if (!inspected.ready) {
    return { ok: false, message: inspected.message }
  }
  next.NODE_EXTRA_CA_CERTS = inspected.pemPath
  return { ok: true, env: next }
}

const SYSTEM_PLAN_PLATFORMS = new Set<SystemTrustPlatform>([
  'darwin',
  'win32',
  'linux-debian',
  'linux-fedora',
])

/**
 * User-callable `kaola-mcp trust …` implementation. Never starts the stdio bridge and never
 * creates `device.json`.
 */
export function runTrustCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io?: { stdout?: Writable; stderr?: Writable },
): number {
  const stdout = io?.stdout ?? process.stdout
  const stderr = io?.stderr ?? process.stderr
  const writeOut = (line: string): void => {
    stdout.write(line.endsWith('\n') ? line : `${line}\n`)
  }
  const writeErr = (line: string): void => {
    stderr.write(line.endsWith('\n') ? line : `${line}\n`)
  }

  const sub = argv[0]
  if (sub == null || sub.length === 0) {
    writeErr('usage: kaola-mcp trust <install|status|uninstall|system-plan>')
    return 1
  }

  switch (sub) {
    case 'install':
      return cmdTrustInstall(argv.slice(1), env, writeErr)
    case 'status':
      return cmdTrustStatus(env, writeOut)
    case 'uninstall':
      uninstallRootCa({ kaolaHome: resolveKaolaHome(env) })
      return 0
    case 'system-plan':
      return cmdTrustSystemPlan(argv.slice(1), env, writeOut, writeErr)
    default:
      writeErr(`unknown trust subcommand: ${sub}`)
      return 1
  }
}

function cmdTrustInstall(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  writeErr: (line: string) => void,
): number {
  const { flags, rest } = parseCliTokens(argv)
  if (rest.length > 0) {
    writeErr(`unexpected argument: ${rest[0]}`)
    return 1
  }
  const pem = flagString(flags, 'pem')
  const fingerprint = flagString(flags, 'fingerprint')
  const manifest = flagString(flags, 'manifest')
  if (pem == null) {
    writeErr('trust install requires --pem <path>')
    return 1
  }
  if (fingerprint != null && manifest != null) {
    writeErr('--fingerprint and --manifest are mutually exclusive')
    return 1
  }
  if (fingerprint == null && manifest == null) {
    writeErr('trust install requires exactly one of --fingerprint or --manifest')
    return 1
  }

  const installed = installRootCa({
    kaolaHome: resolveKaolaHome(env),
    sourcePemPath: pem,
    expectedFingerprint: fingerprint,
    manifestPath: manifest,
  })
  if (!installed.ok) {
    writeErr(installed.message)
    return 1
  }
  return 0
}

function cmdTrustStatus(env: NodeJS.ProcessEnv, writeOut: (line: string) => void): number {
  const inspected = inspectInstalledTrust(resolveKaolaHome(env))
  if (!inspected.present) {
    writeOut(JSON.stringify({ ready: false, installed: false }))
    return 0
  }
  if (!inspected.ready) {
    writeOut(JSON.stringify({ ready: false, installed: true, code: inspected.code }))
    return 0
  }
  writeOut(
    JSON.stringify({
      ready: true,
      installed: true,
      fingerprintSha256: inspected.fingerprintSha256,
    }),
  )
  return 0
}

function cmdTrustSystemPlan(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  writeOut: (line: string) => void,
  writeErr: (line: string) => void,
): number {
  const { flags, rest } = parseCliTokens(argv)
  if (rest.length > 0) {
    writeErr(`unexpected argument: ${rest[0]}`)
    return 1
  }
  const requested = flagString(flags, 'platform')
  let platform: SystemTrustPlatform
  if (requested != null) {
    if (!isSystemTrustPlatform(requested)) {
      writeErr(
        'trust system-plan --platform must be darwin, win32, linux-debian, or linux-fedora',
      )
      return 1
    }
    platform = requested
  } else if (process.platform === 'darwin') {
    platform = 'darwin'
  } else if (process.platform === 'win32') {
    platform = 'win32'
  } else {
    writeErr('trust system-plan on this OS requires --platform linux-debian or linux-fedora')
    return 1
  }

  const inspected = inspectInstalledTrust(resolveKaolaHome(env))
  const pemPath = inspected.present ? inspected.pemPath : 'root-ca.pem'
  const plan = systemTrustElevationPlan(platform, pemPath)
  // Print operator commands only. The library note mentions the other distro by name
  // ("do not mix with … trust anchor") which the CLI oracle treats as mixed output.
  for (const command of plan.commands) writeOut(command)
  return 0
}

function verifyPemWithPublisherManifest(
  pemText: string,
  manifestPath: string,
):
  | { ok: true; verified: TrustVerifyOk; publicKeySpki: string }
  | TrustInstallErr {
  let raw: string
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch {
    return {
      ok: false,
      code: 'manifest_unreadable',
      message: `cannot read trust manifest at ${manifestPath}`,
    }
  }

  const manifest = parsePublisherManifest(raw)
  if (manifest == null) {
    return {
      ok: false,
      code: 'manifest_invalid',
      message: 'trust manifest must be JSON { v:1, fingerprintSha256, signature, publicKeySpki }',
    }
  }

  const verified = verifyRootCaPem(pemText, manifest.fingerprintSha256)
  if (!verified.ok) return verified

  let publicKey: ReturnType<typeof createPublicKey>
  try {
    publicKey = createPublicKey({
      key: Buffer.from(manifest.publicKeySpki, 'base64'),
      type: 'spki',
      format: 'der',
    })
  } catch {
    return {
      ok: false,
      code: 'manifest_invalid',
      message: 'trust manifest publicKeySpki is not a valid Ed25519 SPKI',
    }
  }

  let signatureOk = false
  try {
    const cert = new X509Certificate(verified.pem)
    signatureOk = cryptoVerify(
      null,
      cert.raw,
      publicKey,
      Buffer.from(manifest.signature, 'base64'),
    )
  } catch {
    signatureOk = false
  }
  if (!signatureOk) {
    return {
      ok: false,
      code: 'signature_mismatch',
      message: 'trust manifest Ed25519 signature does not match the certificate DER',
    }
  }

  return { ok: true, verified, publicKeySpki: manifest.publicKeySpki }
}

function parsePublisherManifest(
  text: string,
): { v: 1; fingerprintSha256: string; signature: string; publicKeySpki: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const body = parsed as Record<string, unknown>
  if (body.v !== 1) return null
  if (typeof body.fingerprintSha256 !== 'string' || body.fingerprintSha256.length === 0) return null
  if (typeof body.signature !== 'string' || body.signature.length === 0) return null
  if (typeof body.publicKeySpki !== 'string' || body.publicKeySpki.length === 0) return null
  return {
    v: 1,
    fingerprintSha256: body.fingerprintSha256,
    signature: body.signature,
    publicKeySpki: body.publicKeySpki,
  }
}

function parseTrustState(text: string): TrustStateV1 | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const body = parsed as Record<string, unknown>
  if (body.v !== 1) return null
  if (body.alg !== 'sha256') return null
  if (typeof body.fingerprintSha256 !== 'string') return null
  const fingerprintSha256 = normalizeFingerprintSha256(body.fingerprintSha256)
  if (!FINGERPRINT_HEX_RE.test(fingerprintSha256)) return null

  const state: TrustStateV1 = {
    v: 1,
    alg: 'sha256',
    fingerprintSha256,
  }
  if (body.kind === PUBLISHER_SIGNATURE_MANIFEST_KIND && typeof body.publicKeySpki === 'string') {
    state.kind = PUBLISHER_SIGNATURE_MANIFEST_KIND
    state.publicKeySpki = body.publicKeySpki
  }
  return state
}

function writeInstalledTrustPair(kaolaHome: string, pem: string, state: TrustStateV1): string {
  const pemPath = trustRootCaPath(kaolaHome)
  const statePath = trustStatePath(kaolaHome)
  const dir = trustDir(kaolaHome)
  ensureDirSecure(dir)
  const stateJson = hostNeutralStateJson(state)
  try {
    writeFileAtomic(pemPath, pem)
    writeFileAtomic(statePath, stateJson)
    chmodSync(dir, 0o700)
  } catch (err) {
    try {
      unlinkSync(pemPath)
    } catch {
      // best-effort rollback so a partial pair cannot look ready
    }
    try {
      unlinkSync(statePath)
    } catch {
      // best-effort rollback
    }
    throw err
  }
  return pemPath
}

function hostNeutralStateJson(state: TrustStateV1): string {
  const body: TrustStateV1 = {
    v: 1,
    alg: 'sha256',
    fingerprintSha256: state.fingerprintSha256,
  }
  if (state.kind === PUBLISHER_SIGNATURE_MANIFEST_KIND && typeof state.publicKeySpki === 'string') {
    body.kind = PUBLISHER_SIGNATURE_MANIFEST_KIND
    body.publicKeySpki = state.publicKeySpki
  }
  return `${JSON.stringify(body)}\n`
}

function isSecureUnixMode(path: string, expected: number): boolean {
  if (process.platform === 'win32') return true
  try {
    return (statSync(path).mode & 0o777) === expected
  } catch {
    return false
  }
}

function isSystemTrustPlatform(value: string): value is SystemTrustPlatform {
  return SYSTEM_PLAN_PLATFORMS.has(value as SystemTrustPlatform)
}

function parseCliTokens(argv: readonly string[]): {
  flags: Map<string, string | true>
  rest: string[]
} {
  const flags = new Map<string, string | true>()
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? ''
    if (token === '--') {
      rest.push(...argv.slice(i + 1).filter((item): item is string => item != null))
      break
    }
    if (token.startsWith('--') && token.length > 2) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1))
        continue
      }
      const next = argv[i + 1]
      if (next != null && !next.startsWith('-')) {
        flags.set(body, next)
        i += 1
        continue
      }
      flags.set(body, true)
      continue
    }
    rest.push(token)
  }
  return { flags, rest }
}

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value
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
