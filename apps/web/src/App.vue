<template>
  <div class="app-root" :class="{ 'is-member': view === 'member' }">
    <n-config-provider :locale="zhCN" :date-locale="dateZhCN" :theme-overrides="themeOverrides">
      <n-layout class="app-shell">
        <n-layout-header bordered class="app-header">
          <div class="app-header-inner">
            <n-text strong class="wordmark">考拉任务</n-text>
            <n-text v-if="view === 'member'" class="workbench-title">工作台</n-text>
            <n-text v-if="view === 'member'" class="header-meta">
              {{ me?.display_name }} · {{ providerLabel }} · {{ permissionLabel }}
            </n-text>
          </div>
        </n-layout-header>
        <n-layout-content class="app-content">
          <n-card title="登录" v-if="view === 'login'" class="gate-card">
            <n-space vertical>
              <n-text>使用团队 forge 账号登录。GitLab / Gitea 为正式成员；GitHub 首次登录需批准后方可认领任务。</n-text>
              <n-space>
                <n-button
                  class="has-ripple primary-fill"
                  type="primary"
                  tag="a"
                  href="/login/github"
                  @pointerdown="onRipple"
                >使用 GitHub 登录</n-button>
                <n-button
                  class="has-ripple primary-fill"
                  type="primary"
                  tag="a"
                  href="/login/gitlab"
                  @pointerdown="onRipple"
                >使用 GitLab 登录</n-button>
                <n-button
                  class="has-ripple primary-fill"
                  type="primary"
                  tag="a"
                  href="/login/gitea"
                  @pointerdown="onRipple"
                >使用 Gitea 登录</n-button>
              </n-space>
            </n-space>
          </n-card>

          <n-card title="账号待批准" v-else-if="view === 'pending'" class="gate-card">
            <n-alert type="warning" :title="me?.message ?? '你的账号待正式成员批准后方可认领任务。'" />
            <n-descriptions :column="1" style="margin-top: 16px">
              <n-descriptions-item label="用户">{{ me?.display_name }}（{{ me?.username }}）</n-descriptions-item>
              <n-descriptions-item label="来源">{{ me?.provider }}</n-descriptions-item>
            </n-descriptions>
          </n-card>

          <div v-else-if="view === 'member'" class="workbench">
            <nav data-testid="workbench-nav" class="workbench-nav">
              <div class="workbench-nav-track" :style="{ '--nav-index': navCurrentIndex }">
                <button
                  v-for="(item, index) in navItems"
                  :key="item.id"
                  type="button"
                  class="workbench-nav-item has-ripple"
                  :class="{ 'is-current': workbenchPane === item.id }"
                  :data-testid="item.testid"
                  :style="{ '--i': index }"
                  @pointerdown="onRipple"
                  @click="workbenchPane = item.id"
                >
                  {{ item.label }}
                </button>
                <span class="nav-leaf-bar" aria-hidden="true" />
              </div>
            </nav>

            <div class="workbench-main">
              <div
                v-show="workbenchPane === 'board'"
                data-testid="workbench-pane-board"
                class="workbench-pane"
                :class="{ 'is-active': workbenchPane === 'board' }"
              >
                <div data-testid="board">
                  <n-space vertical>
                    <n-text strong>任务看板</n-text>
                    <n-space class="board-toolbar">
                      <n-button
                        data-testid="board-view-list"
                        class="has-ripple"
                        @pointerdown="onRipple"
                        @click="boardLayout = 'list'"
                      >列表</n-button>
                      <n-button
                        data-testid="board-view-kanban"
                        class="has-ripple"
                        @pointerdown="onRipple"
                        @click="boardLayout = 'kanban'"
                      >看板</n-button>
                    </n-space>
                    <n-space class="board-filters" align="center">
                      <n-text>状态</n-text>
                      <n-select
                        data-testid="board-filter-status"
                        v-model:value="boardFilterStatus"
                        :options="boardStatusFilterOptions"
                        style="width: 140px"
                      />
                      <n-text>标签</n-text>
                      <n-select
                        data-testid="board-filter-tag"
                        v-model:value="boardFilterTag"
                        :options="boardTagFilterOptions"
                        style="width: 140px"
                      />
                      <n-text>Forge</n-text>
                      <n-select
                        data-testid="board-filter-forge"
                        v-model:value="boardFilterForge"
                        :options="boardForgeFilterOptions"
                        style="width: 140px"
                      />
                    </n-space>
                    <n-text v-if="filteredBoardTasks.length === 0" class="empty-copy">暂无任务。</n-text>
                    <div class="board-workspace">
                      <div class="board-main">
                        <div v-if="boardLayout === 'kanban'" data-testid="board-kanban" class="board-kanban">
                          <div
                            v-for="(status, index) in BOARD_STATUSES"
                            :key="status"
                            :data-testid="'board-column-' + status"
                            class="board-column"
                            :class="{ 'is-current': currentKanbanStatus === status }"
                            :style="{ '--i': index }"
                          >
                            <n-text strong>{{ status }}</n-text>
                            <div
                              v-for="task in tasksForColumn(status)"
                              :key="task.id"
                              :data-testid="'board-card-' + task.id"
                              class="slip-card has-ripple"
                              :class="{
                                'is-selected': selectedTaskId === task.id,
                                'is-flash': flashedTaskId === task.id,
                              }"
                              @pointerdown="onRipple"
                              @click="openBoardDetail(task.id)"
                            >
                              <span class="slip-title">{{ task.title }}</span>
                              <span class="slip-id">{{ task.id }}</span>
                              <span class="slip-dot" :data-priority="task.priority ?? 'P2'" />
                            </div>
                          </div>
                        </div>
                        <div v-else data-testid="board-list">
                          <div
                            v-for="task in filteredBoardTasks"
                            :key="task.id"
                            :data-testid="'board-card-' + task.id"
                            class="slip-card has-ripple"
                            :class="{
                              'is-selected': selectedTaskId === task.id,
                              'is-flash': flashedTaskId === task.id,
                            }"
                            @pointerdown="onRipple"
                            @click="openBoardDetail(task.id)"
                          >
                            <span class="slip-title">{{ task.title }}</span>
                            <span class="slip-id">{{ task.id }}</span>
                            <span class="slip-dot" :data-priority="task.priority ?? 'P2'" />
                          </div>
                        </div>
                      </div>
                      <div v-if="selectedTask" data-testid="board-detail" class="board-detail">
                        <n-space vertical>
                          <n-text data-testid="board-detail-title">{{ selectedTask.title }}</n-text>
                          <n-text data-testid="board-detail-description">{{ selectedTask.description_md }}</n-text>
                          <n-text data-testid="board-detail-status">{{ selectedTask.status }}</n-text>
                          <n-text data-testid="board-detail-poster">{{ selectedTask.poster }}</n-text>
                          <n-text data-testid="board-detail-tags">{{ selectedTask.tags.join(' ') }}</n-text>
                          <n-text data-testid="board-detail-forge">{{ selectedTask.repo.forge }}</n-text>
                          <n-text data-testid="board-detail-credential">{{ credentialChrome(selectedTask.credential) }}</n-text>
                          <n-text
                            v-if="selectedTask.source.type === 'imported'"
                            data-testid="board-detail-import-label"
                          >导入内容</n-text>
                          <div v-if="boardIssueUrl(selectedTask) != null" data-testid="board-detail-issue-url">
                            <a
                              v-if="boardIssueUrlIsHttp(selectedTask)"
                              :href="boardIssueUrl(selectedTask) ?? undefined"
                            >{{ boardIssueUrl(selectedTask) }}</a>
                            <template v-else>{{ boardIssueUrl(selectedTask) }}</template>
                          </div>
                          <n-space>
                            <n-button
                              v-if="canPosterCancel"
                              data-testid="board-detail-cancel"
                              class="has-ripple"
                              @pointerdown="onRipple"
                              @click="patchTaskStatus('已取消')"
                            >取消</n-button>
                            <n-button
                              v-if="canPosterReopen"
                              data-testid="board-detail-reopen"
                              class="has-ripple primary-fill"
                              type="primary"
                              @pointerdown="onRipple"
                              @click="patchTaskStatus('待认领')"
                            >重新开放</n-button>
                          </n-space>
                          <n-text v-if="boardDetailActionMessage" data-testid="board-detail-action-message" class="task-fail">
                            {{ boardDetailActionMessage }}
                          </n-text>
                          <n-button
                            data-testid="board-detail-close"
                            class="has-ripple"
                            @pointerdown="onRipple"
                            @click="closeBoardDetail"
                          >关闭</n-button>
                          <div data-testid="board-timeline">
                            <div data-testid="board-timeline-item">
                              发布 {{ selectedTask.poster }} {{ selectedTask.created_at }}
                            </div>
                          </div>
                        </n-space>
                      </div>
                    </div>
                  </n-space>
                </div>
              </div>

              <div
                v-if="canApprove"
                v-show="workbenchPane === 'publish'"
                data-testid="workbench-pane-publish"
                class="workbench-pane"
                :class="{ 'is-active': workbenchPane === 'publish' }"
              >
                <n-form data-testid="task-form" label-placement="top" @submit.prevent>
                  <section data-testid="task-group-credential" class="form-group">
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
                        <n-text
                          v-if="taskCredentialMode === 'profile' && profiles.length === 0"
                          data-testid="task-profile-empty-hint"
                        >
                          暂无凭证档案，请先到钥匙页添加。
                        </n-text>
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
                  </section>
                  <section data-testid="task-group-repo" class="form-group">
                    <n-form-item v-if="taskCredentialMode === 'inline'" label="Forge">
                      <n-select data-testid="task-forge" v-model:value="taskForge" :options="forgeOptions" />
                    </n-form-item>
                    <n-form-item v-if="taskCredentialMode === 'inline'" label="仓库地址">
                      <n-input data-testid="task-base-url" v-model:value="taskBaseUrl" placeholder="base_url" />
                    </n-form-item>
                    <n-form-item v-if="taskCredentialMode === 'inline'" label="仓库">
                      <n-input data-testid="task-repo" v-model:value="taskRepo" placeholder="owner/repo" />
                    </n-form-item>
                    <details data-testid="task-group-advanced" class="form-advanced">
                      <summary>高级</summary>
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
                    </details>
                  </section>
                  <section data-testid="task-group-task" class="form-group">
                    <n-form-item label="来源">
                      <n-select
                        data-testid="task-source-type"
                        v-model:value="taskSourceType"
                        :options="sourceTypeOptions"
                      />
                    </n-form-item>
                    <n-form-item
                      v-if="taskSourceType === 'imported' && taskCredentialMode === 'inline'"
                      label="Issue URL"
                    >
                      <n-input data-testid="task-issue-url" v-model:value="taskIssueUrl" placeholder="https://…" />
                    </n-form-item>
                    <n-form-item
                      v-if="taskSourceType === 'imported' && taskCredentialMode === 'profile'"
                      label="Issue"
                    >
                      <n-select
                        data-testid="task-issue-select"
                        v-model:value="taskIssueUrl"
                        :options="listedIssueOptions"
                        placeholder="选择 Issue"
                      />
                    </n-form-item>
                    <n-button
                      v-if="taskSourceType === 'imported'"
                      data-testid="task-import"
                      class="has-ripple"
                      @pointerdown="onRipple"
                      @click="importTask"
                    >
                      导入
                    </n-button>
                    <n-text v-if="taskSourceType === 'imported'" data-testid="task-import-source-label">导入内容</n-text>
                    <n-form-item :label="taskSourceType === 'imported' ? '标题（来自 Issue）' : '标题'">
                      <n-input data-testid="task-title" v-model:value="taskTitle" placeholder="标题" />
                    </n-form-item>
                    <n-form-item :label="taskSourceType === 'imported' ? '描述（Issue 正文）' : '描述'">
                      <n-input
                        data-testid="task-description"
                        type="textarea"
                        v-model:value="taskDescription"
                        :placeholder="
                          taskSourceType === 'imported' ? 'Issue 正文（Markdown）' : 'Markdown 描述（可选）'
                        "
                      />
                    </n-form-item>
                  </section>
                  <section data-testid="task-group-acceptance" class="form-group">
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
                  </section>
                  <n-button
                    data-testid="task-submit"
                    class="has-ripple primary-fill primary-wide"
                    type="primary"
                    :loading="taskCreating"
                    @pointerdown="onRipple"
                    @click="createTask"
                  >
                    发布
                  </n-button>
                  <n-text
                    v-if="taskMessage"
                    data-testid="task-message"
                    :type="taskOk ? 'success' : 'error'"
                    :class="{ 'task-fail': !taskOk }"
                  >
                    {{ taskMessage }}
                  </n-text>
                </n-form>
              </div>

              <div
                v-show="workbenchPane === 'keys'"
                data-testid="workbench-pane-keys"
                class="workbench-pane"
                :class="{ 'is-active': workbenchPane === 'keys' }"
              >
                <n-space vertical>
                  <n-divider v-if="canManageKeys">受信自动化</n-divider>
                  <n-space v-if="canManageKeys" vertical>
                    <n-text>
                      开启后，你的 Agent 自主发起（autonomous）的认领将直接生效；关闭时，每次自主认领都需要你在下方待确认认领列表中批准。
                    </n-text>
                    <n-space
                      class="trusted-block"
                      :class="{ 'is-on': trustedAutomation }"
                      align="center"
                    >
                      <n-text>受信自动化</n-text>
                      <span class="has-ripple" @pointerdown="onRipple">
                        <n-switch
                          data-testid="trusted-automation-toggle"
                          :value="trustedAutomation"
                          @update:value="setTrustedAutomation"
                        />
                      </span>
                    </n-space>
                    <n-text strong>待确认认领</n-text>
                    <div data-testid="claim-confirmation-list">
                      <n-text v-if="claimConfirmations.length === 0" class="empty-copy">暂无待确认认领。</n-text>
                      <n-space
                        v-for="row in claimConfirmations"
                        :key="row.id"
                        class="claim-row"
                        align="center"
                      >
                        <n-text>#{{ row.id }} 任务 {{ row.task_id }} · {{ row.created_at }}</n-text>
                        <n-button
                          data-testid="claim-confirmation-approve"
                          class="has-ripple primary-fill"
                          size="small"
                          type="primary"
                          @pointerdown="onRipple"
                          @click="approveClaimConfirmation(row.id, $event)"
                        >批准</n-button>
                        <n-button
                          data-testid="claim-confirmation-reject"
                          class="has-ripple"
                          size="small"
                          @pointerdown="onRipple"
                          @click="rejectClaimConfirmation(row.id, $event)"
                        >拒绝</n-button>
                      </n-space>
                    </div>
                  </n-space>

                  <n-divider v-if="canManageKeys">Agent Key</n-divider>
                  <n-space v-if="canManageKeys" vertical>
                    <n-text>自助生成与吊销个人 Agent API Key。明文仅在创建时显示一次，服务端只存哈希。</n-text>
                    <n-space class="keys-inline" align="center">
                      <n-input v-model:value="keyLabel" placeholder="备注（可选）" style="width: 220px" />
                      <n-button
                        class="has-ripple primary-fill"
                        type="primary"
                        :loading="keyCreating"
                        @pointerdown="onRipple"
                        @click="createAgentKey"
                      >生成 Agent Key</n-button>
                    </n-space>
                    <n-alert v-if="newKeyToken" type="warning" title="请立即复制，关闭后无法再次查看">
                      {{ newKeyToken }}
                    </n-alert>
                    <n-text v-if="keyMessage" :type="keyOk ? 'success' : 'error'">{{ keyMessage }}</n-text>
                    <n-text v-if="agentKeys.length === 0" class="empty-copy">暂无 Agent Key。</n-text>
                    <n-space v-for="key in agentKeys" :key="key.id" align="center">
                      <n-text>#{{ key.id }} {{ key.label || '（无备注）' }} · {{ formatLastUsed(key.last_used_at) }}</n-text>
                      <n-button size="small" class="has-ripple" @pointerdown="onRipple" @click="revokeAgentKey(key.id)">吊销</n-button>
                    </n-space>
                  </n-space>

                  <n-divider v-if="canApprove">凭证档案</n-divider>
                  <n-space v-if="canApprove" vertical>
                    <n-text>按 forge + 仓库保存可复用 token，团队共享。删除档案后请到 forge 侧撤销该 token。</n-text>
                    <n-space class="profile-create" align="center">
                      <n-select
                        data-testid="profile-forge"
                        v-model:value="profileForge"
                        :options="forgeOptions"
                        style="width: 140px"
                      />
                      <n-input
                        data-testid="profile-base-url"
                        v-model:value="profileBaseUrl"
                        placeholder="base_url"
                        style="width: 240px"
                      />
                      <n-input
                        data-testid="profile-repo"
                        v-model:value="profileRepo"
                        placeholder="owner/repo"
                        style="width: 200px"
                      />
                    </n-space>
                    <n-space class="profile-create" align="center">
                      <n-input
                        data-testid="profile-token"
                        v-model:value="profileToken"
                        type="password"
                        show-password-on="click"
                        placeholder="forge token"
                        style="width: 360px"
                      />
                      <n-button
                        data-testid="profile-submit"
                        class="has-ripple primary-fill"
                        type="primary"
                        :loading="profileCreating"
                        @pointerdown="onRipple"
                        @click="createProfile"
                      >添加档案</n-button>
                    </n-space>
                    <n-text v-if="profileMessage" :type="profileOk ? 'success' : 'error'">{{ profileMessage }}</n-text>
                    <n-text v-if="profiles.length === 0" class="empty-copy">暂无凭证档案。</n-text>
                    <n-space v-for="profile in profiles" :key="profile.id" align="center">
                      <n-text>
                        #{{ profile.id }} {{ profile.forge }} {{ profile.repo_full_name }}（{{ profile.base_url }}）
                      </n-text>
                      <n-button size="small" class="has-ripple" @pointerdown="onRipple" @click="deleteProfile(profile.id)">删除</n-button>
                    </n-space>
                  </n-space>

                  <n-divider v-if="canApprove">批准 GitHub 用户</n-divider>
                  <n-space v-if="canApprove" class="keys-inline" align="center">
                    <n-input v-model:value="approveId" placeholder="GitHub 用户数字 id" />
                    <n-button
                      class="has-ripple primary-fill"
                      type="primary"
                      :loading="approving"
                      @pointerdown="onRipple"
                      @click="approveUser"
                    >批准</n-button>
                  </n-space>
                  <n-text v-if="approveResult" :type="approveOk ? 'success' : 'error'">{{ approveResult }}</n-text>
                </n-space>
              </div>

              <div
                v-show="workbenchPane === 'audit'"
                data-testid="workbench-pane-audit"
                class="workbench-pane"
                :class="{ 'is-active': workbenchPane === 'audit' }"
              >
                <n-divider>审计日志</n-divider>
                <div data-testid="audit-section">
                  <n-space vertical>
                    <n-text strong>审计日志</n-text>
                    <n-space class="audit-filters" align="center">
                      <n-text>类型</n-text>
                      <n-select
                        data-testid="audit-filter-type"
                        v-model:value="auditFilterType"
                        :options="auditTypeFilterOptions"
                        style="width: 160px"
                      />
                      <n-text>人</n-text>
                      <n-select
                        data-testid="audit-filter-actor"
                        v-model:value="auditFilterActor"
                        :options="auditActorFilterOptions"
                        style="width: 160px"
                      />
                      <n-text>任务</n-text>
                      <n-input
                        data-testid="audit-filter-task"
                        v-model:value="auditFilterTask"
                        placeholder="任务编号"
                        style="width: 160px"
                      />
                      <n-text>时间</n-text>
                      <n-input
                        data-testid="audit-filter-from"
                        v-model:value="auditFilterFrom"
                        placeholder="起始时间（ISO-8601）"
                        style="width: 200px"
                      />
                      <input
                        class="audit-datetime"
                        type="datetime-local"
                        :value="toDatetimeLocalValue(auditFilterFrom)"
                        @change="onAuditFromPicker"
                      />
                      <n-input
                        data-testid="audit-filter-to"
                        v-model:value="auditFilterTo"
                        placeholder="结束时间（ISO-8601）"
                        style="width: 200px"
                      />
                      <input
                        class="audit-datetime"
                        type="datetime-local"
                        :value="toDatetimeLocalValue(auditFilterTo)"
                        @change="onAuditToPicker"
                      />
                    </n-space>
                    <n-text v-if="filteredAuditEvents.length === 0" class="empty-copy">暂无审计记录。</n-text>
                    <div
                      v-for="(row, index) in filteredAuditEvents"
                      :key="row.id"
                      data-testid="audit-row"
                      class="audit-row"
                      :style="{ '--i': Math.min(index, 8) }"
                    >
                      <n-text>
                        #{{ row.id }} {{ row.type }} · {{ row.actor_username ?? SYSTEM_ACTOR_LABEL }} ·
                        {{ row.created_at }} · {{ auditRowDetailsText(row) }}
                      </n-text>
                    </div>
                  </n-space>
                </div>

                <n-divider>团队统计</n-divider>
                <div data-testid="stats-section">
                  <n-space vertical>
                    <n-text strong>团队统计</n-text>
                    <n-text data-testid="stats-completed-count" class="stats-count">
                      完成数：<span
                        class="stats-count-value"
                        :style="{
                          '--count-to': stats?.completed_count ?? 0,
                          '--count-now': statsCompletedDisplay,
                        }"
                      >{{ stats?.completed_count ?? 0 }}</span>
                    </n-text>
                    <n-text v-if="statsByUsername.length === 0" class="empty-copy">暂无完成记录。</n-text>
                    <n-text
                      v-for="(entry, index) in statsByUsername"
                      :key="entry.username"
                      class="stats-user"
                      :style="{ '--i': index }"
                    >
                      {{ entry.username }}：{{ entry.count }}
                    </n-text>
                  </n-space>
                </div>
              </div>
            </div>
          </div>
        </n-layout-content>
      </n-layout>
    </n-config-provider>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { dateZhCN, zhCN } from 'naive-ui'
