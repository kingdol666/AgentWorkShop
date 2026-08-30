<script setup lang="ts">
/**
 * Workspace 总览(用户级隔离):
 * - 未登录 → 注册/登录门(用户 token = 管理 API 凭证)
 * - 已登录 → workspace 卡片墙(服务端持久化;按用户隔离)+ 实时状态徽标
 */
import { message } from 'ant-design-vue'
import { useWorkspacesStore } from '../../stores/workshop/workspaces'
import { useEntitiesStore } from '../../stores/workshop/entities'
import { useUserStore } from '../../stores/workshop/user'
import { useWorkshopWs } from '../../composables/workshop/useWorkshopWs'

const { t } = useI18n()

definePageMeta({ layout: 'default' })

const userStore = useUserStore()
const wsStore = useWorkspacesStore()
const entities = useEntitiesStore()
const { subscribe } = useWorkshopWs()

// ===== 登录门（全局用户系统）=====
const authTab = ref<'register' | 'login' | 'token'>('login')
const authName = ref('')
const authEmail = ref('')
const authPassword = ref('')
const authTokenInput = ref('')
const authLoading = ref(false)

const doRegister = async (): Promise<void> => {
  if (!authName.value.trim()) {
    message.warning(t('wsHome.k1vnhyks019'))
    return
  }
  if (!authEmail.value.trim()) {
    message.warning(t('wsHome.k8ieqzj020'))
    return
  }
  if (authPassword.value.length < 6) {
    message.warning(t('wsHome.ksx73ra021'))
    return
  }
  authLoading.value = true
  try {
    const user = await userStore.register(authName.value, authEmail.value, authPassword.value)
    message.success(t('wsHome.k1mbatbh030', { p0: user.name }))
    authName.value = ''
    authEmail.value = ''
    authPassword.value = ''
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    authLoading.value = false
  }
}
const doLogin = async (): Promise<void> => {
  if (!authEmail.value.trim()) {
    message.warning(t('wsHome.k8ieqzj020'))
    return
  }
  authLoading.value = true
  try {
    const user = await userStore.login(authEmail.value, authPassword.value)
    message.success(t('wsHome.kwixbdl031', { p0: user.name }))
    authPassword.value = ''
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    authLoading.value = false
  }
}
const doLoginWithToken = async (): Promise<void> => {
  authLoading.value = true
  try {
    const user = await userStore.loginWithToken(authTokenInput.value)
    message.success(t('wsHome.kwixbdl031', { p0: user.name }))
    authTokenInput.value = ''
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    authLoading.value = false
  }
}
const doLogout = (): void => {
  userStore.logout()
  message.success(t('wsHome.k3ngm6p022'))
}

// ===== 登录后加载 workspace(服务端持久化)=====
const ready = ref(false)
watch(() => userStore.isLoggedIn, async (ok) => {
  if (!ok) {
    ready.value = false
    return
  }
  await userStore.refresh()
  if (!userStore.isLoggedIn) return
  try {
    await wsStore.load()
    ready.value = true
  }
  catch (e) {
    // SSR 安全:ant-design-vue message 依赖 DOM,服务端静默(客户端进入页面后可重试)
    if (import.meta.client) message.error(e instanceof Error ? e.message : t('wsHome.k1br33vc023'))
  }
}, { immediate: true })

// 已有 workspace 的 channel 订阅(总览页也保持事件流活跃,状态徽标实时)
watch(
  () => ready.value && wsStore.workspaces.map(w => w.channelIds.join(',')).join('|'),
  () => {
    if (!ready.value) return
    for (const ws of wsStore.workspaces) {
      for (const id of ws.channelIds) subscribe(id)
    }
  },
  { immediate: true },
)

const createOpen = ref(false)
const createName = ref('')
const createLoading = ref(false)
const create = async (): Promise<void> => {
  const name = createName.value.trim()
  if (!name) {
    message.warning('Workspace 名称必填')
    return
  }
  createLoading.value = true
  try {
    const ws = await wsStore.create(name)
    createOpen.value = false
    createName.value = ''
    wsStore.setActiveWorkspaceId(ws.id)
    navigateTo(`/workshop/w/${ws.id}`)
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    createLoading.value = false
  }
}

const remove = async (id: string): Promise<void> => {
  await wsStore.remove(id)
  message.success(t('wsHome.k3n5sd7024'))
}

const channelSummary = (channelIds: string[]) => channelIds.map((id) => {
  const meta = entities.channels[id]
  const agents = entities.agents[id] ?? []
  return {
    id,
    name: meta?.name ?? id.slice(0, 8),
    /** 实体基线(WS 快照)是否已到达:未到时计数不可信,展示"同步中"而非误导性的 0 */
    synced: meta !== undefined,
    agents: agents.length,
    busy: agents.filter(a => a.state === 'busy').length,
    activeTasks: (entities.tasks[id] ?? []).filter(t => !['COMPLETED', 'CANCELED', 'FAILED'].includes(t.state)).length,
  }
})

