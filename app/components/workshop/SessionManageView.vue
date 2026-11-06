<script setup lang="ts">
/**
 * 多会话管理视图(S1):Channel 是模板,会话 = 从基础成员克隆的独立实例组。
 *
 * 数据流(自持,不走 WS —— sessions 实体不在推送事件面):
 *   - 会话清单 GET /channels/:id/sessions(memberMap: baseId → cloneId)
 *   - 成员静态面 GET /agents(clone 名含 ·session· 标记;enabled)
 *   - 运行态面  GET /queue(agentId → state/queued/completed;无 lead 频道 400,容忍降级)
 *   - 消息流    GET /messages?limit=500 按 memberMap cloneId 过滤(from/to 任一命中)
 *
 * 操作:新建会话(克隆全部基础成员 + 复制绑定面)/ 关闭会话(级联取消在飞任务,
 * 幂等)/ 点击成员实例上抛 openAgent(复用 AgentInspectorDrawer 抽屉)。
 * 选中会话为 active 时 10s 轻轮询消息与运行态(管理视图取向:显式刷新优先)。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi, type ChannelSessionDto, type ChannelMessageDto } from '@/app/composables/workshop/useWorkshopApi'

const { t } = useI18n()

const props = defineProps<{ channelId: string }>()
const emit = defineEmits<{ (e: 'openAgent', id: string): void }>()

const api = useWorkshopApi()

// ===== 数据面 =====
const sessions = ref<ChannelSessionDto[]>([])
const agentById = ref<Record<string, { id: string, name: string, enabled?: number, harness: string }>>({})
const queueByAgent = ref<Record<string, { state: string, queuedCount: number, completedCount: number }>>({})
const loading = ref(true)
const loadError = ref('')

const activeSessionId = ref<string | null>(null)
const messages = ref<ChannelMessageDto[]>([])
const messagesLoading = ref(false)

const activeSession = computed(() => sessions.value.find(s => s.id === activeSessionId.value) ?? null)

/** cloneId → 成员静态面(名称/启停);memberMap 的 clone 可能已被移除(移除即无行) */
function cloneInfo(cloneId: string) {
  return agentById.value[cloneId] ?? null
}
function cloneState(cloneId: string) {
  return queueByAgent.value[cloneId] ?? null
}
function sessionClones(s: ChannelSessionDto): string[] {
  return Object.values(s.memberMap ?? {})
}
const stateLabel = (state: string): string =>
  state === 'busy' ? t('sessionManage.stateBusy') : state === 'stopped' ? t('sessionManage.stateStopped') : t('sessionManage.stateIdle')

