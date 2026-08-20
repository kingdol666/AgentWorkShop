<script setup lang="ts">
/**
 * API Token 管理页 —— 当前用户对自己 token 的 CRUD。
 * 身份源:全局用户系统(/api/users/tokens);未登录经由 auth-gate 引导回登录门。
 */
import { message } from 'ant-design-vue'
import { useUserStore } from '../stores/workshop/user'
import type { TokenMeta } from '../stores/workshop/user'

definePageMeta({ layout: 'default' })

const userStore = useUserStore()
const tokens = ref<TokenMeta[]>([])
const loading = ref(false)

// ===== 创建 =====
const createOpen = ref(false)
const createLabel = ref('')
const createLoading = ref(false)
const createdRaw = ref('')

// ===== 重命名 =====
const renameOpen = ref(false)
const renameId = ref('')
const renameLabel = ref('')
const renameLoading = ref(false)

const load = async (): Promise<void> => {
  if (!userStore.isLoggedIn) return
  loading.value = true
  try {
    tokens.value = await userStore.listTokens()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : '加载 token 列表失败')
  }
  finally {
    loading.value = false
  }
}

watch(() => userStore.isLoggedIn, (ok) => {
  if (ok) {
    void load()
  }
  else {
    tokens.value = []
  }
}, { immediate: true })

const doCreate = async (): Promise<void> => {
  createLoading.value = true
  try {
    const res = await userStore.createToken(createLabel.value)
    createdRaw.value = res.token
    createOpen.value = false
    createLabel.value = ''
    await load()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    createLoading.value = false
  }
}

// openRename 定义见下(放宽为结构化类型以兼容 a-table 的 record)

const doRename = async (): Promise<void> => {
  if (!renameLabel.value.trim()) {
    message.warning('标签不能为空')
    return
  }
  renameLoading.value = true
  try {
    await userStore.renameToken(renameId.value, renameLabel.value)
    renameOpen.value = false
    await load()
    message.success('已更新')
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    renameLoading.value = false
  }
}

const doRevoke = (t: { id?: string }): void => {
  const tokenId = t.id
  if (!tokenId) return
  const isCurrent = tokenId === userStore.user?.tokenId
  void (async () => {
    try {
      await userStore.revokeToken(tokenId)
      message.success('已吊销')
      if (isCurrent) return // revokeToken 已触发登出跳转
      await load()
    }
    catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    }
  })()
}

const copy = (text: string): void => {
  void navigator.clipboard.writeText(text)
  message.success('已复制')
}

const fmt = (s: string | null): string => (s ? s.replace('T', ' ').slice(0, 19) : '—')

const openRename = (t: { id?: string, label?: string }): void => {
  renameId.value = t.id ?? ''
  renameLabel.value = t.label ?? ''
  renameOpen.value = true
}
const columns = [
  { title: '标签', key: 'label', dataIndex: 'label' },
  { title: '创建时间', key: 'createdAt', dataIndex: 'createdAt', width: 200 },
  { title: '最近使用', key: 'lastUsedAt', dataIndex: 'lastUsedAt', width: 200 },
  { title: '操作', key: 'action', width: 200 },
]

useHead({ title: 'API Token · AgentWorkShop' })
</script>

<template>
  <div class="page">
    <!-- 未登录:引导回 workshop 登录门 -->
    <div
      v-if="!userStore.isLoggedIn"
      class="auth-gate"
    >
      <a-card class="auth-card">
        <h2>请先登录</h2>
        <p class="sub">
          Token 属于登录用户的私有资源,需登录后管理。
        </p>
        <a-button
          type="primary"
          block
          @click="navigateTo('/workshop')"
        >
          前往登录
        </a-button>
      </a-card>
    </div>

    <template v-else>
      <div class="head">
        <div>
          <h2>API Token</h2>
          <p class="sub">
            {{ userStore.user?.name }} · 每个 token 可独立吊销;明文仅创建时展示一次
          </p>
        </div>
        <a-space>
          <a-tag
            v-if="userStore.user?.tokenId"
            color="green"
          >
            当前会话 Token 已标识
          </a-tag>
          <a-button
            type="primary"
            @click="createOpen = true"
          >
            <span class="i-tabler-plus" />
            签发 Token
          </a-button>
        </a-space>
      </div>

      <a-spin :spinning="loading">
        <a-table
          :columns="columns"
          :data-source="tokens"
          :pagination="false"
          row-key="id"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'label'">
              <a-space>
                <span class="i-tabler-key text-primary" />
                <span class="font-medium">{{ record.label || '(未命名)' }}</span>
                <a-tag
                  v-if="record.id === userStore.user?.tokenId"
                  color="green"
                >
                  当前会话
                </a-tag>
              </a-space>
            </template>
            <template v-else-if="column.key === 'createdAt'">
              {{ fmt(record.createdAt) }}
            </template>
            <template v-else-if="column.key === 'lastUsedAt'">
              {{ fmt(record.lastUsedAt) }}
            </template>
            <template v-else-if="column.key === 'action'">
              <a-space>
                <a-button
                  type="link"
                  size="small"
                  @click="openRename(record)"
                >
                  <span class="i-tabler-edit" />
                  重命名
                </a-button>
                <a-popconfirm
                  :title="record.id === userStore.user?.tokenId ? '吊销当前会话 token 将退出登录' : '吊销后立即失效'"
                  :ok-text="'吊销'"
                  :cancel-text="'取消'"
                  @confirm="doRevoke(record)"
                >
                  <a-button
                    type="link"
                    size="small"
                    danger
                  >
                    <span class="i-tabler-trash" />
                    吊销
                  </a-button>
                </a-popconfirm>
              </a-space>
            </template>
          </template>
        </a-table>
      </a-spin>

      <!-- 创建 Token -->
      <a-modal
        v-model:open="createOpen"
        title="签发 API Token"
        :confirm-loading="createLoading"
        ok-text="创建"
        cancel-text="取消"
        @ok="doCreate"
      >
        <a-input
          v-model:value="createLabel"
          placeholder="标签,如:CI / 测试脚本 / 备用"
          @keydown.enter="doCreate"
        />
      </a-modal>

      <!-- 明文回显(仅创建时一次) -->
      <a-modal
        :open="createdRaw !== ''"
        title="Token 已创建"
        :footer="null"
        @cancel="createdRaw = ''"
        @after-close="createdRaw = ''"
      >
        <p class="sub">
          请立即保存,关闭后明文不再可见:
        </p>
        <a-typography-paragraph
          copyable
          class="raw"
          @click="copy(createdRaw)"
        >
          {{ createdRaw }}
        </a-typography-paragraph>
        <a-button
          type="primary"
          block
          @click="createdRaw = ''"
        >
          我已保存
        </a-button>
      </a-modal>

      <!-- 重命名 -->
      <a-modal
        v-model:open="renameOpen"
        title="重命名 Token"
        :confirm-loading="renameLoading"
        ok-text="保存"
        cancel-text="取消"
        @ok="doRename"
      >
        <a-input
          v-model:value="renameLabel"
          placeholder="标签"
          @keydown.enter="doRename"
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
.auth-card h2 { margin: 0 0 8px; font-family: var(--font-display); }
.sub { margin: 0 0 12px; font-size: 12px; opacity: 0.6; }

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

h2 { margin: 0 0 4px; font-family: var(--font-display); }

.raw {
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 13px;
  word-break: break-all;
  background: var(--app-fill);
  border: 1px solid var(--app-border);
  border-radius: var(--radius-chip, 8px);
  cursor: pointer;
}

.text-primary { color: var(--color-primary); }
</style>