import './theme.css'
import { ensureRootTokens, themeOverrides } from './theme'

ensureRootTokens()

type Me = {
  id: number
  provider: string
  remote_id: string
  username: string
  display_name: string
  status: string
  permission_level: string
  trusted_automation?: boolean
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

type ListedIssue = {
  number: number
  title: string
  issue_url: string
}

type BoardTask = {
  id: string
  title: string
  description_md: string
  source: { type: 'native' } | { type: 'imported'; issue_url: string }
  repo: { forge: string }
  tags: string[]
  poster: string
  status: string
  created_at: string
  credential: { profile_id: string } | { inline: true }
  priority?: string
}

type EventRow = {
  id: number
  type: string
  actor_user_id: number | null
  actor_username: string | null
  created_at: string
  details: Record<string, unknown>
}

type StatsBody = {
  completed_count: number
  completed_by_username: Record<string, number>
}

type ClaimConfirmationRow = {
  id: number
  task_id: string
  state: string
  created_at: string
}

type WorkbenchPane = 'board' | 'publish' | 'keys' | 'audit'
type ForgeKind = 'github' | 'gitlab' | 'gitea'

const FORGE_REVOKE_MESSAGE = '请同时到 forge 侧撤销该 token。'
const SYSTEM_ACTOR_LABEL = '系统'
// Shared audit event vocabulary — kept in sync with server writers (tasks.ts/claim.ts/poller.ts/
// webhook.ts) so the 类型 filter never silently drops a live event type.
const LIVE_EVENT_TYPES = ['token 揭示', '状态迁移', '心跳', '变更', '回写', '认领待确认', '认领已确认']

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

const profileForge = ref<ForgeKind>('gitlab')
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
const taskForge = ref<ForgeKind>('gitlab')
const taskBaseUrl = ref('')
const taskBaseBranch = ref('')
const taskSuggestedDir = ref('')
const taskRepo = ref('')
const taskAcceptanceCriteria = ref('')
const taskTestCommand = ref('')
const taskAllowedPaths = ref('')
const taskForbiddenPaths = ref('')
const taskPriority = ref<'P0' | 'P1' | 'P2' | 'P3'>('P2')
const taskTags = ref('')
const taskCredentialMode = ref<'profile' | 'inline'>('profile')
const taskCredentialProfileId = ref<number | null>(null)
const taskCredentialToken = ref('')
const listedIssues = ref<ListedIssue[]>([])
let listedIssuesRequest = 0
const taskCreating = ref(false)
const taskMessage = ref('')
const taskOk = ref(false)
const taskCredentialFeedback = ref('')

const BOARD_STATUSES = ['待认领', '进行中', '待验收', '已完成', '已退回', '已取消'] as const
const boardTasks = ref<BoardTask[]>([])
const boardLayout = ref<'kanban' | 'list'>('kanban')
const boardFilterStatus = ref('')
const boardFilterTag = ref('')
const boardFilterForge = ref('')
const selectedTaskId = ref<string | null>(null)
const flashedTaskId = ref<string | null>(null)
const boardDetailActionMessage = ref('')
const workbenchPane = ref<WorkbenchPane>('board')
const statsCompletedDisplay = ref(0)
let statsCountRaf = 0
const statsCountStarted = ref(false)

const auditEvents = ref<EventRow[]>([])
const auditFilterType = ref('')
const auditFilterActor = ref('')
const auditFilterTask = ref('')
const auditFilterFrom = ref('')
const auditFilterTo = ref('')
const stats = ref<StatsBody | null>(null)

const trustedAutomation = ref(false)
const claimConfirmations = ref<ClaimConfirmationRow[]>([])

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

const boardStatusFilterOptions = [
  { label: '全部', value: '' },
  ...BOARD_STATUSES.map((status) => ({ label: status, value: status })),
]

const boardForgeFilterOptions = [{ label: '全部', value: '' }, ...forgeOptions]

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

const providerLabel = computed(() => {
  const provider = me.value?.provider
  if (provider === 'github') return 'GitHub'
  if (provider === 'gitlab') return 'GitLab'
  if (provider === 'gitea') return 'Gitea'
  return provider ?? ''
})

const navItems = computed(() => {
  const items: { id: WorkbenchPane; label: string; testid: string }[] = [
    { id: 'board', label: '看板', testid: 'workbench-nav-board' },
  ]
  if (canApprove.value) {
    items.push({ id: 'publish', label: '发布', testid: 'workbench-nav-publish' })
  }
  items.push(
    { id: 'keys', label: '钥匙', testid: 'workbench-nav-keys' },
    { id: 'audit', label: '审计', testid: 'workbench-nav-audit' },
  )
  return items
})

const navCurrentIndex = computed(() => {
  const index = navItems.value.findIndex((item) => item.id === workbenchPane.value)
  return index < 0 ? 0 : index
})

const taskProfileOptions = computed(() =>
  profiles.value.map((profile) => ({
    label: `${profile.forge} ${profile.repo_full_name}`,
    value: profile.id,
  })),
)

const listedIssueOptions = computed(() =>
  listedIssues.value.map((issue) => ({
    label: `#${issue.number} ${issue.title}`,
    value: issue.issue_url,
  })),
)

const boardTagFilterOptions = computed(() => {
  const seen = new Set<string>()
  const fromList: { label: string; value: string }[] = []
  for (const task of boardTasks.value) {
    for (const tag of task.tags) {
      if (!seen.has(tag)) {
        seen.add(tag)
        fromList.push({ label: tag, value: tag })
      }
    }
  }
  return [{ label: '全部', value: '' }, ...fromList]
})

const filteredBoardTasks = computed(() =>
  boardTasks.value.filter((task) => {
    if (boardFilterStatus.value !== '' && task.status !== boardFilterStatus.value) return false
    if (boardFilterTag.value !== '' && !task.tags.includes(boardFilterTag.value)) return false
    if (boardFilterForge.value !== '' && task.repo.forge !== boardFilterForge.value) return false
    return true
  }),
)

const selectedTask = computed(() => {
  if (selectedTaskId.value == null) return null
  return boardTasks.value.find((task) => task.id === selectedTaskId.value) ?? null
})

const currentKanbanStatus = computed(() => {
  if (selectedTask.value != null) return selectedTask.value.status
  if (boardFilterStatus.value !== '') return boardFilterStatus.value
  return '待认领'
})

const canPosterCancel = computed(() => {
  const task = selectedTask.value
  const user = me.value
  if (task == null || user == null) return false
  if (!canApprove.value) return false
  if (user.username !== task.poster) return false
  return task.status === '待认领' || task.status === '已退回'
})

const canPosterReopen = computed(() => {
  const task = selectedTask.value
  const user = me.value
  if (task == null || user == null) return false
  if (!canApprove.value) return false
  if (user.username !== task.poster) return false
  return task.status === '已退回'
})

const auditTypeFilterOptions = computed(() => [
  { label: '全部', value: '' },
  ...LIVE_EVENT_TYPES.map((type) => ({ label: type, value: type })),
])

const auditActorFilterOptions = computed(() => {
  const seen = new Set<string>()
  const fromEvents: { label: string; value: string }[] = []
  for (const row of auditEvents.value) {
    if (row.actor_username != null && !seen.has(row.actor_username)) {
      seen.add(row.actor_username)
      fromEvents.push({ label: row.actor_username, value: row.actor_username })
    }
  }
  return [
    { label: '全部', value: '' },
    { label: SYSTEM_ACTOR_LABEL, value: SYSTEM_ACTOR_LABEL },
    ...fromEvents,
  ]
})

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function defaultBaseUrl(forge: ForgeKind): string {
  if (forge === 'github') return 'https://github.com'
  if (forge === 'gitlab') return 'https://gitlab.com'
  return ''
}

function applyForgeBaseUrl(forge: ForgeKind, current: string): string {
  if (current.trim() !== '') return current
  return defaultBaseUrl(forge)
}

watch(profileForge, (forge) => {
  profileBaseUrl.value = applyForgeBaseUrl(forge, profileBaseUrl.value)
})

watch(taskForge, (forge) => {
  if (taskCredentialMode.value === 'profile') return
  taskBaseUrl.value = applyForgeBaseUrl(forge, taskBaseUrl.value)
})

function asTaskForge(forge: string): ForgeKind {
  if (forge === 'github' || forge === 'gitlab' || forge === 'gitea') return forge
  return 'gitlab'
}

function resetListedIssues() {
  listedIssuesRequest += 1
  listedIssues.value = []
  taskIssueUrl.value = ''
}

function applySelectedProfile() {
  if (taskCredentialMode.value !== 'profile') return
  const id = taskCredentialProfileId.value
  if (typeof id !== 'number') return
  const profile = profiles.value.find((row) => row.id === id)
  if (profile == null) return
  taskForge.value = asTaskForge(profile.forge)
  taskBaseUrl.value = profile.base_url
  taskRepo.value = profile.repo_full_name
}

function parseListedIssues(body: Record<string, unknown> | null): ListedIssue[] {
  if (body == null || !Array.isArray(body.issues)) return []
  const issues: ListedIssue[] = []
  for (const item of body.issues) {
    if (item == null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (
      typeof row.number !== 'number' ||
      typeof row.title !== 'string' ||
      typeof row.issue_url !== 'string'
    ) {
      continue
    }
    issues.push({ number: row.number, title: row.title, issue_url: row.issue_url })
  }
  return issues
}

async function loadListedIssues(profileId: number) {
  const request = ++listedIssuesRequest
  try {
    const res = await fetch(`/api/v1/credential-profiles/${profileId}/issues`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    const body = await readJson(res)
    if (request !== listedIssuesRequest) return
    listedIssues.value = res.ok ? parseListedIssues(body) : []
  } catch {
    if (request !== listedIssuesRequest) return
    listedIssues.value = []
  }
}

watch(
  [taskSourceType, taskCredentialMode, taskCredentialProfileId],
  () => {
    resetListedIssues()
    applySelectedProfile()
    if (taskSourceType.value !== 'imported') return
    if (taskCredentialMode.value !== 'profile') return
    if (profiles.value.length === 0) return
    const id = taskCredentialProfileId.value
    if (typeof id !== 'number') return
    void loadListedIssues(id)
  },
)

profileBaseUrl.value = applyForgeBaseUrl(profileForge.value, profileBaseUrl.value)
taskBaseUrl.value = applyForgeBaseUrl(taskForge.value, taskBaseUrl.value)

watch(canApprove, (ok) => {
  if (!ok && workbenchPane.value === 'publish') workbenchPane.value = 'board'
})

function auditRowTaskId(row: EventRow): string | undefined {
  const taskId = row.details?.task_id
  return typeof taskId === 'string' ? taskId : undefined
}

function auditRowDetailsText(row: EventRow): string {
  try {
    return JSON.stringify(row.details ?? {})
  } catch {
    return ''
  }
}

const filteredAuditEvents = computed(() =>
  auditEvents.value.filter((row) => {
    if (auditFilterType.value !== '' && row.type !== auditFilterType.value) return false
    if (auditFilterActor.value !== '') {
      if (auditFilterActor.value === SYSTEM_ACTOR_LABEL) {
        if (row.actor_user_id != null) return false
      } else if (row.actor_username !== auditFilterActor.value) {
        return false
      }
    }
    const taskFilter = auditFilterTask.value.trim()
    if (taskFilter !== '' && auditRowTaskId(row) !== taskFilter) return false
    const from = auditFilterFrom.value.trim()
    if (from !== '' && row.created_at < from) return false
    const to = auditFilterTo.value.trim()
    if (to !== '' && row.created_at > to) return false
    return true
  }),
)

const statsByUsername = computed(() => {
  const map = stats.value?.completed_by_username ?? {}
  return Object.entries(map).map(([username, count]) => ({ username, count }))
})

function formatLastUsed(value: number | null): string {
  if (value == null) return '从未使用'
  return `最近使用 ${new Date(value * 1000).toLocaleString('zh-CN')}`
}

function tasksForColumn(status: string): BoardTask[] {
  return filteredBoardTasks.value.filter((task) => task.status === status)
}

function openBoardDetail(id: string) {
  selectedTaskId.value = id
  boardDetailActionMessage.value = ''
}

function closeBoardDetail() {
  selectedTaskId.value = null
  boardDetailActionMessage.value = ''
}

function credentialChrome(credential: BoardTask['credential']): string {
  if ('inline' in credential && credential.inline === true) return '单任务临时 token'
  return '共享档案'
}

function boardIssueUrl(task: BoardTask): string | null {
  return task.source.type === 'imported' ? task.source.issue_url : null
}

function boardIssueUrlIsHttp(task: BoardTask): boolean {
  const url = boardIssueUrl(task)
  if (url == null) return false
  const lower = url.trim().toLowerCase()
  return lower.startsWith('https:') || lower.startsWith('http:')
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function toDatetimeLocalValue(iso: string): string {
  const trimmed = iso.trim()
  if (trimmed === '') return ''
  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromDatetimeLocalValue(value: string): string {
  if (value === '') return ''
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return ''
  return new Date(ms).toISOString()
}

function onAuditFromPicker(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  auditFilterFrom.value = fromDatetimeLocalValue(target.value)
}

function onAuditToPicker(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  auditFilterTo.value = fromDatetimeLocalValue(target.value)
}

function onRipple(event: MouseEvent) {
  if (prefersReducedMotion()) return
  const el = event.currentTarget
  if (!(el instanceof HTMLElement)) return
  const rect = el.getBoundingClientRect()
  el.style.setProperty('--ripple-x', `${event.clientX - rect.left}px`)
  el.style.setProperty('--ripple-y', `${event.clientY - rect.top}px`)
  el.classList.remove('is-rippling')
  void el.offsetWidth
  el.classList.add('is-rippling')
  window.setTimeout(() => {
    el.classList.remove('is-rippling')
  }, 400)
}

function slideOutRow(event: Event, dir: 'left' | 'right') {
  if (prefersReducedMotion()) return
  const row = (event.currentTarget as HTMLElement | null)?.closest('.claim-row')
  if (!(row instanceof HTMLElement)) return
  const x = dir === 'right' ? '28px' : '-28px'
  row.classList.add(dir === 'right' ? 'is-approve' : 'is-reject')
  if (typeof row.animate === 'function') {
    row.animate(
      [
        { transform: 'translateX(0)', opacity: 1 },
        { transform: `translateX(${x})`, opacity: 0 },
      ],
      { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' },
    )
  }
}

function asCredential(
  value: unknown,
  fallback: BoardTask['credential'],
): BoardTask['credential'] {
  if (value != null && typeof value === 'object') {
    const credential = value as { inline?: unknown; profile_id?: unknown }
    if (credential.inline === true) return { inline: true }
    if (typeof credential.profile_id === 'string') return { profile_id: credential.profile_id }
    if (typeof credential.profile_id === 'number') return { profile_id: String(credential.profile_id) }
  }
  return fallback
}

function asBoardTask(raw: Record<string, unknown>, fallback?: BoardTask): BoardTask | null {
  const id = typeof raw.id === 'string' ? raw.id : fallback?.id
  if (id == null) return null
  const repoRaw = raw.repo
  let forge = fallback?.repo.forge ?? ''
  if (repoRaw != null && typeof repoRaw === 'object') {
    const repoForge = (repoRaw as { forge?: unknown }).forge
    if (typeof repoForge === 'string') forge = repoForge
  }
  let source: BoardTask['source'] = fallback?.source ?? { type: 'native' }
  if (raw.source != null && typeof raw.source === 'object') {
    const src = raw.source as { type?: unknown; issue_url?: unknown }
    if (src.type === 'imported' && typeof src.issue_url === 'string') {
      source = { type: 'imported', issue_url: src.issue_url }
    } else if (src.type === 'native') {
      source = { type: 'native' }
    }
  }
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === 'string')
    : (fallback?.tags ?? [])
  return {
    id,
    title: typeof raw.title === 'string' ? raw.title : (fallback?.title ?? ''),
    description_md:
      typeof raw.description_md === 'string' ? raw.description_md : (fallback?.description_md ?? ''),
    source,
    repo: { forge },
    tags,
    poster: typeof raw.poster === 'string' ? raw.poster : (fallback?.poster ?? ''),
    status: typeof raw.status === 'string' ? raw.status : (fallback?.status ?? ''),
    created_at: typeof raw.created_at === 'string' ? raw.created_at : (fallback?.created_at ?? ''),
    credential: asCredential(raw.credential, fallback?.credential ?? { inline: true }),
    priority: typeof raw.priority === 'string' ? raw.priority : fallback?.priority,
  }
}

function applyBriefUpdate(body: Record<string, unknown>) {
  const id = typeof body.id === 'string' ? body.id : selectedTaskId.value
  if (id == null) return
  const index = boardTasks.value.findIndex((task) => task.id === id)
  if (index < 0) return
  const next = asBoardTask(body, boardTasks.value[index])
  if (next != null) boardTasks.value[index] = next
}

function animateStatsCount(target: number) {
  if (statsCountRaf !== 0) cancelAnimationFrame(statsCountRaf)
  if (prefersReducedMotion()) {
    statsCompletedDisplay.value = target
    statsCountStarted.value = true
    return
  }
  const from = statsCountStarted.value ? statsCompletedDisplay.value : 0
  statsCountStarted.value = true
  const started = performance.now()
  const duration = 380
  const tick = (now: number) => {
    const t = Math.min(1, (now - started) / duration)
    const eased = 1 - (1 - t) ** 3
    statsCompletedDisplay.value = Math.round(from + (target - from) * eased)
    if (t < 1) statsCountRaf = requestAnimationFrame(tick)
    else statsCompletedDisplay.value = target
  }
  statsCountRaf = requestAnimationFrame(tick)
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
      trustedAutomation.value = me.value?.trusted_automation === true
    } else {
      me.value = null
    }
  } catch {
    me.value = null
  } finally {
    loaded.value = true
  }
  if (view.value === 'member') {
    await loadTasks()
    await loadEvents()
    await loadStats()
  }
  if (canManageKeys.value) {
    await loadAgentKeys()
    await loadClaimConfirmations()
  }
  if (canApprove.value) {
    await loadProfiles()
  }
})

async function setTrustedAutomation(value: boolean) {
  try {
    const res = await fetch('/api/v1/me/settings', {
      method: 'PUT',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ trusted_automation: value }),
    })
    if (!res.ok) return
    const body = await readJson(res)
    if (typeof body?.trusted_automation === 'boolean') {
      trustedAutomation.value = body.trusted_automation
    }
  } catch {
    // keep whatever value was already shown
  }
}

