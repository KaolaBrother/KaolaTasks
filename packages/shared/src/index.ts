import * as z from 'zod'

export function getSharedHealth(): string {
  return 'kaola-shared-ready'
}

export const taskStatusSchema = z.enum([
  '待认领',
  '进行中',
  '待验收',
  '已完成',
  '已退回',
  '已取消',
])

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
  }),
  credential: z.strictObject({
    profile_id: z.string(),
  }),
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

const LEGAL_TRANSITIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['待认领', new Set(['进行中', '已取消'])],
  ['进行中', new Set(['待认领', '待验收'])],
  ['待验收', new Set(['已完成', '已退回'])],
  ['已退回', new Set(['待认领', '已取消'])],
])

export function transitionTaskStatus(from: string, to: string): string {
  const allowed = LEGAL_TRANSITIONS.get(from)
  if (!allowed?.has(to)) {
    throw new Error(`Illegal task status transition: ${from} → ${to}`)
  }
  return to
}
