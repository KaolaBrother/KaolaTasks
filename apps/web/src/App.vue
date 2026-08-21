<template>
  <n-config-provider :locale="zhCN" :date-locale="dateZhCN">
    <n-layout style="min-height: 100vh">
      <n-layout-header bordered style="padding: 16px 24px">
        <n-text strong style="font-size: 18px">考拉任务</n-text>
      </n-layout-header>
      <n-layout-content style="padding: 24px">
        <n-card title="登录" v-if="view === 'login'">
          <n-space vertical>
            <n-text>使用团队 forge 账号登录。GitLab / Gitea 为正式成员；GitHub 首次登录需批准后方可认领任务。</n-text>
            <n-space>
              <n-button type="primary" tag="a" href="/login/github">使用 GitHub 登录</n-button>
              <n-button type="primary" tag="a" href="/login/gitlab">使用 GitLab 登录</n-button>
              <n-button type="primary" tag="a" href="/login/gitea">使用 Gitea 登录</n-button>
            </n-space>
          </n-space>
        </n-card>

        <n-card title="账号待批准" v-else-if="view === 'pending'">
          <n-alert type="warning" :title="me?.message ?? '你的账号待正式成员批准后方可认领任务。'" />
          <n-descriptions :column="1" style="margin-top: 16px">
            <n-descriptions-item label="用户">{{ me?.display_name }}（{{ me?.username }}）</n-descriptions-item>
            <n-descriptions-item label="来源">{{ me?.provider }}</n-descriptions-item>
          </n-descriptions>
        </n-card>

        <n-card title="工作台" v-else-if="view === 'member'">
          <n-space vertical>
            <n-text>{{ me?.display_name }}，已登录（{{ me?.provider }} / {{ permissionLabel }}）</n-text>
            <n-divider v-if="canApprove">批准 GitHub 用户</n-divider>
            <n-space v-if="canApprove" align="center">
              <n-input v-model:value="approveId" placeholder="待批准用户 ID" />
              <n-button type="primary" :loading="approving" @click="approveUser">批准</n-button>
            </n-space>
            <n-text v-if="approveResult" :type="approveOk ? 'success' : 'error'">{{ approveResult }}</n-text>

            <n-divider v-if="canManageKeys">Agent Key</n-divider>
            <n-space v-if="canManageKeys" vertical>
              <n-text>自助生成与吊销个人 Agent API Key。明文仅在创建时显示一次，服务端只存哈希。</n-text>
              <n-space align="center">
                <n-input v-model:value="keyLabel" placeholder="备注（可选）" style="width: 220px" />
                <n-button type="primary" :loading="keyCreating" @click="createAgentKey">生成 Agent Key</n-button>
              </n-space>
              <n-alert v-if="newKeyToken" type="warning" title="请立即复制，关闭后无法再次查看">
                {{ newKeyToken }}
              </n-alert>
              <n-text v-if="keyMessage" :type="keyOk ? 'success' : 'error'">{{ keyMessage }}</n-text>
              <n-text v-if="agentKeys.length === 0">暂无 Agent Key。</n-text>
              <n-space v-for="key in agentKeys" :key="key.id" align="center">
                <n-text>#{{ key.id }} {{ key.label || '（无备注）' }} · {{ formatLastUsed(key.last_used_at) }}</n-text>
                <n-button size="small" @click="revokeAgentKey(key.id)">吊销</n-button>
              </n-space>
            </n-space>

            <n-divider v-if="canApprove">凭证档案</n-divider>
            <n-space v-if="canApprove" vertical>
              <n-text>按 forge + 仓库保存可复用 token，团队共享。删除档案后请到 forge 侧撤销该 token。</n-text>
              <n-space align="center">
                <n-select v-model:value="profileForge" :options="forgeOptions" style="width: 140px" />
                <n-input v-model:value="profileBaseUrl" placeholder="base_url" style="width: 240px" />
                <n-input v-model:value="profileRepo" placeholder="owner/repo" style="width: 200px" />
              </n-space>
              <n-space align="center">
                <n-input
                  v-model:value="profileToken"
                  type="password"
                  show-password-on="click"
                  placeholder="forge token"
                  style="width: 360px"
                />
                <n-button type="primary" :loading="profileCreating" @click="createProfile">添加档案</n-button>
              </n-space>
              <n-text v-if="profileMessage" :type="profileOk ? 'success' : 'error'">{{ profileMessage }}</n-text>
              <n-text v-if="profiles.length === 0">暂无凭证档案。</n-text>
              <n-space v-for="profile in profiles" :key="profile.id" align="center">
                <n-text>
                  #{{ profile.id }} {{ profile.forge }} {{ profile.repo_full_name }}（{{ profile.base_url }}）
                </n-text>
                <n-button size="small" @click="deleteProfile(profile.id)">删除</n-button>
              </n-space>
            </n-space>

            <n-divider v-if="canApprove">发布任务</n-divider>
            <n-form v-if="canApprove" data-testid="task-form" label-placement="top" @submit.prevent>
              <n-form-item label="标题">
                <n-input data-testid="task-title" v-model:value="taskTitle" placeholder="标题" />
              </n-form-item>
              <n-form-item label="描述">
                <n-input
                  data-testid="task-description"
                  type="textarea"
                  v-model:value="taskDescription"
                  placeholder="Markdown 描述（可选）"
                />
              </n-form-item>
              <n-form-item label="来源">
                <n-select
                  data-testid="task-source-type"
                  v-model:value="taskSourceType"
                  :options="sourceTypeOptions"
                />
              </n-form-item>
              <n-form-item v-if="taskSourceType === 'imported'" label="Issue URL">
                <n-input data-testid="task-issue-url" v-model:value="taskIssueUrl" placeholder="https://…" />
              </n-form-item>
              <n-form-item label="Forge">
                <n-select data-testid="task-forge" v-model:value="taskForge" :options="forgeOptions" />
              </n-form-item>
              <n-form-item label="仓库地址">
                <n-input data-testid="task-base-url" v-model:value="taskBaseUrl" placeholder="base_url" />
              </n-form-item>
              <n-form-item label="仓库">
                <n-input data-testid="task-repo" v-model:value="taskRepo" placeholder="owner/repo" />
              </n-form-item>
              <n-form-item label="默认分支（可选）">
                <n-input data-testid="task-base-branch" v-model:value="taskBaseBranch" placeholder="留空则由服务端默认" />
              </n-form-item>
              <n-form-item label="建议目录（可选）">
                <n-input
                  data-testid="task-suggested-dir"
                  v-model:value="taskSuggestedDir"
                  placeholder="留空则由服务端默认"
                />
              </n-form-item>
              <n-form-item label="验收标准">
                <n-input
                  data-testid="task-acceptance-criteria"
                  type="textarea"
                  v-model:value="taskAcceptanceCriteria"
                  placeholder="每行一条"
                />
              </n-form-item>
              <n-form-item label="测试命令">
                <n-input data-testid="task-test-command" v-model:value="taskTestCommand" placeholder="例如 pnpm test" />
              </n-form-item>
              <n-form-item label="允许路径">
                <n-input
                  data-testid="task-allowed-paths"
                  type="textarea"
                  v-model:value="taskAllowedPaths"
                  placeholder="每行一条"
                />
              </n-form-item>
              <n-form-item label="禁止路径">
                <n-input
                  data-testid="task-forbidden-paths"
                  type="textarea"
                  v-model:value="taskForbiddenPaths"
                  placeholder="每行一条"
                />
              </n-form-item>
              <n-form-item label="优先级">
                <n-select data-testid="task-priority" v-model:value="taskPriority" :options="priorityOptions" />
              </n-form-item>
              <n-form-item label="标签">
                <n-input
                  data-testid="task-tags"
                  type="textarea"
                  v-model:value="taskTags"
                  placeholder="每行一个"
                />
              </n-form-item>
              <n-form-item
                data-testid="task-credential-feedback"
                label="凭证"
                :feedback="taskCredentialFeedback || undefined"
                :validation-status="taskCredentialFeedback ? 'error' : undefined"
              >
                <n-space vertical>
                  <n-select
                    data-testid="task-credential-mode"
                    v-model:value="taskCredentialMode"
                    :options="credentialModeOptions"
                  />
                  <n-select
                    v-if="taskCredentialMode === 'profile'"
                    data-testid="task-credential-profile"
                    v-model:value="taskCredentialProfileId"
                    :options="taskProfileOptions"
                    placeholder="选择凭证档案"
                  />
                  <n-input
                    v-if="taskCredentialMode === 'inline'"
                    data-testid="task-credential-token"
                    v-model:value="taskCredentialToken"
                    type="password"
                    show-password-on="click"
                    placeholder="forge token"
                  />
                </n-space>
              </n-form-item>
              <n-button
                data-testid="task-submit"
                type="primary"
                :loading="taskCreating"
                @click="createTask"
              >
                发布
              </n-button>
              <n-text v-if="taskMessage" data-testid="task-message" :type="taskOk ? 'success' : 'error'">
                {{ taskMessage }}
              </n-text>
            </n-form>
          </n-space>
        </n-card>
      </n-layout-content>
    </n-layout>
  </n-config-provider>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { dateZhCN, zhCN } from 'naive-ui'

