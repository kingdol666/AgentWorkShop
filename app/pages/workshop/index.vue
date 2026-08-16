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

definePageMeta({ layout: 'default' })

const userStore = useUserStore()
const wsStore = useWorkspacesStore()
const entities = useEntitiesStore()
const { subscribe } = useWorkshopWs()

// ===== 登录门 =====
const authTab = ref<'register' | 'login'>('register')
const authName = ref('')
const authTokenInput = ref('')
const authLoading = ref(false)
const doRegister = async (): Promise<void> => {
  authLoading.value = true
  try {
    const user = await userStore.register(authName.value)
    message.success(`注册成功:${user.name};token 已保存`)
    authName.value = ''
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    authLoading.value = false
  }
}
const doLogin = async (): Promise<void> => {
  authLoading.value = true
  try {
    const user = await userStore.loginWithToken(authTokenInput.value)
    message.success(`已登录:${user.name}`)
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
  message.success('已退出')
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
    message.error(e instanceof Error ? e.message : '加载失败')
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
  message.success('已删除')
}

const channelSummary = (channelIds: string[]) => channelIds.map((id) => {
  const meta = entities.channels[id]
  const agents = entities.agents[id] ?? []
  return {
    id,
    name: meta?.name ?? id.slice(0, 8),
    agents: agents.length,
    busy: agents.filter(a => a.state === 'busy').length,
    activeTasks: (entities.tasks[id] ?? []).filter(t => !['COMPLETED', 'CANCELED', 'FAILED'].includes(t.state)).length,
  }
})

useHead({ title: 'Workshop · Agent Harness' })
</script>

<template>
  <div class="page">
    <!-- 登录门 -->
    <div
      v-if="!userStore.isLoggedIn"
      class="auth-gate"
    >
      <a-card class="auth-card">
        <h2>AgentWorkShop 用户登录</h2>
        <p class="sub">
          用户级隔离:每个用户拥有自己的 Agent 模板 / Channel / Workspace;
          管理 API 需用户 token(Authorization: Bearer)。
        </p>
        <a-tabs v-model:active-key="authTab">
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
                placeholder="用户名(唯一)"
                @keydown.enter="doRegister"
              />
              <a-button
                type="primary"
                block
                :loading="authLoading"
                @click="doRegister"
              >
                注册并获取 token
              </a-button>
              <p class="hint">
                token 仅注册时返回一次;登录后自动保存到本机。
              </p>
            </a-space>
          </a-tab-pane>
          <a-tab-pane
            key="login"
            tab="token 登录"
          >
            <a-space
              direction="vertical"
              style="width: 100%"
            >
              <a-input-password
                v-model:value="authTokenInput"
                placeholder="粘贴用户 token"
                @keydown.enter="doLogin"
              />
              <a-button
                type="primary"
                block
                :loading="authLoading"
                @click="doLogin"
              >
                登录
              </a-button>
            </a-space>
          </a-tab-pane>
        </a-tabs>
      </a-card>
    </div>

    <!-- 工作区(已登录) -->
    <template v-else>
      <div class="head">
        <div>
          <h2>Workshop 工作区</h2>
          <p class="sub">
            {{ userStore.user?.name }} 的资源(用户级隔离;服务端持久化)
          </p>
        </div>
        <a-space>
          <a-tag
            color="green"
            class="user-tag"
          >
            <span class="i-tabler-user" />
            {{ userStore.user?.name }}
          </a-tag>
          <a-button @click="doLogout">
            退出
          </a-button>
          <a-button @click="navigateTo('/workshop/agents')">
            <span class="i-tabler-users" />
            模板库
          </a-button>
          <a-button @click="navigateTo('/workshop/teams')">
            <span class="i-tabler-users-group" />
            编组库
          </a-button>
          <a-button
            type="primary"
            @click="createOpen = true"
          >
            <span class="i-tabler-plus" />
            新建 Workspace
          </a-button>
        </a-space>
      </div>

      <a-spin :spinning="!ready">
        <div class="grid">
          <div
            v-for="ws in wsStore.workspaces"
            :key="ws.id"
            class="card"
          >
            <div class="card-head">
              <span class="i-tabler-box" />
              <span class="name">{{ ws.name }}</span>
              <a-dropdown>
                <span class="i-tabler-dots op" />
                <template #overlay>
                  <a-menu>
                    <a-menu-item @click="navigateTo(`/workshop/w/${ws.id}`)">
                      进入
                    </a-menu-item>
                    <a-menu-item
                      danger
                      @click="remove(ws.id)"
                    >
                      删除
                    </a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
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
                <span class="ch-meta">{{ ch.agents }} agent · {{ ch.busy }} 忙 · {{ ch.activeTasks }} 任务</span>
              </div>
              <div
                v-if="ws.channelIds.length === 0"
                class="empty"
              >
                未挂载 Channel(进入后从左栏挂载)
              </div>
            </div>
            <a-button
              block
              type="primary"
              ghost
              @click="navigateTo(`/workshop/w/${ws.id}`)"
            >
              进入控制台
            </a-button>
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
        title="新建 Workspace"
        :confirm-loading="createLoading"
        ok-text="创建并进入"
        cancel-text="取消"
        @ok="create"
      >
        <a-input
          v-model:value="createName"
          placeholder="Workspace 名称,如:支付网关重构"
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
.auth-card { width: 460px; max-width: 92vw; }
.auth-card h2 { margin: 0 0 8px; }
.sub { margin: 0 0 12px; font-size: 12px; opacity: 0.6; }
.hint { margin: 8px 0 0; font-size: 11px; opacity: 0.5; }
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
h2 { margin: 0 0 4px; }
.user-tag { display: inline-flex; gap: 4px; align-items: center; padding: 3px 10px; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  border-radius: 12px;
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
.name { flex: 1 1 auto; font-weight: 700; }
.op { cursor: pointer; opacity: 0.4; }
.op:hover { opacity: 1; }
.card-body { flex: 1 1 auto; min-height: 40px; }
.ch-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 6px;
  margin: 2px 0;
  font-size: 12px;
  cursor: pointer;
  border-radius: 6px;
}
.ch-row:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  background: #52c41a66;
  border-radius: 50%;
}
.dot.live { background: #52c41a; box-shadow: 0 0 6px #52c41a; }
.ch-name { flex: 0 0 auto; font-weight: 600; }
.ch-meta { flex: 1 1 auto; overflow: hidden; font-family: ui-monospace, Consolas, monospace; font-size: 11px; opacity: 0.5; text-overflow: ellipsis; white-space: nowrap; }
.empty { padding: 12px 6px; font-size: 12px; opacity: 0.4; }
</style>
