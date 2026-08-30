<script setup lang="ts">
/**
 * API Token 管理页 —— 当前用户对自己 token 的 CRUD。
 * 身份源:全局用户系统(/api/users/tokens);未登录经由 auth-gate 引导回登录门。
 */
import { message } from 'ant-design-vue'
import { useUserStore } from '../stores/workshop/user'
import type { TokenMeta } from '../stores/workshop/user'

const { t: tt } = useI18n()

definePageMeta({ layout: 'default' })

const userStore = useUserStore()
const tokens = ref<TokenMeta[]>([])
const loading = ref(false)

// ===== 创建 =====
const createOpen = ref(false)
const createLabel = ref('')
const createLoading = ref(false)
const createdRaw = ref('')
const lastCreatedLabel = ref('')

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
    message.error(e instanceof Error ? e.message : tt('tokens.k19jvk54013'))
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
    lastCreatedLabel.value = createLabel.value
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
    message.warning(tt('tokens.k169z26g014'))
    return
  }
  renameLoading.value = true
  try {
    await userStore.renameToken(renameId.value, renameLabel.value)
    renameOpen.value = false
    await load()
    message.success(tt('tokens.k3n9aij015'))
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
      message.success(tt('tokens.k3n64kh016'))
      if (isCurrent) return // revokeToken 已触发登出跳转
      await load()
    }
    catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    }
  })()
}

// ===== 新 token 明文回显:默认掩码,眼睛切换显示,一键复制 =====
const revealed = ref(false)
const copied = ref(false)
const masked = computed(() => {
  const raw = createdRaw.value
  if (!raw) return ''
  return `${raw.slice(0, 6)}${'•'.repeat(Math.max(12, raw.length - 10))}${raw.slice(-4)}`
})
const toggleReveal = (): void => {
  revealed.value = !revealed.value
}

// ===== 通用剪贴板:API 优先,execCommand 兜底 =====
const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  }
  catch {
    // 剪贴板 API 不可用(非安全上下文/权限拒绝)→ execCommand 兜底
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    }
    catch {
      return false
    }
  }
}

const copyCreated = async (): Promise<void> => {
  if (await copyText(createdRaw.value)) {
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1600)
  }
  else {
    message.error(tt('tokens.kjtcn2h017'))
  }
}
const dismissCreated = (): void => {
  createdRaw.value = ''
  revealed.value = false
  copied.value = false
}

// ===== 列表行:掩码/眼睛切换/复制(明文经 reveal 接口按需获取,仅存内存,刷新即隐) =====
const revealedPlain = ref<Record<string, string>>({})
const revealingId = ref('')
const copyId = ref('')

const isRevealed = (id: string): boolean => id in revealedPlain.value

const rowDisplay = (t: TokenMeta): string => {
  if (isRevealed(t.id)) return revealedPlain.value[t.id]!
  return t.preview ?? `ut-${'•'.repeat(14)}`
}

/** 眼睛切换:已明文 → 遮回;否则拉取存档明文(懒加载,不自动展开) */
const toggleRowReveal = async (t: TokenMeta): Promise<void> => {
  if (isRevealed(t.id)) {
    Reflect.deleteProperty(revealedPlain.value, t.id)
    return
  }
  if (!t.hasPlain) {
    message.warning(tt('tokens.kkpgzo8018'))
    return
  }
  revealingId.value = t.id
  try {
    const plain = await userStore.revealToken(t.id)
    if (plain) revealedPlain.value[t.id] = plain
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : tt('tokens.k1gj9ls019'))
  }
  finally {
    revealingId.value = ''
  }
}