type Me = {
  id: number
  provider: string
  remote_id: string
  username: string
  display_name: string
  status: string
  permission_level: string
  message?: string
}

type AgentKeyRow = {
  id: number
  label: string
  last_used_at: number | null
}

type ProfileRow = {
  id: number
  forge: string
  base_url: string
  repo_full_name: string
  scopes_checked: unknown[]
  created_by: number
}

const FORGE_REVOKE_MESSAGE = '请同时到 forge 侧撤销该 token。'

const me = ref<Me | null>(null)
const loaded = ref(false)
const approveId = ref('')
const approving = ref(false)
const approveResult = ref('')
const approveOk = ref(false)

const keyLabel = ref('')
const keyCreating = ref(false)
const newKeyToken = ref('')
const keyMessage = ref('')
const keyOk = ref(false)
const agentKeys = ref<AgentKeyRow[]>([])

const profileForge = ref<'github' | 'gitlab' | 'gitea'>('gitlab')
const profileBaseUrl = ref('')
const profileRepo = ref('')
const profileToken = ref('')
const profileCreating = ref(false)
const profileMessage = ref('')
const profileOk = ref(false)
const profiles = ref<ProfileRow[]>([])

const taskTitle = ref('')
const taskDescription = ref('')
const taskSourceType = ref<'native' | 'imported'>('native')
const taskIssueUrl = ref('')
const taskForge = ref<'github' | 'gitlab' | 'gitea'>('gitlab')
const taskBaseUrl = ref('')
const taskRepo = ref('')
const taskBaseBranch = ref('')
const taskSuggestedDir = ref('')
const taskAcceptanceCriteria = ref('')
const taskTestCommand = ref('')
const taskAllowedPaths = ref('')
const taskForbiddenPaths = ref('')
const taskPriority = ref<'P0' | 'P1' | 'P2' | 'P3'>('P2')
const taskTags = ref('')
const taskCredentialMode = ref<'profile' | 'inline'>('profile')
const taskCredentialProfileId = ref<number | null>(null)
const taskCredentialToken = ref('')
const taskCreating = ref(false)
const taskMessage = ref('')
const taskOk = ref(false)
const taskCredentialFeedback = ref('')

