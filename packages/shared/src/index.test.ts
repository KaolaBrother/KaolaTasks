import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { getSharedHealth } from './index.ts'

test('getSharedHealth returns the pinned non-empty shared package health string', () => {
  assert.equal(typeof getSharedHealth, 'function')
  const value = getSharedHealth()
  assert.equal(typeof value, 'string')
  assert.ok(value.length > 0)
  assert.equal(value, 'kaola-shared-ready')
})

const TASK_STATUSES = ['待认领', '进行中', '待验收', '已完成', '已退回', '已取消']

const LEGAL_TRANSITIONS = [
  ['待认领', '进行中'],
  ['进行中', '待认领'],
  ['进行中', '待验收'],
  ['待验收', '已完成'],
  ['待验收', '已退回'],
  ['已退回', '待认领'],
  ['待认领', '已取消'],
  ['已退回', '已取消'],
]

const REQUIRED_TOP_LEVEL_FIELDS = [
  'id',
  'title',
  'description_md',
  'source',
  'repo',
  'acceptance_criteria',
  'test_command',
  'constraints',
  'pr_convention',
  'credential',
  'priority',
  'tags',
  'poster',
  'status',
  'created_at',
]

const REQUIRED_NESTED_FIELDS = [
  ['repo', 'forge'],
  ['repo', 'base_url'],
  ['repo', 'full_name'],
  ['repo', 'base_branch'],
  ['repo', 'suggested_dir'],
  ['constraints', 'allowed_paths'],
  ['constraints', 'forbidden_paths'],
  ['pr_convention', 'branch_prefix'],
  ['pr_convention', 'title_prefix'],
]

function designExample() {
  return {
    id: 'kt-2026-0142',
    title: '为订单导出接口增加分页',
    description_md: '……（Markdown 详述）',
    source: {
      type: 'imported',
      issue_url: 'https://gitea.internal.example/team/orders/issues/87',
    },
    repo: {
      forge: 'gitea',
      base_url: 'https://gitea.internal.example',
      full_name: 'team/orders',
      base_branch: 'main',
      suggested_dir: 'orders',
    },
    acceptance_criteria: [
      'GET /api/orders/export 支持 page/page_size 参数',
      '新增单元测试覆盖分页边界',
    ],
    test_command: 'pnpm test',
    constraints: {
      allowed_paths: ['src/api/**', 'tests/**'],
      forbidden_paths: ['migrations/**'],
    },
    pr_convention: {
      branch_prefix: 'kaola/kt-2026-0142-',
      title_prefix: '[kt-2026-0142] ',
    },
    credential: { profile_id: 'cp-gitea-orders' },
    priority: 'P1',
    tags: ['backend', 'api'],
    poster: 'zhang.wei',
    status: '待认领',
    created_at: '2026-08-20T12:00:00+08:00',
  }
}

async function loadExport(name) {
  const mod = await import('./index.ts')
  const value = mod[name]
  assert.equal(typeof value, 'function', `${name} must be exported as a function`)
  return value
}