async function loadClaimConfirmations() {
  try {
    const res = await fetch('/api/v1/claim-confirmations', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const body = await readJson(res)
    claimConfirmations.value = Array.isArray(body?.confirmations)
      ? (body.confirmations as ClaimConfirmationRow[])
      : []
  } catch {
    claimConfirmations.value = []
  }
}

async function approveClaimConfirmation(id: number, event?: Event) {
  if (event) slideOutRow(event, 'right')
  try {
    const res = await fetch(`/api/v1/claim-confirmations/${id}/approve`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (res.ok) await loadClaimConfirmations()
  } catch {
    // ignore
  }
}

async function rejectClaimConfirmation(id: number, event?: Event) {
  if (event) slideOutRow(event, 'left')
  try {
    const res = await fetch(`/api/v1/claim-confirmations/${id}/reject`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (res.ok) await loadClaimConfirmations()
  } catch {
    // ignore
  }
}

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

async function loadTasks() {
  try {
    const res = await fetch('/api/v1/tasks', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const body = await readJson(res)
    boardTasks.value = Array.isArray(body?.tasks) ? (body.tasks as BoardTask[]) : []
  } catch {
    boardTasks.value = []
  }
}

async function loadEvents() {
  try {
    const res = await fetch('/api/v1/events', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const body = await readJson(res)
    auditEvents.value = Array.isArray(body?.events) ? (body.events as EventRow[]) : []
  } catch {
    auditEvents.value = []
  }
}

async function loadStats() {
  try {
    const res = await fetch('/api/v1/stats', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const body = await readJson(res)
    if (
      body != null &&
      typeof body.completed_count === 'number' &&
      body.completed_by_username != null &&
      typeof body.completed_by_username === 'object'
    ) {
      stats.value = body as unknown as StatsBody
      animateStatsCount(body.completed_count)
    }
  } catch {
    // keep whatever stats were already loaded
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

async function patchTaskStatus(status: '已取消' | '待认领') {
  const task = selectedTask.value
  if (task == null) return
  boardDetailActionMessage.value = ''
  try {
    const res = await fetch(`/api/v1/tasks/${task.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    const body = await readJson(res)
    if (!res.ok) {
      boardDetailActionMessage.value =
        typeof body?.message === 'string' ? body.message : `操作失败（${res.status}）`
      return
    }
    if (body != null) applyBriefUpdate(body)
  } catch {
    boardDetailActionMessage.value = '操作失败'
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
    if (body != null) {
      const created = asBoardTask(body)
      if (created != null) {
        boardTasks.value = [created, ...boardTasks.value.filter((task) => task.id !== created.id)]
        flashedTaskId.value = created.id
        window.setTimeout(() => {
          if (flashedTaskId.value === created.id) flashedTaskId.value = null
        }, 700)
      }
    }
  } catch {
    taskOk.value = false
    taskMessage.value = '发布请求失败'
  } finally {
    taskCreating.value = false
  }
}

async function importTask() {
  const credential =
    taskCredentialMode.value === 'inline'
      ? { token: taskCredentialToken.value }
      : { profile_id: taskCredentialProfileId.value as number }

  taskMessage.value = ''
  taskOk.value = false
  try {
    const res = await fetch('/api/v1/tasks/import', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        issue_url: taskIssueUrl.value.trim(),
        repo: { forge: taskForge.value, base_url: taskBaseUrl.value.trim() },
        credential,
      }),
    })
    const body = await readJson(res)
    if (!res.ok) {
      taskMessage.value =
        typeof body?.message === 'string' ? body.message : `导入失败（${res.status}）`
      return
    }
    if (typeof body?.title === 'string') taskTitle.value = body.title
    if (typeof body?.description_md === 'string') taskDescription.value = body.description_md
    const repo = body?.repo
    if (repo != null && typeof repo === 'object') {
      const fullName = (repo as { full_name?: unknown }).full_name
      if (typeof fullName === 'string') taskRepo.value = fullName
    }
    taskSourceType.value = 'imported'
  } catch {
    taskMessage.value = '导入请求失败'
  }
}
</script>

<style src="./theme.css"></style>