/** 行复制:优先用已展开明文,否则先静默拉取存档明文再复制(不改变显示状态) */
const copyRow = async (t: TokenMeta): Promise<void> => {
  const cached = revealedPlain.value[t.id]
  let text: string | null = cached ?? null
  if (!text) {
    if (!t.hasPlain) {
      message.warning(tt('tokens.kr5ovor020'))
      return
    }
    revealingId.value = t.id
    try {
      text = await userStore.revealToken(t.id)
    }
    catch (e) {
      message.error(e instanceof Error ? e.message : tt('tokens.kubtby5021'))
      return
    }
    finally {
      revealingId.value = ''
    }
  }
  if (text && await copyText(text)) {
    copyId.value = t.id
    setTimeout(() => {
      copyId.value = ''
    }, 1600)
  }
  else {
    message.error(tt('tokens.kgkfcr0022'))
  }
}

const fmt = (s: string | null): string => (s ? s.replace('T', ' ').slice(0, 19) : '-')

const openRename = (t: { id?: string, label?: string }): void => {
  renameId.value = t.id ?? ''
  renameLabel.value = t.label ?? ''
  renameOpen.value = true
}
const columns = [
  { title: tt('tokens.k41416002'), key: 'label', dataIndex: 'label' },
  { title: 'Token', key: 'token', width: 360 },
  { title: tt('tokens.k1bg95gk023'), key: 'createdAt', dataIndex: 'createdAt', width: 170 },
  { title: tt('tokens.k1euotul024'), key: 'lastUsedAt', dataIndex: 'lastUsedAt', width: 200 },
  { title: tt('tokens.k40aa6025'), key: 'action', width: 170 },
]

useHead({ title: () => tt('titles.tokens') })
</script>

<template>
  <div class="page">
    <!-- 未登录:引导回 workshop 登录门 -->
    <div
      v-if="!userStore.isLoggedIn"
      class="auth-gate"
    >
      <a-card class="auth-card">
        <h2>{{ $t('tokens.k1k6z0r8003') }}</h2>
        <p class="sub">
          {{ $t('tokens.k1gjnree004') }}
        </p>
        <a-button
          type="primary"
          block
          @click="navigateTo('/workshop')"
        >
          {{ $t('tokens.k1bhhheq005') }}
        </a-button>
      </a-card>
    </div>

    <template v-else>
      <div class="head">
        <div>
          <h2>API Token</h2>
          <p class="sub">
            {{ userStore.user?.name }} · {{ $t('tokens.k1upppaw026') }}
          </p>
        </div>
        <a-space>
          <a-tag
            v-if="userStore.user?.tokenId"
            color="green"
          >
            {{ $t('tokens.khcxmsc006') }}
          </a-tag>
          <a-button
            type="primary"
            @click="createOpen = true"
          >
            <span class="i-tabler-plus" />
            {{ $t('chips.issue') }}
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
                <span class="font-medium">{{ record.label || $t('tokens.kj3mklm028') }}</span>
                <a-tag
                  v-if="record.id === userStore.user?.tokenId"
                  color="green"
                >
                  {{ $t('tokens.k1defr98007') }}
                </a-tag>
              </a-space>
            </template>
            <template v-else-if="column.key === 'token'">
              <div class="tok-cell">
                <code
                  class="tok-val"
                  :class="{ revealed: isRevealed(record.id) }"
                  :title="isRevealed(record.id) ? '已显示明文,点击眼睛遮回' : '掩码预览,点击眼睛查看明文'"
                >{{ rowDisplay(record as TokenMeta) }}</code>
                <a-button
                  type="text"
                  size="small"
                  class="tok-op"
                  :loading="revealingId === record.id"
                  :disabled="!record.hasPlain"
                  :title="!record.hasPlain ? '旧版本 token 未存档明文,不可查看' : (isRevealed(record.id) ? '遮回' : '查看明文')"
                  @click="toggleRowReveal(record as TokenMeta)"
                >
                  <span :class="isRevealed(record.id) ? 'i-tabler-eye-off' : 'i-tabler-eye'" />
                </a-button>
                <a-button
                  type="text"
                  size="small"
                  class="tok-op"
                  :class="{ ok: copyId === record.id }"
                  :disabled="!record.hasPlain"
                  :title="copyId === record.id ? '已复制' : '复制明文'"
                  @click="copyRow(record as TokenMeta)"
                >
                  <span :class="copyId === record.id ? 'i-tabler-check' : 'i-tabler-copy'" />
                </a-button>
                <a-tag
                  v-if="!record.hasPlain"
                  class="legacy-tag"
                  color="orange"
                >
                  {{ $t('tokens.kyelqk1008') }}
                </a-tag>
              </div>
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
                  {{ $t('tokens.k3vrpcs009') }}
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
                    {{ $t('tokens.k3xmrz010') }}
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
        :title="$t('chips.issueTitle')"
        :confirm-loading="createLoading"
        ok-text="创建"
        cancel-text="取消"
        @ok="doCreate"
      >
        <a-input
          v-model:value="createLabel"
          :placeholder="$t('tokens.k1hlqknl001')"
          @keydown.enter="doCreate"
        />
      </a-modal>

      <!-- 明文回显(仅创建时一次):默认掩码,眼睛切换,一键复制 -->
      <a-modal
        :open="createdRaw !== ''"
        title="Token 已创建"
        :footer="null"
        :mask-closable="false"
        @cancel="dismissCreated"
        @after-close="dismissCreated"
      >
        <div class="once-banner">
          <span class="i-tabler-circle-check" />
          <span>{{ $t('tokens.k12149oy011') }}</span>
        </div>
        <div class="raw-row">
          <code class="raw">{{ revealed ? createdRaw : masked }}</code>
          <button
            class="raw-op"
            :title="revealed ? '隐藏明文' : '显示明文'"
            @click="toggleReveal"
          >
            <span :class="revealed ? 'i-tabler-eye-off' : 'i-tabler-eye'" />
          </button>
          <button
            class="raw-op"
            :class="{ ok: copied }"
            :title="copied ? '已复制' : '复制'"
            @click="copyCreated"
          >
            <span :class="copied ? 'i-tabler-check' : 'i-tabler-copy'" />
          </button>
        </div>
        <div class="once-meta">
          <span>{{ $t('tokens.k3p0p44027') }}{{ lastCreatedLabel || $t('tokens.kj3mklm028') }}</span>
          <span>用法:Authorization: Bearer &lt;token&gt;</span>
        </div>
        <a-button
          type="primary"
          block
          @click="dismissCreated"
        >
          {{ $t('tokens.k1s5f5zd012') }}
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
          :placeholder="$t('tokens.k41416002')"
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

