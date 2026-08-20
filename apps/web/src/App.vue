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

const me = ref<Me | null>(null)
const loaded = ref(false)
const approveId = ref('')
const approving = ref(false)
const approveResult = ref('')
const approveOk = ref(false)

const view = computed(() => {
  if (!loaded.value || me.value == null) return 'login'
  if (me.value.status === '待批准') return 'pending'
  return 'member'
})

const canApprove = computed(
  () => me.value?.status === 'active' && me.value?.permission_level === 'full',
)

const permissionLabel = computed(() =>
  me.value?.permission_level === 'full' ? '正式成员' : '仅认领',
)

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
</script>