useHead({ title: () => t('titles.workshop') })
</script>

<template>
  <div class="page">
    <!-- 登录门 -->
    <div
      v-if="!userStore.isLoggedIn"
      class="auth-gate aw-orbs"
    >
      <a-card class="auth-card">
        <p class="aw-kicker">
          agentworkshop / sign in
        </p>
        <h2>{{ $t('wsHome.kr0vzqu008') }}</h2>
        <p class="sub">
          全局用户系统统管身份;每个用户可管理多个 API Token,
          管理 API 需用户 token(Authorization: Bearer)。
        </p>
        <a-tabs v-model:active-key="authTab">
          <a-tab-pane
            key="login"
            tab="账号登录"
          >
            <a-space
              direction="vertical"
              style="width: 100%"
            >
              <a-input
                v-model:value="authEmail"
                type="email"
                :placeholder="$t('wsHome.k48h2c001')"
                @keydown.enter="doLogin"
              />
              <a-input-password
                v-model:value="authPassword"
                :placeholder="$t('wsHome.k3yvgs002')"
                @keydown.enter="doLogin"
              />
              <a-button
                type="primary"
                block
                :loading="authLoading"
                @click="doLogin"
              >
                {{ $t('wsHome.k43kol009') }}
              </a-button>
              <p class="hint">
                {{ $t('wsHome.k17x74cj010') }}
              </p>
            </a-space>
          </a-tab-pane>
          <a-tab-pane
            key="register"
            tab="注册新用户"
          >
            <a-space
              direction="vertical"
              style="width: 100%"
            >
              <a-input
                v-model:value="authName"
                :placeholder="$t('wsHome.kwgbai9003')"
              />
              <a-input
                v-model:value="authEmail"
                type="email"
                :placeholder="$t('wsHome.kizjkbo004')"
              />
              <a-input-password
                v-model:value="authPassword"
                :placeholder="$t('wsHome.kh3cqfn005')"
                @keydown.enter="doRegister"
              />
              <a-button
                type="primary"
                block
                :loading="authLoading"
                @click="doRegister"
              >
                {{ $t('wsHome.k1so6a0v011') }}
              </a-button>
              <p class="hint">
                {{ $t('wsHome.k1r0a4u3012') }}
              </p>
            </a-space>
          </a-tab-pane>
          <a-tab-pane
            key="token"
            tab="Token 登录"
          >
            <a-space
              direction="vertical"
              style="width: 100%"
            >
              <a-input-password
                v-model:value="authTokenInput"
                :placeholder="$t('wsHome.k15qunld006')"
                @keydown.enter="doLoginWithToken"
              />
              <a-button
                type="primary"
                block
                :loading="authLoading"
                @click="doLoginWithToken"
              >
                {{ $t('wsHome.k43kol009') }}
              </a-button>
            </a-space>
          </a-tab-pane>
        </a-tabs>
      </a-card>
    </div>

    <!-- 工作区(已登录) -->
    <template v-else>
      <div class="aw-page-head">
        <div>
          <p class="aw-kicker">
            workshop / overview
          </p>
          <h1>Workshop {{ $t('wsHome.k3n4m5c025') }}</h1>
          <p class="sub">
            {{ userStore.user?.name }} {{ $t('wsHome.ke16e53026') }}
          </p>
        </div>
        <div class="head-acts">
          <div class="lib-links">
            <button
              type="button"
              class="lib-link"
              @click="navigateTo('/workshop/agents')"
            >
              {{ $t('wsHome.k3pa5h4013') }}
            </button>
            <button
              type="button"
              class="lib-link"
              @click="navigateTo('/workshop/teams')"
            >
              {{ $t('wsHome.k3svl8y014') }}
            </button>
            <button
              type="button"
              class="lib-link"
              @click="navigateTo('/workshop/channel-templates')"
            >
              Channel {{ $t('wsHome.k41ds5027') }}
            </button>
            <button
              type="button"
              class="lib-link"
              @click="navigateTo('/tokens')"
            >
              API Token
            </button>
            <button
              type="button"
              class="lib-link"
              @click="doLogout"
            >
              {{ $t('wsHome.k484e7015') }}
            </button>
          </div>
          <button
            class="aw-pill im"
            @click="createOpen = true"
          >
            <span class="i-tabler-plus im-pop" />
            {{ $t('wsHome.newWs') }}
          </button>
        </div>
      </div>

      <a-spin :spinning="!ready">
        <div class="grid">
          <div
            v-for="ws in wsStore.workspaces"
            :key="ws.id"
            class="card"
          >
            <div class="card-head">
              <span class="card-mark"><span class="i-tabler-box" /></span>
              <span class="name">{{ ws.name }}</span>
            </div>
            <div class="card-body">
              <div
                v-for="ch in channelSummary(ws.channelIds)"
                :key="ch.id"
                class="ch-row"
                @click="navigateTo(`/workshop/w/${ws.id}`)"
              >
                <span
                  class="dot"
                  :class="{ live: ch.activeTasks > 0 }"
                />
                <span class="ch-name">{{ ch.name }}</span>
                <span class="ch-meta">
                  <template v-if="ch.synced">{{ ch.agents }} {{ $t('wsHome.k1ggoa45028') }} {{ ch.busy }} / {{ $t('wsHome.k3wcox029') }} {{ ch.activeTasks }}</template>
                  <template v-else>{{ $t('wsHome.k1bst7s9016') }}</template>
                </span>
              </div>
              <div
                v-if="ws.channelIds.length === 0"
                class="empty"
              >
                {{ $t('wsHome.k1ylgrbc017') }}
              </div>
            </div>
            <div class="card-foot">
              <button
                class="aw-pill outline im"
                @click="navigateTo(`/workshop/w/${ws.id}`)"
              >
                <span class="i-tabler-arrow-right im-pop" />
                {{ $t('wsHome.kr1uwwi018') }}
              </button>
              <button
                class="aw-ghost im"
                title="删除 Workspace"
                @click.stop="remove(ws.id)"
              >
                <span class="i-tabler-trash im-shake" />
              </button>
            </div>
          </div>

          <div
            v-if="wsStore.workspaces.length === 0 && ready"
            class="card placeholder"
            @click="createOpen = true"
          >
            <span class="i-tabler-plus big" />
            <span>新建第一个 Workspace</span>
          </div>
        </div>
      </a-spin>

      <a-modal
        v-model:open="createOpen"
        :title="$t('wsHome.newWs')"
        :confirm-loading="createLoading"
        ok-text="创建并进入"
        cancel-text="取消"
        @ok="create"
      >
        <a-input
          v-model:value="createName"
          :placeholder="$t('wsHome.ksmpk8l007')"
          @keydown.enter="create"
        />
      </a-modal>
    </template>
  </div>