describe('parseTaskBrief', () => {
  test('parseTaskBrief accepts the DESIGN.md §6 Task Brief example including Chinese ellipsis description', async () => {
    const parseTaskBrief = await loadExport('parseTaskBrief')
    const brief = designExample()
    const parsed = parseTaskBrief(brief)
    assert.deepEqual(parsed, brief)
    assert.equal(parsed.description_md, '……（Markdown 详述）')
  })

  test('parseTaskBrief accepts a valid brief whose source is native with no issue_url', async () => {
    const parseTaskBrief = await loadExport('parseTaskBrief')
    const brief = designExample()
    brief.source = { type: 'native' }
    assert.deepEqual(parseTaskBrief(brief), brief)
  })

  for (const status of TASK_STATUSES) {
    test(`parseTaskBrief accepts status ${status}`, async () => {
      const parseTaskBrief = await loadExport('parseTaskBrief')
      const brief = designExample()
      brief.status = status
      assert.deepEqual(parseTaskBrief(brief), brief)
    })
  }

  for (const forge of ['github', 'gitlab', 'gitea']) {
    test(`parseTaskBrief accepts repo.forge ${forge}`, async () => {
      const parseTaskBrief = await loadExport('parseTaskBrief')
      const brief = designExample()
      brief.repo.forge = forge
      assert.deepEqual(parseTaskBrief(brief), brief)
    })
  }

  for (const priority of ['P0', 'P1', 'P2', 'P3']) {
    test(`parseTaskBrief accepts priority ${priority}`, async () => {
      const parseTaskBrief = await loadExport('parseTaskBrief')
      const brief = designExample()
      brief.priority = priority
      assert.deepEqual(parseTaskBrief(brief), brief)
    })
  }

  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    test(`parseTaskBrief rejects a brief missing required field ${field}`, async () => {
      const parseTaskBrief = await loadExport('parseTaskBrief')
      const brief = designExample()
      delete brief[field]
      assert.throws(() => parseTaskBrief(brief))
    })
  }

  for (const [parent, child] of REQUIRED_NESTED_FIELDS) {
    test(`parseTaskBrief rejects a brief missing ${parent}.${child}`, async () => {
      const parseTaskBrief = await loadExport('parseTaskBrief')
      const brief = designExample()
      const nested = { ...brief[parent] }
      delete nested[child]
      brief[parent] = nested
      assert.throws(() => parseTaskBrief(brief))
    })
  }

  test('parseTaskBrief rejects status that is not one of the six Chinese labels', async () => {
    const parseTaskBrief = await loadExport('parseTaskBrief')
    const brief = designExample()
    brief.status = 'open'
    assert.throws(() => parseTaskBrief(brief))
  })

  test('parseTaskBrief rejects repo.forge outside github | gitlab | gitea', async () => {
    const parseTaskBrief = await loadExport('parseTaskBrief')
    const brief = designExample()
    brief.repo.forge = 'bitbucket'
    assert.throws(() => parseTaskBrief(brief))
  })

  test('parseTaskBrief rejects imported source without issue_url', async () => {
    const parseTaskBrief = await loadExport('parseTaskBrief')
    const brief = designExample()
    brief.source = { type: 'imported' }
    assert.throws(() => parseTaskBrief(brief))
  })

  test('parseTaskBrief rejects native source that includes issue_url', async () => {
    const parseTaskBrief = await loadExport('parseTaskBrief')
    const brief = designExample()
    brief.source = {
      type: 'native',
      issue_url: 'https://gitea.internal.example/team/orders/issues/87',
    }
    assert.throws(() => parseTaskBrief(brief))
  })

  test('parseTaskBrief rejects priority outside P0|P1|P2|P3', async () => {
    const parseTaskBrief = await loadExport('parseTaskBrief')
    const brief = designExample()
    brief.priority = 'high'
    assert.throws(() => parseTaskBrief(brief))
  })

  test('parseTaskBrief rejects a raw token field on the brief', async () => {
    const parseTaskBrief = await loadExport('parseTaskBrief')
    const brief = designExample()
    brief.token = 'raw-token-must-not-appear'
    assert.throws(() => parseTaskBrief(brief))
  })

  test('parseTaskBrief rejects credential that has no profile_id', async () => {
    const parseTaskBrief = await loadExport('parseTaskBrief')
    const brief = designExample()
    brief.credential = {}
    assert.throws(() => parseTaskBrief(brief))
  })

  test('parseTaskBrief rejects a raw token field inside credential', async () => {
    const parseTaskBrief = await loadExport('parseTaskBrief')
    const brief = designExample()
    brief.credential = { token: 'raw-token-must-not-appear' }
    assert.throws(() => parseTaskBrief(brief))
  })

  test('parseTaskBrief rejects credential that includes both profile_id and a raw token', async () => {
    const parseTaskBrief = await loadExport('parseTaskBrief')
    const brief = designExample()
    brief.credential = {
      profile_id: 'cp-gitea-orders',
      token: 'raw-token-must-not-appear',
    }
    assert.throws(() => parseTaskBrief(brief))
  })
})

describe('transitionTaskStatus', () => {
  const legal = new Set(LEGAL_TRANSITIONS.map(([from, to]) => `${from}\0${to}`))

  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      if (legal.has(`${from}\0${to}`)) {
        test(`transitionTaskStatus allows ${from} → ${to}`, async () => {
          const transitionTaskStatus = await loadExport('transitionTaskStatus')
          assert.equal(transitionTaskStatus(from, to), to)
        })
      } else {
        test(`transitionTaskStatus rejects ${from} → ${to}`, async () => {
          const transitionTaskStatus = await loadExport('transitionTaskStatus')
          assert.throws(() => transitionTaskStatus(from, to))
        })
      }
    }
  }

  test('transitionTaskStatus rejects an unknown from status', async () => {
    const transitionTaskStatus = await loadExport('transitionTaskStatus')
    assert.throws(() => transitionTaskStatus('open', '待认领'))
  })

  test('transitionTaskStatus rejects an unknown to status', async () => {
    const transitionTaskStatus = await loadExport('transitionTaskStatus')
    assert.throws(() => transitionTaskStatus('待认领', 'closed'))
  })
})
