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

const forgeOptions = [
  { label: 'GitHub', value: 'github' },
  { label: 'GitLab', value: 'gitlab' },
  { label: 'Gitea', value: 'gitea' },
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

function formatLastUsed(value: number | null): string {
  if (value == null) return '从未使用'
  return `最近使用 ${new Date(value * 1000).toLocaleString('zh-CN')}`
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
</script>
