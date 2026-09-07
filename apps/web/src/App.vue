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
          <n-card :title="setupComplete ? '登录' : '初始向导'" v-if="view === 'login'" class="gate-card">
            <n-space v-if="!setupComplete" vertical>
              <n-text>创建本地管理员账号（用户名与密码）。</n-text>
              <n-input v-model:value="setupUsername" placeholder="用户名" />
              <n-input v-model:value="setupPassword" type="password" show-password-on="click" placeholder="密码" />
              <n-button
                class="has-ripple primary-fill"
                type="primary"
                :loading="authSubmitting"
                @pointerdown="onRipple"
                @click="submitSetup"
              >创建管理员</n-button>
              <n-text v-if="authMessage" type="error">{{ authMessage }}</n-text>
            </n-space>
            <n-space v-else vertical>
              <n-text>使用本地密码或 GitLab / Gitea 账号登录。</n-text>
              <n-input v-model:value="loginUsername" placeholder="用户名" />
              <n-input v-model:value="loginPassword" type="password" show-password-on="click" placeholder="密码" />
              <n-button
                class="has-ripple primary-fill"
                type="primary"
                :loading="authSubmitting"
                @pointerdown="onRipple"
                @click="submitLogin"
              >登录</n-button>
              <n-text v-if="authMessage" type="error">{{ authMessage }}</n-text>
              <n-space>
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
                            <n-text
                              v-if="columnSubtitle(status) !== ''"
                              class="board-column-subtitle"
                              depth="3"
                              :title="columnSubtitle(status)"
                            >{{ columnSubtitle(status) }}</n-text>
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
                              <span v-if="taskRoundText(task) !== ''" class="slip-meta">{{ taskRoundText(task) }}</span>
                              <span v-if="taskParentText(task) !== ''" class="slip-meta">{{ taskParentText(task) }}</span>
                              <span v-if="taskProgressText(task.id) !== ''" class="slip-meta">{{ taskProgressText(task.id) }}</span>
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
                            <span v-if="taskRoundText(task) !== ''" class="slip-meta">{{ taskRoundText(task) }}</span>
                            <span v-if="taskParentText(task) !== ''" class="slip-meta">{{ taskParentText(task) }}</span>
                            <span v-if="taskProgressText(task.id) !== ''" class="slip-meta">{{ taskProgressText(task.id) }}</span>
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
                          <div data-testid="review-panel" class="review-panel">
                            <n-text strong>评审</n-text>
                            <n-text
                              v-if="!reviewPanelApplies"
                              data-testid="review-empty"
                              class="empty-copy"
                            >尚未提交 PR，暂无评审</n-text>
                            <template v-else>
                              <div data-testid="review-header" class="review-header">
                                <span v-if="reviewPrUrl !== ''" data-testid="review-pr-url">
                                  <a
                                    v-if="reviewPrUrlIsHttp"
                                    :href="reviewPrUrl"
                                    target="_blank"
                                    rel="noreferrer noopener"
                                  >{{ reviewPrUrl }}</a>
                                  <template v-else>{{ reviewPrUrl }}</template>
                                </span>
                                <span v-if="reviewHeadShaShort !== ''" data-testid="review-head-sha">
                                  <code>{{ reviewHeadShaShort }}</code>
                                </span>
                                <span data-testid="review-round">第 {{ reviewRoundNumber }} 轮</span>
                                <span data-testid="review-ball">球在谁手里：{{ reviewBallLabel }}</span>
                              </div>
                              <n-text
                                v-if="reviewActionMessage"
                                data-testid="review-action-message"
                                class="task-fail"
                              >{{ reviewActionMessage }}</n-text>
                              <n-space v-if="canReviewAct" data-testid="review-actions" class="review-actions">
                                <n-button
                                  v-if="selectedTask.status === '待验收'"
                                  data-testid="review-submit-round"
                                  class="has-ripple primary-fill"
                                  type="primary"
                                  :loading="reviewActing"
                                  @pointerdown="onRipple"
                                  @click="runReviewAction('rounds')"
                                >提交本轮意见</n-button>
                                <n-button
                                  v-if="selectedTask.status === '待验收'"
                                  data-testid="review-approve"
                                  class="has-ripple"
                                  :loading="reviewActing"
                                  @pointerdown="onRipple"
                                  @click="runReviewAction('approve')"
                                >通过</n-button>
                                <n-button
                                  v-if="selectedTask.status === '待合并'"
                                  data-testid="review-withdraw"
                                  class="has-ripple"
                                  :loading="reviewActing"
                                  @pointerdown="onRipple"
                                  @click="runReviewAction('withdraw')"
                                >撤回通过</n-button>
                                <n-button
                                  v-if="reviewActionsApply"
                                  data-testid="review-terminate"
                                  class="has-ripple"
                                  :loading="reviewActing"
                                  @pointerdown="onRipple"
                                  @click="runReviewAction('terminate')"
                                >终止本次交付</n-button>
                              </n-space>
                              <div data-testid="review-thread" class="review-thread">
                                <n-text v-if="reviewGroups.length === 0" class="empty-copy">暂无评审意见。</n-text>
                                <div
                                  v-for="group in reviewGroups"
                                  :key="group.key"
                                  :data-testid="'review-group-' + group.key"
                                  class="review-group"
                                >
                                  <n-text strong class="review-group-label">{{ group.label }}</n-text>
                                  <div
                                    v-for="message in group.messages"
                                    :key="message.id"
                                    :data-testid="'review-message-' + message.id"
                                    class="review-message"
                                  >
                                    <span class="review-badges">
                                      <span class="review-badge">{{ reviewAuthorLabel(message.author_kind) }}</span>
                                      <span class="review-badge">{{ reviewKindLabel(message.kind) }}</span>
                                      <span v-if="message.resolved" class="review-badge">已解决</span>
                                    </span>
                                    <div class="review-body">{{ message.body_md }}</div>
                                    <div
                                      v-if="message.anchor != null"
                                      :data-testid="'review-anchor-' + message.id"
                                      class="review-anchor"
                                    >
                                      <a
                                        v-if="anchorIsHttp(message.anchor)"
                                        :href="message.anchor.url"
                                        target="_blank"
                                        rel="noreferrer noopener"
                                      >{{ anchorLabel(message.anchor) }}</a>
                                      <template v-else>{{ anchorLabel(message.anchor) }}</template>
                                    </div>
                                  </div>
                                </div>
                              </div>
                              <n-space
                                v-if="canReviewAct"
                                data-testid="review-composer"
                                class="review-composer"
                                vertical
                              >
                                <n-input
                                  data-testid="review-composer-body"
                                  type="textarea"
                                  v-model:value="reviewComposerBody"
                                  placeholder="写一条评审意见"
                                />
                                <n-select
                                  data-testid="review-composer-kind"
                                  v-model:value="reviewComposerKind"
                                  :options="reviewKindOptions"
                                  style="width: 140px"
                                />
                                <n-input
                                  data-testid="review-composer-anchor"
                                  v-model:value="reviewComposerAnchor"
                                  placeholder="代码锚点（可选）：粘贴 forge 文件链接"
                                />
                                <n-button
                                  data-testid="review-composer-send"
                                  class="has-ripple primary-fill"
                                  type="primary"
                                  :loading="reviewSending"
                                  @pointerdown="onRipple"
                                  @click="sendReviewMessage"
                                >发送</n-button>
                              </n-space>
                            </template>
                          </div>
                        </n-space>
                      </div>
                    </div>
                  </n-space>
                </div>
              </div>

              <div
                v-if="canPublish"
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
                    <div v-if="showImportedIssueCard" data-testid="task-import-card">
                      <n-text data-testid="task-import-source-label">导入内容</n-text>
                      <div data-testid="task-import-card-title">{{ taskTitle }}</div>
                      <div data-testid="task-import-card-body">{{ taskDescription }}</div>
                      <div data-testid="task-import-card-url">
                        <a
                          v-if="importedIssueUrlIsHttp"
                          :href="taskImportIssueUrl"
                        >{{ taskImportIssueUrl }}</a>
                        <template v-else>{{ taskImportIssueUrl }}</template>
                      </div>
                    </div>
                    <template v-else>
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
                    </template>
                    <n-form-item label="拆为子任务">
                      <n-select
                        data-testid="task-parent"
                        v-model:value="taskParentId"
                        :options="taskParentOptions"
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
                  <n-divider v-if="canManageInstance">受信自动化</n-divider>
                  <n-space v-if="canManageInstance" vertical>
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

                  <n-divider v-if="canManageInstance">我的电脑</n-divider>
                  <div v-if="canManageInstance" data-testid="devices-mine">
                    <n-space vertical>
                      <n-text strong>我的电脑</n-text>
                      <n-text v-if="mineDevices.length === 0" class="empty-copy">暂无已绑定的电脑。</n-text>
                      <n-space
                        v-for="device in mineDevices"
                        :key="device.id"
                        class="claim-row"
                        align="center"
                      >
                        <n-text>
                          {{ device.hostname }} · {{ device.fingerprint }} · {{ device.expires_at }}
                        </n-text>
                        <n-button
                          data-testid="device-revoke"
                          class="has-ripple"
                          size="small"
                          @pointerdown="onRipple"
                          @click="revokeDevice(device.id)"
                        >解除这台电脑</n-button>
                      </n-space>
                    </n-space>
                  </div>

                  <n-divider v-if="canManageInstance">待授权电脑</n-divider>
                  <div v-if="canManageInstance" data-testid="devices-pending">
                    <n-space vertical>
                      <n-text strong>待授权电脑</n-text>
                      <n-text v-if="pendingDevices.length === 0" class="empty-copy">暂无待授权电脑。</n-text>
                      <n-space
                        v-for="device in pendingDevices"
                        :key="device.id"
                        class="claim-row"
                        align="center"
                      >
                        <n-text>
                          {{ device.hostname }} · {{ device.fingerprint }} · {{ device.expires_at }}
                        </n-text>
                      </n-space>
                      <template v-if="pendingDevices.length > 0">
                        <n-space class="keys-inline" align="center">
                          <n-input
                            data-testid="device-bind-claimant-name"
                            v-model:value="bindClaimantName"
                            placeholder="认领者显示名"
                            style="width: 220px"
                          />
                          <n-select
                            data-testid="device-bind-claimant-select"
                            v-model:value="bindClaimantId"
                            :options="claimantSelectOptions"
                            clearable
                            placeholder="选择已有认领者"
                            style="width: 220px"
                          />
                          <n-button
                            data-testid="device-bind-submit"
                            class="has-ripple primary-fill"
                            type="primary"
                            :loading="deviceBinding"
                            @pointerdown="onRipple"
                            @click="submitBindClaimant"
                          >绑定</n-button>
                          <n-button
                            data-testid="device-bind-self"
                            class="has-ripple"
                            :loading="deviceBinding"
                            @pointerdown="onRipple"
                            @click="bindDeviceToSelf"
                          >绑到我自己</n-button>
                        </n-space>
                        <n-text v-if="claimants.length === 0" class="empty-copy">
                          暂无认领者，请输入显示名新建。
                        </n-text>
                      </template>
                      <n-text v-if="deviceBindMessage" :type="deviceBindOk ? 'success' : 'error'">
                        {{ deviceBindMessage }}
                      </n-text>
                    </n-space>
                  </div>

                  <n-divider v-if="canManageInstance">认领者</n-divider>
                  <div v-if="canManageInstance" data-testid="claimants-list">
                    <n-space vertical>
                      <n-text strong>认领者</n-text>
                      <n-text v-if="claimants.length === 0" class="empty-copy">暂无认领者。</n-text>
                      <n-space
                        v-for="claimant in claimants"
                        :key="claimant.id"
                        class="claim-row"
                        align="center"
                      >
                        <n-text>{{ claimant.display_name }}</n-text>
                        <n-button
                          data-testid="claimant-revoke"
                          class="has-ripple"
                          size="small"
                          @pointerdown="onRipple"
                          @click="revokeClaimant(claimant.id)"
                        >解除认领者</n-button>
                      </n-space>
                    </n-space>
                  </div>

                  <n-divider v-if="canManageInstance">升级</n-divider>
                  <div v-if="canManageInstance" data-testid="users-promote">
                    <n-space vertical>
                      <n-text strong>升级为管理员</n-text>
                      <n-text v-if="listedUsers.length === 0" class="empty-copy">暂无用户。</n-text>
                      <n-space
                        v-for="user in listedUsers"
                        :key="user.id"
                        data-testid="user-row"
                        class="claim-row"
                        align="center"
                      >
                        <n-text>
                          {{ user.display_name }}（{{ user.username }}）· {{ user.provider }} · {{ user.permission_level }}
                        </n-text>
                        <n-button
                          v-if="userCanPromote(user)"
                          data-testid="user-promote"
                          class="has-ripple"
                          size="small"
                          @pointerdown="onRipple"
                          @click="promoteUser(user.id)"
                        >升级为管理员</n-button>
                      </n-space>
                    </n-space>
                  </div>

                  <n-divider v-if="canPublish">凭证档案</n-divider>
                  <n-space v-if="canPublish" vertical>
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
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { dateZhCN, zhCN } from 'naive-ui'
import './theme.css'
import { ensureRootTokens, themeOverrides } from './theme'
import { parseAnchorLink } from './review-anchor'

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