.once-banner {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  margin-bottom: 12px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--tone-warning-dot);
  background: var(--tone-warning-bg);
  border-radius: var(--radius-chip);
}

.raw-row {
  display: flex;
  gap: 6px;
  align-items: stretch;
}

.raw {
  flex: 1 1 auto;
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: 0.02em;
  word-break: break-all;
  user-select: all;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}

.raw-op {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 42px;
  font-size: 15px;
  color: var(--ink-soft);
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
  transition: color var(--transition-fast), border-color var(--transition-fast);
}

.raw-op:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.raw-op.ok {
  color: var(--tone-success-dot);
  border-color: var(--tone-success-dot);
}

.once-meta {
  display: flex;
  gap: 14px;
  justify-content: space-between;
  margin: 10px 2px 14px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-faint);
}

/* ===== 列表行 token 单元格 ===== */
.tok-cell {
  display: flex;
  gap: 2px;
  align-items: center;
  min-width: 0;
}

.tok-val {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  padding: 3px 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}

.tok-val.revealed {
  color: var(--accent);
  user-select: all;
}

.tok-op {
  flex: 0 0 auto;
  color: var(--ink-faint);
}

.tok-op:hover {
  color: var(--accent);
}

.tok-op.ok {
  color: var(--tone-success-dot);
}

.legacy-tag {
  flex: 0 0 auto;
  margin-left: 4px;
  font-size: 10px;
  line-height: 16px;
}

.text-primary { color: var(--accent); }
</style>
