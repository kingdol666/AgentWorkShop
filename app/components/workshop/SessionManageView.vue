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
import { useWorkshopApi, type ChannelMode, type ChannelSessionSummaryDto, type ChannelMessageDto, type SessionBriefDto, type SessionHistoryDto } from '@/app/composables/workshop/useWorkshopApi'
import type { ProductView } from '#shared/dcw-protocol'

const { t } = useI18n()

const props = defineProps<{
  channelId: string
  /** 嵌入对话页：隐藏自身页头与会话卡栏，只渲染 selectedSessionId 的会话详情。 */
  embedded?: boolean
  /** 嵌入模式由父层控制的选中会话；null = 群聊（本组件不抢选第一个）。 */
  selectedSessionId?: string | null
}>()
const emit = defineEmits<{
  (e: 'openAgent', id: string): void
  (e: 'select-session', id: string | null): void
  (e: 'sessions-changed'): void
}>()

const api = useWorkshopApi()

// ===== 数据面 =====
const sessions = ref<ChannelSessionSummaryDto[]>([])
/** 侧栏会话迷你列表共享的版本号：本视图的增删改都 bump 一次。 */
const sessionListRevision = useState<number>('aw-session-list-revision', () => 0)
/** 会话增删改后同时通知侧栏与嵌入宿主（会话条/选中项）。 */
function notifySessionsChanged(): void {
  sessionListRevision.value += 1
  emit('sessions-changed')
}
const agentById = ref<Record<string, { id: string, name: string, enabled?: number, harness: string }>>({})
const queueByAgent = ref<Record<string, { state: string, queuedCount: number, completedCount: number }>>({})
const loading = ref(true)
const loadError = ref('')