const forgeOptions = [
  { label: 'GitHub', value: 'github' },
  { label: 'GitLab', value: 'gitlab' },
  { label: 'Gitea', value: 'gitea' },
]

const sourceTypeOptions = [
  { label: '平台自有', value: 'native' },
  { label: '从 Issue 导入', value: 'imported' },
]

const priorityOptions = [
  { label: 'P0', value: 'P0' },
  { label: 'P1', value: 'P1' },
  { label: 'P2', value: 'P2' },
  { label: 'P3', value: 'P3' },
]

const credentialModeOptions = [
  { label: '共享档案', value: 'profile' },
  { label: '单任务临时 token', value: 'inline' },
]

const view = computed(() => {
  if (!loaded.value || me.value == null) return 'login'
  if (me.value.status === '待批准') return 'pending'
  return 'member'
})

const canApprove = computed(
  () => me.value?.status === 'active' && me.value?.permission_level === 'full',
)

const canManageKeys = computed(() => me.value?.status === 'active')

const permissionLabel = computed(() =>
  me.value?.permission_level === 'full' ? '正式成员' : '仅认领',
)

const taskProfileOptions = computed(() =>
  profiles.value.map((profile) => ({
    label: `#${profile.id} ${profile.forge} ${profile.repo_full_name}（${profile.base_url}）`,
    value: profile.id,
  })),
)