type DeviceRow = {
  id: number
  hostname: string
  fingerprint: string
  status?: string
  created_at: string
  paired_at?: string | null
  expires_at: string
  last_seen?: string | null
}

type ClaimantRow = {
  id: number
  display_name: string
  status: string
  device_max_age_days: number
  max_devices: number
  device_idle_days: number
}

type ListedUser = {
  id: number
  provider: string
  username: string
  display_name: string
  status: string
  permission_level: string
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
  parent_task_id?: string | null
  review_round?: number
}

// 评审面板（#53）。只保留界面真正渲染的字段：reply_to / resolves 不上屏，就不进客户端模型。
type ReviewAnchor = { path?: string; line?: number; head_sha?: string; url?: string }

type ReviewMessage = {
  id: number
  round: number | null
  author_kind: string
  kind: string
  body_md: string
  anchor: ReviewAnchor | null
  resolved: boolean
  created_at: string
}

type ReviewRound = {
  round: number
  kind: string
  verdict: string | null
}

type ReviewBody = {
  task_id: string
  status: string
  pr_url: string | null
  head_sha: string | null
  round: number
  rounds: ReviewRound[]
  messages: ReviewMessage[]
}

type TaskProgress = { percent: number | null; phase: string | null }

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

// 评审面板只在任务已经有过 PR 的状态里出现；待认领 / 进行中 不请求 GET …/review。
const REVIEW_PANEL_STATUSES = ['待验收', '待修改', '待合并', '已完成', '已退回']
// 评审者可以动手的三个状态（docs/api.md「Review loop REST」）。
const REVIEW_ACTION_STATUSES = ['待验收', '待修改', '待合并']
const REVIEW_BALL_LABELS: Record<string, string> = {
  待验收: '评审者',
  待修改: 'Agent',
  待合并: '等 forge 合并',
  已完成: '已合并',
  已退回: '已退回',
}
const REVIEW_AUTHOR_LABELS: Record<string, string> = {
  reviewer: '评审者',
  agent: 'Agent',
  system: '系统',
  forge: 'forge',
}
const REVIEW_KIND_LABELS: Record<string, string> = {
  blocking: '阻塞',
  suggestion: '建议',
  question: '提问',
  answer: '回答',
  note: '备注',
  resolution: '已解决',
}
const REVIEW_VERDICT_LABELS: Record<string, string> = {
  changes_requested: '需修改',
  approved: '通过',
  withdrawn: '已撤回',
  terminated: '已终止',
}
// 服务端对这两个码不一定带 message（docs/api.md），界面必须自己有中文兜底。
const REVIEW_ERROR_MESSAGES: Record<string, string> = {
  no_pending_messages: '没有待提交的评审意见。',
  parent_not_completed: '父任务尚未完成，不能通过子任务。',
}
const REVIEW_TERMINATE_CONFIRM = '终止本次交付后任务会转为「已退回」，确定继续吗？'

