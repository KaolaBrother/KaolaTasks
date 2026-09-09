import * as z from 'zod'

export function getSharedHealth(): string {
  return 'kaola-shared-ready'
}

// DESIGN.md §5: eight canonical Chinese statuses. Issue #53 added 待修改 (ball with the Agent,
// claimable for a revision) and 待合并 (approved in Kaola, waiting for the forge merge).
export const taskStatusSchema = z.enum([
  '待认领',
  '进行中',
  '待验收',
  '待修改',
  '待合并',
  '已完成',
  '已退回',
  '已取消',
])

// Issue #53 (DESIGN.md §9 / §17): discussion message kinds shared by REST, MCP, and storage.
export const discussionMessageKindSchema = z.enum([
  'blocking',
  'suggestion',
  'question',
  'answer',
  'note',
  'resolution',
])

export type DiscussionMessageKind = z.infer<typeof discussionMessageKindSchema>

export const reviewRoundKindSchema = z.enum(['review', 'downstream_finding', 'restack'])

export type ReviewRoundKind = z.infer<typeof reviewRoundKindSchema>

export const reviewVerdictSchema = z.enum(['changes_requested', 'approved', 'terminated', 'withdrawn'])

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>

export type TaskStatus = z.infer<typeof taskStatusSchema>

export const taskBriefSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  description_md: z.string(),
  source: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('native'),
    }),
    z.strictObject({
      type: z.literal('imported'),
      issue_url: z.string(),
    }),
  ]),
  repo: z.strictObject({
    forge: z.enum(['github', 'gitlab', 'gitea']),
    base_url: z.string(),
    full_name: z.string(),
    base_branch: z.string(),
    suggested_dir: z.string(),
  }),
  acceptance_criteria: z.array(z.string()),
  test_command: z.string(),
  constraints: z.strictObject({
    allowed_paths: z.array(z.string()),
    forbidden_paths: z.array(z.string()),
  }),
  pr_convention: z.strictObject({
    branch_prefix: z.string(),
    title_prefix: z.string(),
    // Issue #53 (D10): the Agent opens a Draft PR from the start.
    draft: z.boolean(),
  }),
  // Issue #53 (D13): a dependent sub-task points at its parent's public id; otherwise null.
  parent_task_id: z.string().nullable(),
  // Issue #53: current review round; 0 until the first round is opened, > 0 marks a revision Claim.
  review_round: z.number().int().nonnegative(),
  // DESIGN.md §6: a reference, never the token itself — exactly one of two forms. The inline
  // marker only declares that a single-task token exists; its ciphertext lives on the task row.
  credential: z.union([
    z.strictObject({ profile_id: z.string() }),
    z.strictObject({ inline: z.literal(true) }),
  ]),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  tags: z.array(z.string()),
  poster: z.string(),
  status: taskStatusSchema,
  // Default ISO datetime rejects offset-only values such as +08:00.
  created_at: z.iso.datetime({ offset: true }),
})

export type TaskBrief = z.infer<typeof taskBriefSchema>

export function parseTaskBrief(input: unknown): TaskBrief {
  return taskBriefSchema.parse(input)
}

// DESIGN.md §5 (v0.6, #53) — the per-edge table. 待验收 → 已完成 is deliberately absent: a merge
// only completes a task Kaola already approved (待合并).
const LEGAL_TRANSITIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['待认领', new Set(['进行中', '已取消'])],
  ['进行中', new Set(['待认领', '待修改', '待验收'])],
  ['待验收', new Set(['待修改', '待合并', '已退回'])],
  ['待修改', new Set(['进行中', '已退回', '已取消'])],
  ['待合并', new Set(['待修改', '已完成', '已退回'])],
  ['已退回', new Set(['待认领', '已取消'])],
])

export function transitionTaskStatus(from: string, to: string): string {
  const allowed = LEGAL_TRANSITIONS.get(from)
  if (!allowed?.has(to)) {
    throw new Error(`Illegal task status transition: ${from} → ${to}`)
  }
  return to
}

export {
  DEVICE_PROOF_PREFIX,
  DEVICE_PROOF_SKEW_SECONDS,
  deviceFingerprint,
  deviceProofCanonical,
} from './device-proof.ts'

export {
  DEFAULT_PAIRING_TTL_SECONDS,
  MAX_PAIRING_TTL_SECONDS,
  MIN_PAIRING_TTL_SECONDS,
  PAIRING_MAX_FAILED_ATTEMPTS,
  PAIRING_NONCE_BYTES,
  PAIRING_PROTOCOL_VERSION,
  PAIRING_SECRET_BYTES,
  alignPendingExpiresAt,
  certificateSha256,
  derivePairingKey,
  displayPairingSecret,
  encodeApprovalTranscript,
  encodePairingTranscript,
  inspectPublicRootPem,
  newPairingId,
  newPairingNonce,
  newPairingSecret,
  normalizePairingOrigin,
  originDigestSha256,
  pairingApprovalProof,
  pairingCommitment,
  pairingExpiresAt,
  pairingIsLive,
  parsePairingSecret,
  parsePairingTtlSeconds,
  timingSafeEqualHex,
} from './pairing.ts'