</template>

<style scoped>
.page { padding: 4px; }

.auth-gate {
  display: flex;
  justify-content: center;
  padding-top: 8vh;
}

/* 登录卡:open-tag auth 声部(hairline-strong + 柔投影 + serif 标题) */
.auth-card {
  position: relative;
  width: 420px;
  max-width: 92vw;
  padding: 26px 26px 18px;
  border: 1px solid var(--line-strong) !important;
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-float);
}

.auth-card :deep(h2) {
  margin: 0 0 6px;
  font-family: var(--font-display);
  font-size: 26px;
}

.sub { margin: 0 0 14px; font-size: 12.5px; color: var(--ink-faint); }
.hint { margin: 8px 0 0; font-size: 11px; color: var(--ink-fainter); }

.head-acts {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-end;
}

/* 库链接行:安静文字链(降噪,主 CTA 只剩一个) */
.lib-links { display: inline-flex; flex-wrap: wrap; gap: 2px 14px; justify-content: flex-end; }

.lib-link {
  padding: 2px 0;
  font-family: var(--font-body);
  font-size: 12.5px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
  transition: color var(--transition-fast);
}

.lib-link:hover { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }

/* 卡片头:软方块 mark + serif 名称 */
.card-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  font-size: 15px;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border-radius: var(--radius-panel-sm);
}

.card-head .name {
  font-family: var(--font-display);
  font-size: 17px;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.card-foot {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  margin-top: auto;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

/* 工作台卡片:图纸面板 + 硬边投影,悬停时"浮起" */
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-card);
  transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
}

.card:hover {
  border-color: var(--line-strong);
  transform: translateY(-1px);
}

.card.placeholder {
  align-items: center;
  justify-content: center;
  min-height: 160px;
  font-size: 13px;
  opacity: 0.55;
  cursor: pointer;
  border-style: dashed;
}

.big { font-size: 28px; }

.card-head {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 15px;
}

.card-head > :first-child { color: var(--accent-cobalt); }

.name {
  flex: 1 1 auto;
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
}

.op { cursor: pointer; opacity: 0.4; }
.op:hover { opacity: 1; }

.card-body { flex: 1 1 auto; min-height: 40px; }

.ch-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 5px 7px;
  margin: 2px 0;
  font-size: 12px;
  cursor: pointer;
  border-radius: var(--radius-panel);
  transition: background 0.15s ease, transform 0.15s ease;
}

.ch-row:hover {
  background: color-mix(in srgb, var(--accent-cobalt) 7%, transparent);
  transform: translateX(2px);
}

.dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  background: var(--line-strong);
  border-radius: 50%;
}

.dot.live { background: var(--accent-moss); box-shadow: 0 0 6px var(--accent-moss); }

.ch-name { flex: 0 0 auto; font-weight: 600; }
.ch-meta {
  flex: 1 1 auto;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  opacity: 0.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty { padding: 12px 6px; font-size: 12px; opacity: 0.4; }
</style>