const me = ref<Me | null>(null)
const loaded = ref(false)
const setupComplete = ref(true)
const setupUsername = ref('')
const setupPassword = ref('')
const loginUsername = ref('')
const loginPassword = ref('')
const authSubmitting = ref(false)
const authMessage = ref('')

const mineDevices = ref<DeviceRow[]>([])
const pendingDevices = ref<DeviceRow[]>([])
const claimants = ref<ClaimantRow[]>([])
const listedUsers = ref<ListedUser[]>([])
const bindClaimantName = ref('')
const bindClaimantId = ref<number | null>(null)
const deviceBinding = ref(false)
const deviceBindMessage = ref('')
const deviceBindOk = ref(false)

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
const taskImportReady = ref(false)
const taskImportIssueUrl = ref('')
const taskCredentialMode = ref<'profile' | 'inline'>('profile')
const taskCredentialProfileId = ref<number | null>(null)
const taskCredentialToken = ref('')
const listedIssues = ref<ListedIssue[]>([])
let listedIssuesRequest = 0
const taskParentId = ref('')
const taskCreating = ref(false)
const taskMessage = ref('')
const taskOk = ref(false)
const taskCredentialFeedback = ref('')

const BOARD_STATUSES = [
  '待认领',
  '进行中',
  '待验收',
  '待修改',
  '待合并',
  '已完成',
  '已退回',
  '已取消',
] as const