function formatLastUsed(value: number | null): string {
  if (value == null) return '从未使用'
  return `最近使用 ${new Date(value * 1000).toLocaleString('zh-CN')}`
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

onMounted(async () => {
  try {
    const res = await fetch('/api/v1/me', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (res.ok) {
      me.value = (await res.json()) as Me
    } else {
      me.value = null
    }
  } catch {
    me.value = null
  } finally {
    loaded.value = true
  }
  if (canManageKeys.value) {
    await loadAgentKeys()
  }
  if (canApprove.value) {
    await loadProfiles()
  }
})

async function approveUser() {
  const id = approveId.value.trim()
  if (!id) {
    approveOk.value = false
    approveResult.value = '请填写待批准用户 ID'
    return
  }
  approving.value = true
  approveResult.value = ''
  try {
    const res = await fetch(`/api/v1/users/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      approveOk.value = false
      approveResult.value = `批准失败（${res.status}）`
      return
    }
    approveOk.value = true
    approveResult.value = '已批准，该用户可认领任务（GitHub 仍为仅认领）'
    approveId.value = ''
  } catch {
    approveOk.value = false
    approveResult.value = '批准请求失败'
  } finally {
    approving.value = false
  }
}

async function loadAgentKeys() {
  try {
    const res = await fetch('/api/v1/agent-keys', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const body = await readJson(res)
    agentKeys.value = Array.isArray(body?.keys) ? (body.keys as AgentKeyRow[]) : []
  } catch {
    agentKeys.value = []
  }
}

async function createAgentKey() {
  keyCreating.value = true
  keyMessage.value = ''
  newKeyToken.value = ''
  try {
    const res = await fetch('/api/v1/agent-keys', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: keyLabel.value }),
    })
    const body = await readJson(res)
    if (!res.ok) {
      keyOk.value = false
      keyMessage.value =
        typeof body?.message === 'string' ? body.message : `生成失败（${res.status}）`
      return
    }
    if (typeof body?.token === 'string') {
      newKeyToken.value = body.token
    }
    keyOk.value = true
    keyMessage.value = '已生成，请立即复制明文 Key。'
    keyLabel.value = ''
    await loadAgentKeys()
  } catch {
    keyOk.value = false
    keyMessage.value = '生成请求失败'
  } finally {
    keyCreating.value = false
  }
}

async function revokeAgentKey(id: number) {
  keyMessage.value = ''
  try {
    const res = await fetch(`/api/v1/agent-keys/${id}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      keyOk.value = false
      keyMessage.value = `吊销失败（${res.status}）`
      return
    }
    if (newKeyToken.value) newKeyToken.value = ''
    keyOk.value = true
    keyMessage.value = '已吊销，该 Key 立即失效。'
    await loadAgentKeys()
  } catch {
    keyOk.value = false
    keyMessage.value = '吊销请求失败'
  }
}

async function loadProfiles() {
  try {
    const res = await fetch('/api/v1/credential-profiles', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const body = await readJson(res)
    profiles.value = Array.isArray(body?.profiles) ? (body.profiles as ProfileRow[]) : []
  } catch {
    profiles.value = []
  }
}

async function createProfile() {
  profileCreating.value = true
  profileMessage.value = ''
  try {
    const res = await fetch('/api/v1/credential-profiles', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        forge: profileForge.value,
        base_url: profileBaseUrl.value,
        repo_full_name: profileRepo.value,
        token: profileToken.value,
      }),
    })
    const body = await readJson(res)
    if (!res.ok) {
      profileOk.value = false
      if (res.status === 409) {
        profileMessage.value = '该仓库档案已存在'
      } else if (res.status === 500 && body?.error === 'vault_unconfigured') {
        profileMessage.value = '凭证保险库未配置'
      } else {
        profileMessage.value = `添加失败（${res.status}）`
      }
      return
    }
    profileOk.value = true
    profileMessage.value = '档案已保存（token 已加密，不会再次显示）。'
    profileToken.value = ''
    await loadProfiles()
  } catch {
    profileOk.value = false
    profileMessage.value = '添加档案失败'
  } finally {
    profileCreating.value = false
  }
}