async function loadAll(): Promise<void> {
  loading.value = true
  loadError.value = ''
  const [sess, agents, queue] = await Promise.allSettled([
    api.listChannelSessions(props.channelId),
    api.listChannelAgents(props.channelId),
    api.queueOverview(props.channelId),
  ])
  if (sess.status === 'fulfilled') {
    sessions.value = [...(sess.value.data ?? [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  }
  else {
    loadError.value = apiErrorMessage(sess.reason)
  }
  if (agents.status === 'fulfilled') {
    agentById.value = Object.fromEntries((agents.value.data ?? []).map(a => [a.id, a]))
  }
  // queue 无 lead 频道会 400(NO_LEAD_AGENT)——运行态面降级为空,静态面仍可用
  if (queue.status === 'fulfilled') {
    queueByAgent.value = Object.fromEntries((queue.value.data ?? []).map(q => [q.agentId, { state: q.state, queuedCount: q.queuedCount, completedCount: q.completedCount }]))
  }
  else {
    queueByAgent.value = {}
  }
  loading.value = false
  // 自动选中:优先第一个 active 会话,否则第一个
  if (!activeSessionId.value || !sessions.value.some(s => s.id === activeSessionId.value)) {
    const first = sessions.value.find(s => s.status === 'active') ?? sessions.value[0]
    if (first) void selectSession(first)
    else activeSessionId.value = null
  }
}

// ===== 会话消息流(按 memberMap cloneId 过滤) =====
/** 登出态保护:401 表示会话身份已失效,轮询必须停(否则每 10s 一次 401 会反复触发全局登录框) */
function isAuthError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null)?.response?.status
  return status === 401
}
function stopPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function loadMessages(s: ChannelSessionDto): Promise<void> {
  messagesLoading.value = true
  try {
    const cloneIds = new Set(sessionClones(s))
    const res = await api.listChannelMessages(props.channelId, 500)
    const rows = (res.data ?? []).filter(m =>
      (m.fromAgentId != null && cloneIds.has(m.fromAgentId)) || (m.toAgentId != null && cloneIds.has(m.toAgentId)),
    )
    rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    messages.value = rows.slice(-300)
  }
  catch (err) {
    messages.value = []
    if (isAuthError(err)) stopPoll()
  }
  finally { messagesLoading.value = false }
}

async function selectSession(s: ChannelSessionDto): Promise<void> {
  activeSessionId.value = s.id
  await loadMessages(s)
}

// 选中会话为 active 时轻轮询(10s):新消息与运行态回流;切换/卸载/登出即停
let pollTimer: ReturnType<typeof setInterval> | null = null
watch(activeSessionId, (sid) => {
  stopPoll()
  const s = sessions.value.find(x => x.id === sid)
  if (s?.status === 'active') {
    pollTimer = setInterval(() => {
      const cur = sessions.value.find(x => x.id === activeSessionId.value)
      if (cur?.status !== 'active') return
      void loadMessages(cur)
      void refreshRuntime()
    }, 10_000)
  }
})
onBeforeUnmount(stopPoll)

async function refreshRuntime(): Promise<void> {
  try {
    const q = await api.queueOverview(props.channelId)
    queueByAgent.value = Object.fromEntries((q.data ?? []).map(x => [x.agentId, { state: x.state, queuedCount: x.queuedCount, completedCount: x.completedCount }]))
  }
  catch (err) {
    queueByAgent.value = {}
    if (isAuthError(err)) stopPoll()
  }
}

// ===== 新建会话 =====
const createOpen = ref(false)
const createTitle = ref('')
const creating = ref(false)
async function submitCreate(): Promise<void> {
  creating.value = true
  try {
    const res = await api.createChannelSession(props.channelId, { title: createTitle.value.trim() || undefined })
    message.success(t('sessionManage.createOkMsg', { p0: res.data?.members?.length ?? 0 }))
    createOpen.value = false
    createTitle.value = ''
    await loadAll()
    if (res.data?.sessionId) {
      const s = sessions.value.find(x => x.id === res.data!.sessionId)
      if (s) await selectSession(s)
    }
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally { creating.value = false }
}

// ===== 关闭会话(级联;幂等) =====
const closing = ref<string | null>(null)
async function submitClose(s: ChannelSessionDto): Promise<void> {
  closing.value = s.id
  try {
    const res = await api.closeChannelSession(props.channelId, s.id, { reason: 'owner closed from console' })
    message.success(t('sessionManage.closeOk', { p0: s.title, p1: res.data?.canceledTasks ?? 0 }))
    await loadAll()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally { closing.value = null }
}

// ===== 消息行渲染 =====
function msgText(m: ChannelMessageDto): string {
  const parts = Array.isArray(m.parts) ? m.parts : []
  return parts.map(p => p?.text ?? '').join('').trim()
}
function agentName(id: string | null): string {
  if (!id) return t('sessionManage.fromHuman')
  return agentById.value[id]?.name ?? id.slice(0, 8)
}
function msgStateInfo(m: ChannelMessageDto): { label: string, cls: string } {
  if (m.state === 'pending') return { label: t('sessionManage.msgStatePending'), cls: 'is-warn' }
  if (m.state === 'failed' || m.state === 'FAILED') return { label: t('sessionManage.msgStateFailed'), cls: 'is-danger' }
  return { label: t('sessionManage.msgStateConsumed'), cls: 'is-ok' }
}
const fmtTime = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// 消息流自动滚底(新消息到达时;用户上翻时不打扰)
const msgScroller = ref<HTMLElement | null>(null)
watch(messages, async () => {
  await nextTick()
  const el = msgScroller.value
  if (!el) return
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
  if (nearBottom) el.scrollTop = el.scrollHeight
})

onMounted(loadAll)
watch(() => props.channelId, () => {
  activeSessionId.value = null
  messages.value = []
  void loadAll()
})
</script>

<template>
  <div class="sm-wrap">
    <!-- 头部:标题 + 刷新 + 新建 -->
    <header class="sm-head">
      <div class="sm-title-row">
        <span class="i-tabler-stack-2 sm-title-icon" />
        <h3 class="sm-title">
          {{ t('sessionManage.title') }}
        </h3>
        <span class="sm-count">{{ sessions.length }}</span>
        <div class="sm-head-spacer" />
        <button
          class="sm-refresh"
          :disabled="loading"
          :title="t('sessionManage.refresh')"
          @click="loadAll"
        >
          <span
            class="i-tabler-refresh"
            :class="{ spin: loading }"
          />
        </button>
        <button
          class="sm-create"
          @click="createOpen = true"
        >
          <span class="i-tabler-plus" />
          {{ t('sessionManage.create') }}
        </button>
      </div>
      <p class="sm-sub">
        {{ t('sessionManage.subtitle') }}
      </p>
    </header>

    <!-- 加载/错误/空态(诚实区分) -->
    <div
      v-if="loading && sessions.length === 0"
      class="sm-empty"
    >
      <span class="i-tabler-loader-2 spin empty-icon" />
      <p class="empty-title">
        {{ t('sessionManage.loading') }}
      </p>
    </div>
    <div
      v-else-if="sessions.length === 0"
      class="sm-empty"
    >
      <span class="i-tabler-stack-2 empty-icon" />
      <p class="empty-title">
        {{ loadError || t('sessionManage.empty') }}
      </p>
      <p
        v-if="!loadError"
        class="empty-hint"
      >
        {{ t('sessionManage.emptyHint') }}
      </p>
    </div>

    <div
      v-else
      class="sm-body"
    >
      <!-- 左:会话卡片列 -->
      <aside class="sm-rail">
        <button
          v-for="s in sessions"
          :key="s.id"
          class="sm-card"
          :class="{ 'is-active': s.id === activeSessionId, 'is-closed': s.status === 'closed' }"
          @click="selectSession(s)"
        >
          <div class="sm-card-top">
            <span
              class="sm-dot"
              :class="s.status === 'active' ? 'is-active-dot' : 'is-closed-dot'"
            />
            <span class="sm-card-title">{{ s.title }}</span>
            <span
              class="sm-badge"
              :class="s.status === 'active' ? 'is-ok' : 'is-muted'"
            >{{ s.status === 'active' ? t('sessionManage.active') : t('sessionManage.closed') }}</span>
          </div>
          <div class="sm-card-meta">
            {{ s.status === 'closed' && s.closedAt ? t('sessionManage.closedAt', { p0: fmtTime(s.closedAt) }) : t('sessionManage.createdAt', { p0: fmtTime(s.createdAt) }) }}
          </div>
          <div
            v-if="sessionClones(s).length"
            class="sm-card-chips"
          >
            <span
              v-for="cid in sessionClones(s)"
              :key="cid"
              class="sm-chip"
            >
              <span
                v-if="cloneState(cid)"
                class="sm-chip-dot"
                :class="`st-${cloneState(cid)!.state}`"
              />
              {{ cloneInfo(cid)?.name ?? cid.slice(0, 8) }}
            </span>
          </div>
        </button>
      </aside>

      <!-- 右:选中会话详情(成员运行态 + 消息流) -->
      <section class="sm-detail">
        <template v-if="activeSession">
          <div class="sm-detail-head">
            <div class="sm-detail-title">
              <span
                class="sm-dot"
                :class="activeSession.status === 'active' ? 'is-active-dot' : 'is-closed-dot'"
              />
              <h4>{{ activeSession.title }}</h4>
              <span
                class="sm-badge"
                :class="activeSession.status === 'active' ? 'is-ok' : 'is-muted'"
              >{{ activeSession.status === 'active' ? t('sessionManage.active') : t('sessionManage.closed') }}</span>
              <span class="sm-head-spacer" />
              <a-popconfirm
                v-if="activeSession.status === 'active'"
                :title="t('sessionManage.closeConfirm')"
                placement="bottomRight"
                @confirm="submitClose(activeSession)"
              >
                <a-button
                  size="small"
                  danger
                  :loading="closing === activeSession.id"
                >
                  <span class="i-tabler-square-x" />
                  {{ t('sessionManage.closeBtn') }}
                </a-button>
              </a-popconfirm>
            </div>
            <div class="sm-members">
              <span class="sm-members-label">{{ t('sessionManage.members') }}</span>
              <template v-if="sessionClones(activeSession).length">
                <button
                  v-for="cid in sessionClones(activeSession)"
                  :key="cid"
                  class="sm-member"
                  :title="`${cloneInfo(cid)?.name ?? cid} · ${t('agentInspectorDrawer.tabStream')}`"
                  @click="emit('openAgent', cid)"
                >
                  <span
                    class="sm-chip-dot"
                    :class="cloneState(cid) ? `st-${cloneState(cid)!.state}` : 'st-unknown'"
                  />
                  <span class="sm-member-name">{{ cloneInfo(cid)?.name ?? cid.slice(0, 8) }}</span>
                  <span
                    v-if="cloneInfo(cid) && (cloneInfo(cid)!.enabled ?? 1) === 0"
                    class="sm-member-flag is-muted"
                  >{{ t('sessionManage.disabled') }}</span>
                  <span
                    v-else-if="cloneState(cid)"
                    class="sm-member-state"
                  >{{ stateLabel(cloneState(cid)!.state) }}</span>
                  <span
                    v-if="cloneState(cid)"
                    class="sm-member-nums"
                  >{{ t('sessionManage.queuedN', { p0: cloneState(cid)!.queuedCount }) }} · {{ t('sessionManage.completedN', { p0: cloneState(cid)!.completedCount }) }}</span>
                </button>
              </template>
              <span
                v-else
                class="sm-member-empty"
              >{{ t('sessionManage.noMembers') }}</span>
            </div>
          </div>

          <div class="sm-msgs-head">
            <span>{{ t('sessionManage.messages') }}</span>
            <span class="sm-msgs-count">{{ messages.length }}</span>
          </div>
          <div
            ref="msgScroller"
            class="sm-msgs"
          >
            <div
              v-if="messagesLoading && messages.length === 0"
              class="sm-msgs-empty"
            >
              <span class="i-tabler-loader-2 spin empty-icon" />
            </div>
            <div
              v-else-if="messages.length === 0"
              class="sm-msgs-empty"
            >
              <span class="i-tabler-messages empty-icon" />
              <p class="empty-title">
                {{ t('sessionManage.noMessages') }}
              </p>
            </div>
            <template v-else>
              <div
                v-for="m in messages"
                :key="m.id"
                class="sm-msg"
                :class="{ 'is-outbound': m.fromAgentId != null }"
              >
                <div class="sm-msg-meta">
                  <span class="sm-msg-dir">{{ agentName(m.fromAgentId) }}</span>
                  <span class="i-tabler-arrow-right sm-msg-arrow" />
                  <span class="sm-msg-dir">{{ agentName(m.toAgentId) }}</span>
                  <span class="sm-head-spacer" />
                  <span
                    class="sm-badge sm-msg-state"
                    :class="msgStateInfo(m).cls"
                  >{{ msgStateInfo(m).label }}</span>
                  <span class="sm-msg-time">{{ fmtTime(m.createdAt) }}</span>
                </div>
                <div class="sm-msg-text">
                  {{ msgText(m) || '—' }}
                </div>
              </div>
            </template>
          </div>
        </template>
        <div
          v-else
          class="sm-empty sm-detail-empty"
        >
          <span class="i-tabler-hand-click empty-icon" />
          <p class="empty-title">
            {{ t('sessionManage.selectHint') }}
          </p>
        </div>
      </section>
    </div>

    <!-- 新建会话弹窗(克隆全部基础成员;标题可选) -->
    <a-modal
      v-model:open="createOpen"
      :title="t('sessionManage.create')"
      :confirm-loading="creating"
      :ok-text="t('sessionManage.createOk')"
      :cancel-text="t('sessionManage.createCancel')"
      @ok="submitCreate"
    >
      <a-input
        v-model:value="createTitle"
        :placeholder="t('sessionManage.createTitlePh')"
        :maxlength="120"
      />
    </a-modal>
  </div>
</template>

<style scoped>
.sm-wrap {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--paper);
}
.sm-head {
  flex: 0 0 auto;
  padding: 14px 18px 12px;
  border-bottom: 1px solid var(--chat-line);
}
.sm-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.sm-title-icon {
  font-size: 16px;
  color: var(--chat-accent);
}
.sm-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--chat-ink);
}
.sm-count {
  padding: 1px 8px;
  border: 1px solid var(--chat-line);
  border-radius: var(--radius-pill);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--chat-ink-soft);
}
.sm-head-spacer {
  flex: 1 1 auto;
}
.sm-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--chat-line);
  border-radius: var(--radius-chip, 8px);
  background: transparent;
  color: var(--chat-ink-soft);
  cursor: pointer;
  transition: background var(--transition-fast);
}
.sm-refresh:hover {
  background: var(--hover-tint);
}
.sm-create {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  border: none;
  border-radius: var(--radius-chip, 8px);
  background: var(--chat-accent);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  transition: filter var(--transition-fast);
}
.sm-create:hover {
  filter: brightness(1.08);
}
.sm-sub {
  margin: 6px 0 0;
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
}
.sm-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}
.sm-rail {
  display: flex;
  flex: 0 0 320px;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-right: 1px solid var(--chat-line);
  overflow-y: auto;
}
.sm-card {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 5px;
  padding: 10px 12px;
  border: 1px solid var(--chat-line);
  border-radius: var(--radius-chip, 8px);
  background: var(--chat-surface);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}