// 只有 #53 新增的三列带球权语义（docs/DESIGN.md §5「看板列语义」），其余列没有副标题。
const BOARD_COLUMN_SUBTITLES: Record<string, string> = {
  待验收: '球在评审者手里',
  待修改: '球在 Agent 手里 · 可认领',
  待合并: '等 forge 合并',
}
const boardTasks = ref<BoardTask[]>([])
const boardLayout = ref<'kanban' | 'list'>('kanban')
const boardFilterStatus = ref('')
const boardFilterTag = ref('')
const boardFilterForge = ref('')
const selectedTaskId = ref<string | null>(null)
const flashedTaskId = ref<string | null>(null)
const boardDetailActionMessage = ref('')
const taskProgress = ref<Record<string, TaskProgress>>({})
const review = ref<ReviewBody | null>(null)
const reviewActionMessage = ref('')
const reviewActing = ref(false)
const reviewSending = ref(false)
const reviewComposerBody = ref('')
const reviewComposerKind = ref('blocking')
const reviewComposerAnchor = ref('')
let reviewRequest = 0
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

const credentialModeOptions = [
  { label: '共享档案', value: 'profile' },
  { label: '单任务临时 token', value: 'inline' },
]

const boardStatusFilterOptions = [
  { label: '全部', value: '' },
  ...BOARD_STATUSES.map((status) => ({ label: status, value: status })),
]

const boardForgeFilterOptions = [{ label: '全部', value: '' }, ...forgeOptions]

// 评审者只写这四种；answer / resolution 是 Agent 侧 MCP 的 kind。
const reviewKindOptions = [
  { label: '阻塞', value: 'blocking' },
  { label: '建议', value: 'suggestion' },
  { label: '提问', value: 'question' },
  { label: '备注', value: 'note' },
]

const view = computed(() => {
  if (!loaded.value || me.value == null) return 'login'
  if (me.value.status === '待批准') return 'pending'
  return 'member'
})

const canPublish = computed(
  () =>
    me.value?.status === 'active' &&
    (me.value?.permission_level === 'admin' || me.value?.permission_level === 'full'),
)

const canManageInstance = computed(
  () => me.value?.status === 'active' && me.value?.permission_level === 'admin',
)

const permissionLabel = computed(() => {
  if (me.value?.permission_level === 'admin') return '管理员'
  if (me.value?.permission_level === 'full') return '发布者'
  return '仅认领'
})

const providerLabel = computed(() => {
  const provider = me.value?.provider
  if (provider === 'github') return 'GitHub'
  if (provider === 'gitlab') return 'GitLab'
  if (provider === 'gitea') return 'Gitea'
  if (provider === 'local') return '本地'
  return provider ?? ''
})

const navItems = computed(() => {
  const items: { id: WorkbenchPane; label: string; testid: string }[] = [
    { id: 'board', label: '看板', testid: 'workbench-nav-board' },
  ]
  if (canPublish.value) {
    items.push({ id: 'publish', label: '发布', testid: 'workbench-nav-publish' })
  }
  items.push(
    { id: 'keys', label: '电脑', testid: 'workbench-nav-keys' },
    { id: 'audit', label: '审计', testid: 'workbench-nav-audit' },
  )
  return items
})

const navCurrentIndex = computed(() => {
  const index = navItems.value.findIndex((item) => item.id === workbenchPane.value)
  return index < 0 ? 0 : index
})

const claimantSelectOptions = computed(() =>
  claimants.value.map((claimant) => ({
    label: claimant.display_name,
    value: claimant.id,
  })),
)

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

// 父任务候选：已经在看板列表里的、未终态的任务（docs/DESIGN.md §17.4：父为终态直接 409）。
const taskParentOptions = computed(() => [
  { label: '无', value: '' },
  ...boardTasks.value
    .filter((task) => task.status !== '已完成' && task.status !== '已取消')
    .map((task) => ({ label: `${task.id} ${task.title}`, value: task.id })),
])

const showImportedIssueCard = computed(
  () => taskSourceType.value === 'imported' && taskImportReady.value,
)

const importedIssueUrlIsHttp = computed(() => urlLooksHttp(taskImportIssueUrl.value))

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

const reviewPanelApplies = computed(() => {
  const task = selectedTask.value
  return task != null && REVIEW_PANEL_STATUSES.includes(task.status)
})

const reviewActionsApply = computed(() => {
  const task = selectedTask.value
  return task != null && REVIEW_ACTION_STATUSES.includes(task.status)
})