const activeSessionId = ref<string | null>(null)
const messages = ref<ChannelMessageDto[]>([])
const messagesLoading = ref(false)
const brief = ref<SessionBriefDto | null>(null)
/** 注入 v2：prompt 前最终装配文本（分层块），供「注入预览」展示 */
const briefBlock = ref<string | null>(null)
const history = ref<SessionHistoryDto[]>([])
const composerText = ref('')
const sending = ref(false)
let messagesSeq = 0
let contextSeq = 0
let loadAllSeq = 0
let productsSeq = 0
const pendingSessionSend = ref<{ sessionId: string, text: string, clientMessageId: string } | null>(null)
const newClientMessageId = (): string => {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const activeSession = computed(() => sessions.value.find(s => s.id === activeSessionId.value) ?? null)

// Channel 产品绑定与 DCW 产品目录(创建会话时必须选择已绑定产品)
const channelMode = ref<ChannelMode | null>(null)
const channelProductIds = ref<string[]>([])
const productRevision = ref(0)
const dcwProducts = ref<ProductView[]>([])
const createProductId = ref<string | undefined>()
const productsLoading = ref(false)
const productsError = ref('')
const boundProducts = computed(() => {
  const ids = new Set(channelProductIds.value)
  return dcwProducts.value.filter(product => ids.has(product.id))
})
const productName = (productId?: string | null): string =>
  dcwProducts.value.find(product => product.id === productId)?.name ?? productId ?? '—'
const snapshotHashLabel = (hash?: string): string => hash || '—'
async function loadProducts(): Promise<void> {
  const seq = ++productsSeq
  const channelId = props.channelId
  productsLoading.value = true
  productsError.value = ''
  channelMode.value = null
  try {
    const channels = await api.listChannels()
    if (seq !== productsSeq || channelId !== props.channelId) return
    const channel = channels.data?.find(channel => channel.id === channelId)
    if (!channel) throw new Error(t('sessionManage.channelUnavailable'))
    channelMode.value = channel.channelMode === 'production_line_integrated' ? 'production_line_integrated' : 'generic'
    if (channelMode.value === 'generic') return
    const [bindings, catalog] = await Promise.all([api.getChannelProducts(channelId), api.getDcwCatalog()])
    if (seq !== productsSeq || channelId !== props.channelId) return
    channelProductIds.value = bindings.data?.productIds ?? []
    productRevision.value = bindings.data?.revision ?? 0
    dcwProducts.value = (catalog.data?.products ?? bindings.data?.products ?? [])
      .filter(product => channel.lineId && product.lineId === channel.lineId)
  }
  catch (err) {
    if (seq !== productsSeq || channelId !== props.channelId) return
    productsError.value = apiErrorMessage(err)
  }
  finally {
    if (seq === productsSeq && channelId === props.channelId) productsLoading.value = false
  }
}

/** cloneId → 成员静态面(名称/启停);memberMap 的 clone 可能已被移除(移除即无行) */
function cloneInfo(cloneId: string) {
  return agentById.value[cloneId] ?? null
}
function cloneState(cloneId: string) {
  return queueByAgent.value[cloneId] ?? null
}
/** /queue 行 → agentId 索引的运行态面（loadAll 与轮询共用同一映射;幂等:无差异不重写） */
function applyQueue(rows: Array<{ agentId: string, state: string, queuedCount: number, completedCount: number }>): void {
  const next = Object.fromEntries(rows.map(x => [x.agentId, { state: x.state, queuedCount: x.queuedCount, completedCount: x.completedCount }]))
  if (JSON.stringify(next) !== JSON.stringify(queueByAgent.value)) queueByAgent.value = next
}
function sessionClones(s: ChannelSessionSummaryDto): string[] {
  return Object.values(s.memberMap ?? {})
}
const stateLabel = (state: string): string =>
  state === 'busy' ? t('sessionManage.stateBusy') : state === 'stopped' ? t('sessionManage.stateStopped') : t('sessionManage.stateIdle')

async function loadAll(options: { autoSelect?: boolean } = {}): Promise<void> {
  const seq = ++loadAllSeq
  const channelId = props.channelId
  loading.value = true
  loadError.value = ''
  const [sess, agents, queue] = await Promise.allSettled([
    api.listChannelSessions(channelId),
    api.listChannelAgents(channelId),
    api.queueOverview(channelId),
  ])
  // 快速切频道/重试:旧代际响应不得写回,也不得取消新一代的产物加载
  if (seq !== loadAllSeq || channelId !== props.channelId) return
  void loadProducts()
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
    applyQueue(queue.value.data ?? [])
  }
  else {
    queueByAgent.value = {}
  }
  loading.value = false
  if (props.embedded) {
    // 嵌入对话页：选中权归父层（群聊 = null），本组件不得自动抢选第一个会话。
    const target = props.selectedSessionId
      ? sessions.value.find(s => s.id === props.selectedSessionId)
      : undefined
    if (target) await selectSession(target)
    else if (activeSessionId.value) {
      activeSessionId.value = null
      messages.value = []
      brief.value = null
      briefBlock.value = null
      history.value = []
    }
    return
  }
  // 自动选中:优先第一个 active 会话,否则第一个(归档路径传 autoSelect:false,由调用方只选一次)
  if (options.autoSelect !== false && (!activeSessionId.value || !sessions.value.some(s => s.id === activeSessionId.value))) {
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

async function loadMessages(s: ChannelSessionSummaryDto): Promise<void> {
  const seq = ++messagesSeq
  messagesLoading.value = true
  try {
    const cloneIds = new Set(sessionClones(s))
    const res = await api.listChannelMessages(props.channelId, 500)
    if (seq !== messagesSeq || activeSessionId.value !== s.id) return
    const rows = (res.data ?? []).filter(m =>
      (m.fromAgentId != null && cloneIds.has(m.fromAgentId)) || (m.toAgentId != null && cloneIds.has(m.toAgentId)),
    )
    rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    const next = rows.slice(-300)
    // 幂等更新:数据没变不重写 ref(轮询每 10s 一次,无差异重渲染会造成整列表 DOM 补丁风暴)
    const sig = (list: ChannelMessageDto[]) => list.map(m => `${m.id}:${m.state}`).join('|')
    if (sig(next) !== sig(messages.value)) messages.value = next
  }
  catch (err) {
    if (seq === messagesSeq && activeSessionId.value === s.id) messages.value = []
    if (isAuthError(err)) stopPoll()
  }
  finally {
    if (seq === messagesSeq) messagesLoading.value = false
  }
}

/** Session Context：brief/block/history 与消息并行拉取；失败不阻断消息面。 */
async function loadContext(s: ChannelSessionSummaryDto): Promise<void> {
  const seq = ++contextSeq
  const [b, h, blk] = await Promise.allSettled([
    api.getSessionBrief(props.channelId, s.id),
    api.getSessionHistory(props.channelId, s.id, 80),
    api.getSessionBlock(props.channelId, s.id),
  ])
  if (seq !== contextSeq || activeSessionId.value !== s.id) return
  brief.value = b.status === 'fulfilled' ? (b.value.data ?? null) : null
  history.value = h.status === 'fulfilled' ? (h.value.data ?? []) : []
  briefBlock.value = blk.status === 'fulfilled' ? (blk.value.data?.block ?? null) : null
}

const isManualSession = computed(() => {
  const kind = activeSession.value?.instanceKind
  return !kind || kind === 'manual'
})

async function sendMessage(): Promise<void> {
  const text = composerText.value.trim()
  const session = activeSession.value
  if (!text || !session || sending.value) return
  sending.value = true
  try {
    const pending = pendingSessionSend.value?.sessionId === session.id && pendingSessionSend.value.text === text
      ? pendingSessionSend.value
      : { sessionId: session.id, text, clientMessageId: newClientMessageId() }
    pendingSessionSend.value = pending
    await api.sendSessionMessage(props.channelId, session.id, { text, clientMessageId: pending.clientMessageId })
    pendingSessionSend.value = null
    composerText.value = ''
    await Promise.all([loadMessages(session), loadContext(session)])
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally { sending.value = false }
}

async function selectSession(s: ChannelSessionSummaryDto): Promise<void> {
  activeSessionId.value = s.id
  // 切换即清空旧内容：旧请求返回后会按 sessionId/seq 丢弃，不会落到新标题下。
  messages.value = []
  brief.value = null
  briefBlock.value = null
  history.value = []
  await Promise.all([loadMessages(s), loadContext(s)])
}

/** 嵌入模式：父层切换会话时跟随；选中 id 失效（归档/删除）则清空详情等父层回落群聊。 */
watch(() => props.selectedSessionId, (id) => {
  if (!props.embedded) return
  const target = id ? sessions.value.find(s => s.id === id) : undefined
  if (target) void selectSession(target)
  else {
    messagesSeq += 1
    contextSeq += 1
    activeSessionId.value = null
    messages.value = []
    brief.value = null
    briefBlock.value = null
    history.value = []
  }
})

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
      void loadContext(cur)
      void refreshRuntime()
    }, 10_000)
  }
})
onBeforeUnmount(stopPoll)