async function deleteProfile(id: number) {
  profileMessage.value = ''
  try {
    const res = await fetch(`/api/v1/credential-profiles/${id}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    const body = await readJson(res)
    if (!res.ok) {
      profileOk.value = false
      profileMessage.value = `删除失败（${res.status}）`
      return
    }
    profileOk.value = true
    profileMessage.value =
      typeof body?.message === 'string' ? body.message : FORGE_REVOKE_MESSAGE
    await loadProfiles()
  } catch {
    profileOk.value = false
    profileMessage.value = '删除档案失败'
  }
}

async function createTask() {
  const title = taskTitle.value.trim()
  const fullName = taskRepo.value.trim()
  const issueUrl = taskIssueUrl.value.trim()
  if (!title) return
  if (!fullName) return
  if (taskSourceType.value === 'imported' && !issueUrl) return
  if (taskCredentialMode.value === 'profile' && typeof taskCredentialProfileId.value !== 'number') {
    return
  }
  if (taskCredentialMode.value === 'inline' && !taskCredentialToken.value) return

  const repo: {
    forge: string
    base_url: string
    full_name: string
    base_branch?: string
    suggested_dir?: string
  } = {
    forge: taskForge.value,
    base_url: taskBaseUrl.value.trim(),
    full_name: fullName,
  }
  const baseBranch = taskBaseBranch.value.trim()
  if (baseBranch !== '') repo.base_branch = baseBranch
  const suggestedDir = taskSuggestedDir.value.trim()
  if (suggestedDir !== '') repo.suggested_dir = suggestedDir

  const source =
    taskSourceType.value === 'imported'
      ? { type: 'imported' as const, issue_url: issueUrl }
      : { type: 'native' as const }

  const credential =
    taskCredentialMode.value === 'inline'
      ? { token: taskCredentialToken.value }
      : { profile_id: taskCredentialProfileId.value as number }

  taskCreating.value = true
  taskMessage.value = ''
  taskOk.value = false
  taskCredentialFeedback.value = ''
  try {
    const res = await fetch('/api/v1/tasks', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description_md: taskDescription.value,
        source,
        repo,
        acceptance_criteria: splitLines(taskAcceptanceCriteria.value),
        test_command: taskTestCommand.value,
        constraints: {
          allowed_paths: splitLines(taskAllowedPaths.value),
          forbidden_paths: splitLines(taskForbiddenPaths.value),
        },
        priority: taskPriority.value,
        tags: splitLines(taskTags.value),
        credential,
      }),
    })
    const body = await readJson(res)
    if (!res.ok) {
      taskOk.value = false
      if (res.status === 422 && body?.error === 'token_check_failed') {
        taskCredentialFeedback.value =
          typeof body.message === 'string' ? body.message : `发布失败（${res.status}）`
        return
      }
      if (res.status === 500 && body?.error === 'vault_unconfigured') {
        taskMessage.value = '凭证保险库未配置'
        return
      }
      taskMessage.value =
        typeof body?.message === 'string' ? body.message : `发布失败（${res.status}）`
      return
    }
    const id = typeof body?.id === 'string' ? body.id : ''
    taskOk.value = true
    taskMessage.value = `任务已发布：${id}`
    taskCredentialToken.value = ''
  } catch {
    taskOk.value = false
    taskMessage.value = '发布请求失败'
  } finally {
    taskCreating.value = false
  }
}
</script>