// 评审者 = active 且 admin / full（canPublish，docs/DESIGN.md §17.2），且任务停在
// 待验收 / 待修改 / 待合并 —— 已完成 / 已退回 的面板只读。
const canReviewAct = computed(() => canPublish.value && reviewActionsApply.value)

const reviewPrUrl = computed(() => review.value?.pr_url ?? '')

const reviewPrUrlIsHttp = computed(() => urlLooksHttp(reviewPrUrl.value))

const reviewHeadShaShort = computed(() => (review.value?.head_sha ?? '').slice(0, 12))

const reviewRoundNumber = computed(() => review.value?.round ?? 0)

const reviewBallLabel = computed(() => {
  const status = selectedTask.value?.status ?? ''
  return REVIEW_BALL_LABELS[status] ?? status
})

// 轮次倒序，未归轮的「本轮草稿」永远排在最后。
const reviewGroups = computed(() => {
  const body = review.value
  if (body == null) return []
  const rounded = new Map<number, ReviewMessage[]>()
  const draft: ReviewMessage[] = []
  for (const message of body.messages) {
    if (message.round == null) {
      draft.push(message)
      continue
    }
    const bucket = rounded.get(message.round)
    if (bucket == null) rounded.set(message.round, [message])
    else bucket.push(message)
  }
  const groups: { key: string; label: string; messages: ReviewMessage[] }[] = []
  for (const round of [...rounded.keys()].sort((left, right) => right - left)) {
    groups.push({
      key: String(round),
      label: reviewRoundLabel(round),
      messages: rounded.get(round) ?? [],
    })
  }
  if (draft.length > 0) {
    groups.push({ key: 'draft', label: '本轮草稿（未提交）', messages: draft })
  }
  return groups
})

const canPosterCancel = computed(() => {
  const task = selectedTask.value
  const user = me.value
  if (task == null || user == null) return false
  if (!canPublish.value) return false
  if (user.username !== task.poster) return false
  return task.status === '待认领' || task.status === '已退回'
})

const canPosterReopen = computed(() => {
  const task = selectedTask.value
  const user = me.value
  if (task == null || user == null) return false
  if (!canPublish.value) return false
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

function clearImportedIssueCard() {
  taskImportReady.value = false
  taskImportIssueUrl.value = ''
}

watch(
  [taskSourceType, taskCredentialMode, taskCredentialProfileId],
  () => {
    resetListedIssues()
    applySelectedProfile()
    if (taskSourceType.value !== 'imported') {
      clearImportedIssueCard()
      return
    }
    if (taskCredentialMode.value !== 'profile') return
    if (profiles.value.length === 0) return
    const id = taskCredentialProfileId.value
    if (typeof id !== 'number') return
    void loadListedIssues(id)
  },
)

watch(taskIssueUrl, () => {
  clearImportedIssueCard()
})

profileBaseUrl.value = applyForgeBaseUrl(profileForge.value, profileBaseUrl.value)
taskBaseUrl.value = applyForgeBaseUrl(taskForge.value, taskBaseUrl.value)

watch(canPublish, (ok) => {
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

function columnSubtitle(status: string): string {
  return BOARD_COLUMN_SUBTITLES[status] ?? ''
}

function taskRoundText(task: BoardTask): string {
  const round = task.review_round ?? 0
  return round > 0 ? `第 ${round} 轮` : ''
}

function taskParentText(task: BoardTask): string {
  const parent = task.parent_task_id
  return parent == null || parent === '' ? '' : `子任务 · 父 ${parent}`
}

function taskProgressText(id: string): string {
  const progress = taskProgress.value[id]
  if (progress == null) return ''
  const parts: string[] = []
  if (progress.percent != null) parts.push(`${progress.percent}%`)
  if (progress.phase != null && progress.phase !== '') parts.push(progress.phase)
  return parts.join(' ')
}

function reviewAuthorLabel(authorKind: string): string {
  return REVIEW_AUTHOR_LABELS[authorKind] ?? authorKind
}

function reviewKindLabel(kind: string): string {
  return REVIEW_KIND_LABELS[kind] ?? kind
}

function reviewRoundLabel(round: number): string {
  const row = review.value?.rounds.find((candidate) => candidate.round === round)
  const verdict = row?.verdict == null ? undefined : REVIEW_VERDICT_LABELS[row.verdict]
  return verdict == null ? `第 ${round} 轮` : `第 ${round} 轮 · ${verdict}`
}

function anchorLabel(anchor: ReviewAnchor): string {
  if (anchor.path != null && anchor.path !== '') {
    return anchor.line == null ? anchor.path : `${anchor.path}:${anchor.line}`
  }
  return anchor.url ?? ''
}

function anchorIsHttp(anchor: ReviewAnchor): boolean {
  return anchor.url != null && urlLooksHttp(anchor.url)
}

function tasksForColumn(status: string): BoardTask[] {
  return filteredBoardTasks.value.filter((task) => task.status === status)
}

function openBoardDetail(id: string) {
  selectedTaskId.value = id
  boardDetailActionMessage.value = ''
  resetReviewComposer()
  review.value = null
  void refreshReviewPanel()
}

function closeBoardDetail() {
  selectedTaskId.value = null
  boardDetailActionMessage.value = ''
  resetReviewComposer()
  reviewRequest += 1
  review.value = null
  reviewActionMessage.value = ''
}

function credentialChrome(credential: BoardTask['credential']): string {
  if ('inline' in credential && credential.inline === true) return '单任务临时 token'
  return '共享档案'
}

function boardIssueUrl(task: BoardTask): string | null {
  return task.source.type === 'imported' ? task.source.issue_url : null
}

function urlLooksHttp(url: string): boolean {
  const lower = url.trim().toLowerCase()
  return lower.startsWith('https:') || lower.startsWith('http:')
}

function boardIssueUrlIsHttp(task: BoardTask): boolean {
  const url = boardIssueUrl(task)
  if (url == null) return false
  return urlLooksHttp(url)
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
    parent_task_id:
      typeof raw.parent_task_id === 'string'
        ? raw.parent_task_id
        : raw.parent_task_id === null
          ? null
          : (fallback?.parent_task_id ?? null),
    review_round:
      typeof raw.review_round === 'number' ? raw.review_round : (fallback?.review_round ?? 0),
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

// A failure response's `message` is only trustworthy when `error` is one of this app's own
// typed, snake_case machine codes (e.g. `not_found`, `credential_profile_in_use`). There is no
// setErrorHandler in apps/server/src, so an unhandled route throw falls through to Fastify's own
// default envelope, and the one place this app asks Fastify to synthesize a body itself
// (setNotFoundHandler) does the same — both come out as a capitalized, space-containing `error`
// like "Not Found" / "Internal Server Error" with an English `message` that must never reach this
// Chinese-only admin UI (AGENTS.md「用户界面使用中文」, issue #45).
const TYPED_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]*$/

function typedErrorMessage(body: Record<string, unknown> | null): string | null {
  if (body == null) return null
  if (typeof body.error !== 'string' || !TYPED_ERROR_CODE_PATTERN.test(body.error)) return null
  return typeof body.message === 'string' ? body.message : null
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
      try {
        const setupRes = await fetch('/api/v1/setup', {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        })
        if (setupRes.ok) {
          const setupBody = (await setupRes.json()) as { setup_complete?: boolean }
          setupComplete.value = setupBody.setup_complete === true
        }
      } catch {
        setupComplete.value = true
      }
    }
  } catch {
    me.value = null
  } finally {
    loaded.value = true
  }
  if (view.value === 'member') {
    openStream()
    await loadTasks()
    await loadEvents()
    await loadStats()
  }
  if (canManageInstance.value) {
    await loadClaimConfirmations()
    await loadMineDevices()
    await loadPendingDevices()
    await loadClaimants()
    await loadUsers()
  }
  if (canPublish.value) {
    await loadProfiles()
  }
})

async function applyMeFromResponse(res: Response) {
  if (!res.ok) return false
  me.value = (await res.json()) as Me
  trustedAutomation.value = me.value?.trusted_automation === true
  setupComplete.value = true
  if (view.value === 'member') {
    openStream()
    await loadTasks()
    await loadEvents()
    await loadStats()
  }
  if (canManageInstance.value) {
    await loadClaimConfirmations()
    await loadMineDevices()
    await loadPendingDevices()
    await loadClaimants()
    await loadUsers()
  }
  if (canPublish.value) {
    await loadProfiles()
  }
  return true
}

async function submitSetup() {
  authSubmitting.value = true
  authMessage.value = ''
  try {
    const res = await fetch('/api/v1/setup', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: setupUsername.value, password: setupPassword.value }),
    })
    if (!(await applyMeFromResponse(res))) {
      authMessage.value = '无法完成初始设置。'
    }
  } catch {
    authMessage.value = '无法完成初始设置。'
  } finally {
    authSubmitting.value = false
  }
}