async function refreshRuntime(): Promise<void> {
  try {
    const q = await api.queueOverview(props.channelId)
    applyQueue(q.data ?? [])
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
  const productId = createProductId.value
  if (!channelMode.value || creating.value || (channelMode.value === 'production_line_integrated' && (!productId || !channelProductIds.value.includes(productId)))) return
  creating.value = true
  try {
    const res = await api.createChannelSession(props.channelId, { title: createTitle.value.trim() || undefined, productId: channelMode.value === 'production_line_integrated' ? productId : undefined })
    message.success(t('sessionManage.createOkMsg', { p0: res.data?.members?.length ?? 0 }))
    createOpen.value = false
    createTitle.value = ''
    createProductId.value = undefined
    await loadAll()
    notifySessionsChanged()
    if (res.data?.sessionId) {
      const s = sessions.value.find(x => x.id === res.data!.sessionId)
      if (s) {
        await selectSession(s)
        emit('select-session', s.id)
      }
    }
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally { creating.value = false }
}

// ===== 关闭会话(级联;幂等) =====
const closing = ref<string | null>(null)
async function submitClose(s: ChannelSessionSummaryDto): Promise<void> {
  closing.value = s.id
  try {
    const res = await api.closeChannelSession(props.channelId, s.id, { reason: 'owner closed from console' })
    message.success(t('sessionManage.closeOk', { p0: s.title, p1: res.data?.canceledTasks ?? 0 }))
    await loadAll()
    notifySessionsChanged()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally { closing.value = null }
}

// ===== 会话改名(仅展示标题) =====
const renameOpen = ref(false)
const renameTitle = ref('')
const renaming = ref(false)
function openRename(s: ChannelSessionSummaryDto): void {
  renameTitle.value = s.title
  renameOpen.value = true
}
async function submitRename(): Promise<void> {
  const session = activeSession.value
  const title = renameTitle.value.trim()
  if (!session || !title || renaming.value) return
  renaming.value = true
  try {
    const res = await api.renameChannelSession(props.channelId, session.id, { title })
    const next = res.data?.title ?? title
    const row = sessions.value.find(item => item.id === session.id)
    if (row) row.title = next
    renameOpen.value = false
    message.success(t('sessionManage.renameOk', { p0: next }))
    notifySessionsChanged()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally { renaming.value = false }
}

// ===== 归档会话(active 先关闭级联;归档后从清单隐藏) =====
const archiving = ref<string | null>(null)
async function submitArchive(s: ChannelSessionSummaryDto): Promise<void> {
  archiving.value = s.id
  const removedIndex = sessions.value.findIndex(item => item.id === s.id)
  try {
    const res = await api.archiveChannelSession(props.channelId, s.id)
    message.success(t('sessionManage.archiveOk', { p0: s.title, p1: res.data?.canceledTasks ?? 0 }))
    if (activeSessionId.value === s.id) activeSessionId.value = null
    // 归档后只选一次：先无自动选择地刷新清单，再按原索引选下一个可用会话。
    await loadAll({ autoSelect: false })
    // 优先选中原位置的「下一个」可用会话（列表已移除归档项，索引自然前移）。
    const next = sessions.value[Math.min(Math.max(removedIndex, 0), sessions.value.length - 1)]
    if (next) await selectSession(next)
    emit('select-session', next?.id ?? null)
    notifySessionsChanged()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally { archiving.value = null }
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
  pendingSessionSend.value = null
  createProductId.value = undefined
  channelMode.value = null
  channelProductIds.value = []
  dcwProducts.value = []
  productsError.value = ''
  productRevision.value = 0
  void loadAll()
})

/** 嵌入对话页时由宿主触发「新建会话」（复用本组件已有的产品选择/创建流程）。 */
defineExpose({
  openCreate: (): void => { createOpen.value = true },
  refresh: (): Promise<void> => loadAll(),
})
</script>

<template>
  <div
    class="sm-wrap"
    :class="{ 'is-embedded': embedded }"
  >
    <!-- 头部:标题 + 刷新 + 新建(嵌入对话页时由宿主页头承载) -->
    <header
      v-if="!embedded"
      class="sm-head"
    >
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
          @click="loadAll()"
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
      <aside
        v-if="!embedded"
        class="sm-rail"
      >
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
            {{ t(s.channelMode === 'production_line_integrated' ? 'channelSessionList.modeIntegrated' : 'channelSessionList.modeGeneric') }}
          </div>
          <div class="sm-card-meta">
            {{ s.status === 'closed' && s.closedAt ? t('sessionManage.closedAt', { p0: fmtTime(s.closedAt) }) : t('sessionManage.createdAt', { p0: fmtTime(s.createdAt) }) }}
          </div>
          <div
            v-if="s.productId"
            class="sm-card-product"
          >
            <span>{{ t('sessionManage.product') }}: {{ productName(s.productId) }}</span>
            <code>{{ snapshotHashLabel(s.bindingSnapshotHash) }}</code>
          </div>
          <!-- 项目任务实例（2026-11-07）：会话行携带任务溯源，标明「任务会话」 -->
          <div
            v-if="s.instanceKind === 'task'"
            class="sm-card-task"
          >
            <span class="sm-badge is-task">{{ t('sessionManage.taskBadge') }}</span>
            <span class="sm-task-wi">{{ (s.projectWorkItemId ?? '').slice(0, 10) }}</span>
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
              <h4 data-testid="session-detail-title">
                {{ activeSession.title }}
              </h4>
              <span
                class="sm-badge"
                :class="activeSession.status === 'active' ? 'is-ok' : 'is-muted'"
              >{{ activeSession.status === 'active' ? t('sessionManage.active') : t('sessionManage.closed') }}</span>
              <span class="sm-head-spacer" />
              <button
                v-if="activeSession.instanceKind === 'manual'"
                type="button"
                class="sm-action"
                data-testid="session-rename"
                :disabled="renaming"
                @click="openRename(activeSession)"
              >
                <span
                  class="i-tabler-pencil"
                  aria-hidden="true"
                />
                <span>{{ t('sessionManage.rename') }}</span>
              </button>
              <ConfirmPopover
                v-if="activeSession.instanceKind === 'manual'"
                :title="t('sessionManage.archiveConfirmTitle')"
                :description="t('sessionManage.archiveConfirm')"
                :ok-text="t('sessionManage.archive')"
                placement="bottomRight"
                @confirm="submitArchive(activeSession)"
              >
                <button
                  type="button"
                  class="sm-action"
                  data-testid="session-archive"
                  :disabled="archiving === activeSession.id"
                  :aria-busy="archiving === activeSession.id"
                >
                  <span
                    :class="archiving === activeSession.id ? 'i-tabler-loader-2 spin' : 'i-tabler-archive'"
                    aria-hidden="true"
                  />
                  <span>{{ t('sessionManage.archive') }}</span>
                </button>
              </ConfirmPopover>
              <ConfirmPopover
                v-if="activeSession.status === 'active'"
                :title="t('sessionManage.closeConfirmTitle')"
                :description="t('sessionManage.closeConfirm')"
                :ok-text="t('sessionManage.closeBtn')"
                placement="bottomRight"
                @confirm="submitClose(activeSession)"
              >
                <button
                  type="button"
                  class="sm-close"
                  :disabled="closing === activeSession.id"
                  :aria-busy="closing === activeSession.id"
                >
                  <span
                    :class="closing === activeSession.id ? 'i-tabler-loader-2 spin' : 'i-tabler-x'"
                    aria-hidden="true"
                  />
                  <span>{{ t('sessionManage.closeBtn') }}</span>
                </button>
              </ConfirmPopover>
            </div>
            <div
              v-if="activeSession.productId"
              class="sm-session-product"
            >
              <span>{{ t('sessionManage.product') }}: {{ productName(activeSession.productId) }} · {{ t('sessionManage.snapshotRevision') }} {{ activeSession.bindingSnapshotRevision ?? '—' }}</span>
              <code :title="activeSession.bindingSnapshotHash || ''">{{ t('sessionManage.snapshotHash') }}: {{ snapshotHashLabel(activeSession.bindingSnapshotHash) }}</code>
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

            <workshop-session-runtime-panel
              :channel-id="channelId"
              :session-id="activeSession.id"
              @changed="emit('sessions-changed')"
            />
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
          <div
            v-if="brief"
            class="sm-brief"
          >
            <div class="sm-brief-row">
              <span class="sm-brief-label">Session Context</span>
              <b>{{ brief.nextStep }}</b>
            </div>
            <div class="sm-brief-row muted">
              <span>{{ t('sessionManage.briefCurrentTask', { p0: brief.currentTask?.title ?? '—' }) }}</span>
              <span>{{ brief.currentTask?.state ?? '—' }} · {{ brief.currentTask?.progress ?? 0 }}%</span>
              <span>{{ t('sessionManage.briefDeliverables', { p0: brief.deliverables.length }) }}</span>
              <span>{{ t('sessionManage.briefOpen', { p0: brief.openQuestions.length }) }}</span>
            </div>
            <p
              v-if="brief.openQuestions.length"
              class="sm-brief-open"
            >
              {{ t('sessionManage.briefOpenList', { p0: brief.openQuestions.join('；') }) }}
            </p>
            <details
              v-if="briefBlock"
              class="sm-block-preview"
            >
              <summary>{{ t('sessionManage.blockPreview') }}</summary>
              <pre>{{ briefBlock }}</pre>
            </details>
          </div>
          <div class="sm-compose">
            <a-textarea
              v-model:value="composerText"
              :rows="2"
              :maxlength="8000"
              :disabled="!isManualSession || activeSession.status !== 'active'"
              :placeholder="t(isManualSession ? 'sessionManage.composePhManual' : 'sessionManage.composePhReadonly')"
              @keydown.ctrl.enter.prevent="sendMessage"
              @keydown.meta.enter.prevent="sendMessage"
            />
            <div class="sm-compose-actions">
              <span class="muted">{{ t(isManualSession ? 'sessionManage.composeHintManual' : 'sessionManage.composeHintReadonly') }}</span>
              <a-button
                type="primary"
                size="small"
                :loading="sending"
                :disabled="!composerText.trim() || !isManualSession || activeSession.status !== 'active'"
                @click="sendMessage"
              >
                {{ t('sessionManage.send') }}
              </a-button>
            </div>
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

    <!-- 改名弹窗(仅展示标题;不改会话状态) -->
    <a-modal
      v-model:open="renameOpen"
      :title="t('sessionManage.renameTitle')"
      :confirm-loading="renaming"
      :ok-text="t('sessionManage.renameOkBtn')"
      :cancel-text="t('sessionManage.createCancel')"
      :ok-button-props="{ disabled: !renameTitle.trim() }"
      @ok="submitRename"
    >
      <a-input
        v-model:value="renameTitle"
        data-testid="session-rename-input"
        :maxlength="120"
        show-count
        :placeholder="t('sessionManage.renamePlaceholder')"
        @press-enter="submitRename"
      />
    </a-modal>

    <!-- 新建会话弹窗(克隆全部基础成员;标题可选) -->
    <a-modal
      v-model:open="createOpen"
      :title="t('sessionManage.create')"
      :confirm-loading="creating"
      :ok-text="t('sessionManage.createOk')"
      :cancel-text="t('sessionManage.createCancel')"
      :ok-button-props="{ disabled: !channelMode || productsLoading || !!productsError || (channelMode === 'production_line_integrated' && (!createProductId || !channelProductIds.includes(createProductId))) }"
      @ok="submitCreate"
    >
      <a-input
        v-model:value="createTitle"
        :placeholder="t('sessionManage.createTitlePh')"
        :maxlength="120"
      />
      <a-alert
        v-if="productsError && channelMode !== 'production_line_integrated'"
        type="error"
        show-icon
        :message="productsError"
      />
      <a-form-item
        v-if="channelMode === 'production_line_integrated'"
        :label="t('sessionManage.productLabel')"
        required
      >
        <a-select
          v-model:value="createProductId"
          show-search
          option-filter-prop="label"
          :loading="productsLoading"
          :disabled="productsLoading || !boundProducts.length || (!!createProductId && !channelProductIds.includes(createProductId))"
          :options="boundProducts.map(product => ({ value: product.id, label: product.name }))"
          :placeholder="t('sessionManage.productPlaceholder')"
        />
        <a-alert
          v-if="productsError"
          class="create-product-error"
          type="error"
          show-icon
          :message="productsError"
        />
        <div
          v-else-if="!productsLoading && !boundProducts.length"
          class="sm-create-hint"
        >
          {{ t('sessionManage.noBoundProducts') }}
        </div>
      </a-form-item>
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
/* 对话页内嵌：不重复页头/会话卡栏，详情吃满画布并与 chat 画布同底 */
.sm-wrap.is-embedded {
  background: var(--chat-canvas);
}
.sm-wrap.is-embedded .sm-body {
  flex: 1 1 auto;
  min-height: 0;
}
.sm-wrap.is-embedded .sm-detail {
  border: 0;
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
.sm-card-product,
.sm-session-product {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  font-size: var(--fs-micro);
  color: var(--chat-ink-soft);
}
.sm-card-product code,
.sm-session-product code {
  max-width: 100%;
  overflow: hidden;
  font-family: var(--font-mono);
  color: var(--chat-ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sm-card-task {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sm-badge.is-task {
  background: color-mix(in srgb, var(--chat-accent) 14%, transparent);
  color: var(--chat-ink);
}
.sm-task-wi {
  font-family: var(--font-mono);
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
/* 关闭会话:标题栏里的"安静危险"控件。
 * 之前的 antd danger 小按钮把 14px 字塞进 24px 高,17px 的方框叉号还压着文字,
 * 描边又是组件库自带的那支红 —— 整条标题栏最抢眼的成了这个低频动作。
 * 现在:语义红浅底(--tone-danger-bg)+ 朱红字(--tone-danger-dot),26px 高、
 * 12.5px/600、13px 的单线叉号;静息不描边(与徽标同一档"面色"),悬停才起边,
 * 实心红只出现在确认框的按钮上。 */
.sm-close {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 5px;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  font-family: var(--font-body);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1;
  color: var(--tone-danger-dot);
  cursor: pointer;
  background: var(--tone-danger-bg);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    opacity var(--transition-fast),
    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
/* 中性行内操作(改名/归档):与危险色关闭按钮区分,常显但低对比 */
.sm-action {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 5px;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  font-family: var(--font-body);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1;
  color: var(--chat-ink-soft);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--chat-line);
  border-radius: var(--radius-control);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast),
    opacity var(--transition-fast);
}
.sm-action > span[class*="i-tabler"] {
  width: 13px;
  height: 13px;
}
.sm-action:hover:not(:disabled) {
  color: var(--chat-ink);
  background: color-mix(in srgb, var(--chat-ink) 6%, transparent);
  border-color: var(--chat-line-strong);
}
.sm-action:focus-visible {
  outline: 2px solid var(--chat-accent);
  outline-offset: 1px;
}
.sm-action:disabled {
  cursor: progress;
  opacity: 0.6;
}
.sm-close > span[class*="i-tabler"] {
  width: 13px;
  height: 13px;
}
.sm-close:hover:not(:disabled) {
  background: color-mix(in srgb, var(--tone-danger-dot) 12%, var(--tone-danger-bg));
  border-color: color-mix(in srgb, var(--tone-danger-dot) 32%, transparent);
}
.sm-close:active:not(:disabled) {
  transform: scale(0.97);
}
.sm-close:disabled {
  cursor: progress;
  opacity: 0.7;
}
.sm-create-hint,
.create-product-error {
  margin-top: 8px;
}
.sm-create-hint {
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
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
.sm-brief {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  margin: 8px 12px 0;
  background: var(--chat-surface-raised);
  border: 1px solid var(--chat-line);
  border-radius: var(--radius-control);
}
.sm-brief-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: baseline;
  font-size: 12px;
  color: var(--chat-ink);
}
.sm-brief-label {
  padding: 1px 6px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-chip);
}
.sm-brief-row.muted {
  font-size: 11.5px;
  color: var(--chat-ink-faint);
}
.sm-brief-open {
  margin: 0;
  font-size: 11.5px;
  color: var(--tone-warning-dot);
}
.sm-block-preview {
  margin-top: 4px;
  font-size: 11.5px;
}
.sm-block-preview summary {
  cursor: pointer;
  color: var(--chat-ink-faint);
  user-select: none;
}
.sm-block-preview pre {
  max-height: 260px;
  margin: 6px 0 0;
  padding: 10px 12px;
  overflow: auto;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 1.6;
  color: var(--chat-ink-soft);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--chat-canvas);
  border: 1px solid var(--chat-line);
  border-radius: 8px;
}
.sm-compose {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px 12px;
}
.sm-compose-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
}
.sm-compose-actions .muted {
  font-size: 11px;
  color: var(--chat-ink-faint);
}
/* 窄屏：会话列表在上、详情在下；否则 320px rail + 详情在 390px 视口里被裁切 */
@media (max-width: 760px) {
  .sm-body {
    flex-direction: column;
  }
  .sm-rail {
    flex: 0 0 auto;
    max-height: 38vh;
    padding: 10px;
    border-right: 0;
    border-bottom: 1px solid var(--chat-line);
  }
  .sm-detail {
    flex: 1 1 auto;
    min-height: 0;
  }
  .sm-detail-head {
    padding: 10px 12px;
  }
  .sm-detail-title {
    flex-wrap: wrap;
    row-gap: 6px;
  }
  .sm-detail-title h4 {
    white-space: normal;
  }
  .sm-msgs {
    padding: 10px 12px;
  }
  .sm-brief {
    margin-inline: 10px;
  }
  .sm-compose {
    padding: 8px 10px 12px;
  }
  .sm-compose-actions {
    align-items: flex-end;
  }
}
.spin {
  animation: sm-spin 1s linear infinite;
}
@keyframes sm-spin {
  to { transform: rotate(360deg); }
}
</style>