.sm-card:hover {
  background: var(--hover-tint);
}
.sm-card.is-active {
  border-color: var(--chat-accent);
}
.sm-card.is-closed {
  opacity: 0.72;
}
.sm-card-top {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.sm-card-title {
  flex: 1 1 auto;
  overflow: hidden;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--chat-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sm-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.is-active-dot {
  background: var(--tone-success-dot);
}
.is-closed-dot {
  background: var(--ink-faint);
}
.sm-card-meta {
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
}
.sm-card-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.sm-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 1px 7px;
  border: 1px solid var(--chat-line);
  border-radius: var(--radius-pill);
  overflow: hidden;
  font-size: var(--fs-micro);
  color: var(--chat-ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sm-chip-dot,
.sm-member .sm-chip-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-faint);
}
.sm-chip-dot.st-idle,
.st-idle {
  background: var(--tone-info-dot);
}
.st-busy {
  background: var(--tone-success-dot);
}
.st-stopped {
  background: var(--tone-danger-dot);
}
.sm-badge {
  flex: 0 0 auto;
  padding: 0 7px;
  border-radius: var(--radius-pill);
  font-size: var(--fs-micro);
  line-height: 16px;
}
.sm-badge.is-ok {
  background: color-mix(in srgb, var(--tone-success-dot) 14%, transparent);
  color: var(--chat-ink);
}
.sm-badge.is-muted {
  background: color-mix(in srgb, var(--ink-faint) 14%, transparent);
  color: var(--chat-ink-soft);
}
.sm-badge.is-warn {
  background: color-mix(in srgb, var(--tone-warning-dot) 16%, transparent);
  color: var(--chat-ink);
}
.sm-badge.is-danger {
  background: color-mix(in srgb, var(--tone-danger-dot) 16%, transparent);
  color: var(--chat-ink);
}
.sm-detail {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}
.sm-detail-empty {
  flex: 1 1 auto;
}
.sm-detail-head {
  flex: 0 0 auto;
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--chat-line);
}
.sm-detail-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.sm-detail-title h4 {
  margin: 0;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  color: var(--chat-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sm-members {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.sm-members-label {
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
}
.sm-member {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 10px;
  border: 1px solid var(--chat-line);
  border-radius: var(--radius-pill);
  background: var(--chat-surface);
  color: inherit;
  cursor: pointer;
  transition: background var(--transition-fast);
}
.sm-member:hover {
  background: var(--hover-tint);
}
.sm-member-name {
  overflow: hidden;
  font-size: var(--fs-micro);
  color: var(--chat-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sm-member-state {
  font-size: var(--fs-micro);
  color: var(--chat-ink-soft);
}
.sm-member-nums {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
}
.sm-member-flag.is-muted {
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
}
.sm-member-empty {
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
}
.sm-msgs-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 9px 16px;
  border-bottom: 1px solid var(--chat-line);
  font-size: var(--fs-micro);
  color: var(--chat-ink-soft);
}
.sm-msgs-count {
  font-family: var(--font-mono);
}
.sm-msgs {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  overflow-y: auto;
}
.sm-msgs-empty {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.sm-msg {
  max-width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--chat-line);
  border-radius: var(--radius-chip, 8px);
  background: var(--chat-surface);
}
.sm-msg.is-outbound {
  background: var(--chat-surface-raised, var(--chat-surface));
}
.sm-msg-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-bottom: 4px;
}
.sm-msg-dir {
  overflow: hidden;
  font-size: var(--fs-micro);
  color: var(--chat-ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sm-msg-arrow {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--chat-ink-faint);
}
.sm-msg-state {
  flex: 0 0 auto;
}
.sm-msg-time {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
}
.sm-msg-text {
  overflow-wrap: anywhere;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--chat-ink);
  white-space: pre-wrap;
}
.empty-icon {
  font-size: 22px;
  color: var(--chat-ink-faint);
}
.sm-empty {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px;
}
.empty-title {
  margin: 0;
  font-size: 12.5px;
  color: var(--chat-ink-soft);
}
.empty-hint {
  margin: 0;
  max-width: 420px;
  text-align: center;
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
}
.spin {
  animation: sm-spin 1s linear infinite;
}
@keyframes sm-spin {
  to { transform: rotate(360deg); }
}
</style>