async function submitLogin() {
  authSubmitting.value = true
  authMessage.value = ''
  try {
    const res = await fetch('/api/v1/login', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: loginUsername.value, password: loginPassword.value }),
    })
    if (!(await applyMeFromResponse(res))) {
      authMessage.value = '登录失败。'
    }
  } catch {
    authMessage.value = '登录失败。'
  } finally {
    authSubmitting.value = false
  }
}

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

async function loadMineDevices() {
  try {
    const res = await fetch('/api/v1/me/devices', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const body = await readJson(res)
    mineDevices.value = Array.isArray(body?.devices) ? (body.devices as DeviceRow[]) : []
  } catch {
    mineDevices.value = []
  }
}

async function loadPendingDevices() {
  try {
    const res = await fetch('/api/v1/devices/pending', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const body = await readJson(res)
    pendingDevices.value = Array.isArray(body?.devices) ? (body.devices as DeviceRow[]) : []
  } catch {
    pendingDevices.value = []
  }
}

async function loadClaimants() {
  try {
    const res = await fetch('/api/v1/claimants', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const body = await readJson(res)
    claimants.value = Array.isArray(body?.claimants) ? (body.claimants as ClaimantRow[]) : []
  } catch {
    claimants.value = []
  }
}

async function loadUsers() {
  try {
    const res = await fetch('/api/v1/users', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const body = await readJson(res)
    listedUsers.value = Array.isArray(body?.users) ? (body.users as ListedUser[]) : []
  } catch {
    listedUsers.value = []
  }
}

function userCanPromote(user: ListedUser): boolean {
  return (
    (user.provider === 'gitlab' || user.provider === 'gitea') &&
    user.status === 'active' &&
    user.permission_level === 'full'
  )
}

async function promoteUser(id: number) {
  try {
    const res = await postJson(`/api/v1/users/${id}/promote`, {})
    if (res.ok) await loadUsers()
  } catch {
    // ignore
  }
}

function pendingBindTargetId(): number | undefined {
  return pendingDevices.value[0]?.id
}

async function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function refreshDeviceLists() {
  await loadMineDevices()
  await loadPendingDevices()
  await loadClaimants()
}

async function bindPendingDevice(body: Record<string, unknown>) {
  const id = pendingBindTargetId()
  if (id == null) return
  deviceBinding.value = true
  deviceBindMessage.value = ''
  try {
    const res = await postJson(`/api/v1/devices/${id}/bind`, body)
    if (!res.ok) {
      deviceBindOk.value = false
      deviceBindMessage.value = `绑定失败（${res.status}）`
      return
    }
    await res.json().catch(() => null)
    deviceBindOk.value = true
    deviceBindMessage.value = '已绑定。'
    bindClaimantName.value = ''
    bindClaimantId.value = null
    await refreshDeviceLists()
  } catch {
    deviceBindOk.value = false
    deviceBindMessage.value = '绑定请求失败'
  } finally {
    deviceBinding.value = false
  }
}

async function bindDeviceToSelf() {
  await bindPendingDevice({ bind_to_self: true })
}

async function submitBindClaimant() {
  if (bindClaimantId.value != null) {
    await bindPendingDevice({ claimant_id: bindClaimantId.value })
    return
  }
  await bindPendingDevice({ claimant_display_name: bindClaimantName.value })
}

async function revokeDevice(id: number) {
  try {
    const res = await postJson(`/api/v1/devices/${id}/revoke`, {})
    if (res.ok) await loadMineDevices()
  } catch {
    // ignore
  }
}

async function revokeClaimant(id: number) {
  try {
    const res = await postJson(`/api/v1/claimants/${id}/revoke`, {})
    if (res.ok) await loadClaimants()
  } catch {
    // ignore
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

function resetReviewComposer() {
  reviewComposerBody.value = ''
  reviewComposerKind.value = 'blocking'
  reviewComposerAnchor.value = ''
}

function asReviewAnchor(value: unknown): ReviewAnchor | null {
  if (value == null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const anchor: ReviewAnchor = {}
  if (typeof raw.path === 'string') anchor.path = raw.path
  if (typeof raw.line === 'number') anchor.line = raw.line
  if (typeof raw.head_sha === 'string') anchor.head_sha = raw.head_sha
  if (typeof raw.url === 'string') anchor.url = raw.url
  return Object.keys(anchor).length === 0 ? null : anchor
}

function asReviewMessage(value: unknown): ReviewMessage | null {
  if (value == null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'number') return null
  return {
    id: raw.id,
    round: typeof raw.round === 'number' ? raw.round : null,
    author_kind: typeof raw.author_kind === 'string' ? raw.author_kind : '',
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    body_md: typeof raw.body_md === 'string' ? raw.body_md : '',
    anchor: asReviewAnchor(raw.anchor),
    resolved: raw.resolved === true,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
  }
}

function asReviewRound(value: unknown): ReviewRound | null {
  if (value == null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.round !== 'number') return null
  return {
    round: raw.round,
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    verdict: typeof raw.verdict === 'string' ? raw.verdict : null,
  }
}

function asReviewBody(body: Record<string, unknown> | null, taskId: string): ReviewBody | null {
  if (body == null) return null
  const messages: ReviewMessage[] = []
  if (Array.isArray(body.messages)) {
    for (const item of body.messages) {
      const message = asReviewMessage(item)
      if (message != null) messages.push(message)
    }
  }
  const rounds: ReviewRound[] = []
  if (Array.isArray(body.rounds)) {
    for (const item of body.rounds) {
      const round = asReviewRound(item)
      if (round != null) rounds.push(round)
    }
  }
  return {
    task_id: typeof body.task_id === 'string' ? body.task_id : taskId,
    status: typeof body.status === 'string' ? body.status : '',
    pr_url: typeof body.pr_url === 'string' ? body.pr_url : null,
    head_sha: typeof body.head_sha === 'string' ? body.head_sha : null,
    round: typeof body.round === 'number' ? body.round : 0,
    rounds,
    messages,
  }
}

// 评审失败信封：先走本应用自己的类型化 message（#45 的判别），再补两个服务端可能不带 message
// 的码，最后才是「…（状态码）」。英文原文永远不上屏。
function reviewFailureMessage(
  body: Record<string, unknown> | null,
  status: number,
  fallback: string,
): string {
  const typed = typedErrorMessage(body)
  if (typed != null) return typed
  const code = typeof body?.error === 'string' ? body.error : ''
  return REVIEW_ERROR_MESSAGES[code] ?? `${fallback}（${status}）`
}

async function loadReview(id: string) {
  const request = ++reviewRequest
  try {
    const res = await fetch(`/api/v1/tasks/${id}/review`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    const body = await readJson(res)
    if (request !== reviewRequest) return
    if (!res.ok) {
      review.value = null
      reviewActionMessage.value = reviewFailureMessage(body, res.status, '评审加载失败')
      return
    }
    review.value = asReviewBody(body, id)
  } catch {
    if (request !== reviewRequest) return
    review.value = null
    reviewActionMessage.value = '评审加载失败'
  }
}

// 待认领 / 进行中 的任务还没有 PR，面板只写「尚未提交 PR，暂无评审」，不发请求。
async function refreshReviewPanel() {
  const task = selectedTask.value
  if (task == null || !REVIEW_PANEL_STATUSES.includes(task.status)) {
    reviewRequest += 1
    review.value = null
    return
  }
  await loadReview(task.id)
}

async function sendReviewMessage() {
  const task = selectedTask.value
  if (task == null) return
  const text = reviewComposerBody.value.trim()
  if (text === '') return
  reviewSending.value = true
  reviewActionMessage.value = ''
  try {
    const payload: Record<string, unknown> = { body_md: text, kind: reviewComposerKind.value }
    const anchorText = reviewComposerAnchor.value.trim()
    if (anchorText !== '') payload.anchor = parseAnchorLink(anchorText)
    const res = await postJson(`/api/v1/tasks/${task.id}/review/messages`, payload)
    const body = await readJson(res)
    if (!res.ok) {
      reviewActionMessage.value = reviewFailureMessage(body, res.status, '发送失败')
      return
    }
    resetReviewComposer()
    await refreshReviewPanel()
  } catch {
    reviewActionMessage.value = '发送失败'
  } finally {
    reviewSending.value = false
  }
}

async function runReviewAction(action: 'rounds' | 'approve' | 'withdraw' | 'terminate') {
  const task = selectedTask.value
  if (task == null) return
  if (action === 'terminate' && !window.confirm(REVIEW_TERMINATE_CONFIRM)) return
  reviewActing.value = true
  reviewActionMessage.value = ''
  try {
    const res = await postJson(`/api/v1/tasks/${task.id}/review/${action}`, {})
    const body = await readJson(res)
    if (!res.ok) {
      reviewActionMessage.value = reviewFailureMessage(body, res.status, '操作失败')
      return
    }
    const updated = body?.task
    if (updated != null && typeof updated === 'object') {
      applyBriefUpdate(updated as Record<string, unknown>)
    }
    await refreshReviewPanel()
  } catch {
    reviewActionMessage.value = '操作失败'
  } finally {
    reviewActing.value = false
  }
}

// --- SSE（GET /api/v1/stream，docs/api.md §17.5）-----------------------------------------

let streamSource: EventSource | null = null
let streamRetryTimer = 0

function streamPayload(event: Event): Record<string, unknown> | null {
  const data = (event as MessageEvent).data
  if (typeof data !== 'string') return null
  try {
    const parsed = JSON.parse(data) as unknown
    if (parsed == null || typeof parsed !== 'object') return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function streamTaskId(payload: Record<string, unknown> | null): string | null {
  const id = payload?.task_id
  return typeof id === 'string' ? id : null
}

async function onStreamTaskUpdated(event: Event) {
  const id = streamTaskId(streamPayload(event))
  await loadTasks()
  if (id != null && id === selectedTaskId.value) await refreshReviewPanel()
}

function onStreamProgress(event: Event) {
  const payload = streamPayload(event)
  const id = streamTaskId(payload)
  if (id == null) return
  taskProgress.value = {
    ...taskProgress.value,
    [id]: {
      percent: typeof payload?.percent === 'number' ? payload.percent : null,
      phase: typeof payload?.phase === 'string' ? payload.phase : null,
    },
  }
}

async function onStreamReview(event: Event) {
  const id = streamTaskId(streamPayload(event))
  if (id == null || id !== selectedTaskId.value) return
  await refreshReviewPanel()
}

function openStream() {
  // 测试环境（happy-dom）没有 EventSource；没有就安静地不订阅，其余功能照常。
  if (typeof EventSource === 'undefined') return
  if (streamSource != null) return
  let source: EventSource
  try {
    source = new EventSource('/api/v1/stream')
  } catch {
    return
  }
  streamSource = source
  source.addEventListener('task_updated', (event) => {
    void onStreamTaskUpdated(event)
  })
  source.addEventListener('progress', onStreamProgress)
  source.addEventListener('review_round', (event) => {
    void onStreamReview(event)
  })
  source.addEventListener('discussion_message', (event) => {
    void onStreamReview(event)
  })
  source.onerror = () => {
    reconnectStream()
  }
}

// 有界重连：一次错误关掉连接并只排一个 3s 定时器，重连成功前不再排第二个。
function reconnectStream() {
  if (streamSource != null) {
    streamSource.close()
    streamSource = null
  }
  if (streamRetryTimer !== 0) return
  streamRetryTimer = window.setTimeout(() => {
    streamRetryTimer = 0
    openStream()
  }, 3000)
}

function closeStream() {
  if (streamRetryTimer !== 0) {
    window.clearTimeout(streamRetryTimer)
    streamRetryTimer = 0
  }
  if (streamSource != null) {
    streamSource.close()
    streamSource = null
  }
}

onUnmounted(() => {
  closeStream()
})

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
        typedErrorMessage(body) ?? `操作失败（${res.status}）`
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
      profileMessage.value =
        typedErrorMessage(body) ?? `删除失败（${res.status}）`
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

  // 「无」时整把 key 不出现在请求体里 —— 服务端只在带 parent_task_id 时才做父任务校验。
  const payload: Record<string, unknown> = {
    title,
    description_md: taskDescription.value,
    source,
    repo,
    credential,
  }
  const parentId = taskParentId.value.trim()
  if (parentId !== '') payload.parent_task_id = parentId

  taskCreating.value = true
  taskMessage.value = ''
  taskOk.value = false
  taskCredentialFeedback.value = ''
  try {
    const res = await fetch('/api/v1/tasks', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
        typedErrorMessage(body) ?? `发布失败（${res.status}）`
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
        typedErrorMessage(body) ?? `导入失败（${res.status}）`
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
    const importedSource = body?.source
    if (
      importedSource != null &&
      typeof importedSource === 'object' &&
      typeof (importedSource as { issue_url?: unknown }).issue_url === 'string'
    ) {
      taskImportIssueUrl.value = (importedSource as { issue_url: string }).issue_url
    } else {
      taskImportIssueUrl.value = taskIssueUrl.value.trim()
    }
    taskImportReady.value = true
  } catch {
    taskMessage.value = '导入请求失败'
  }
}
</script>

<style src="./theme.css"></style>
