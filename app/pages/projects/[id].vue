<script setup lang="ts">
/**
 * /projects/:id —— 项目详情（V1 最小可用页）。
 * 覆盖：概览、频道、计划/交付物、工作项派发、成果提交/复核/验收、审计。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { mdLite } from '@/app/composables/workshop/useEventBlocks'
import type { AepChatMessage } from '#shared/workshop-protocol'

definePageMeta({ layout: 'default' })

interface ProjectDto {
  id: string
  name: string
  description: string
  objective: string
  status: string
  mode: string
  ownerUserId: string
  officeChannelId: string | null
  leadAgentId: string | null
  planVersion: number
  planJson?: string
  createdAt: string
  updatedAt: string
}
interface ChannelBindingDto { projectId: string, channelId: string, bindingType: string, charter: string, status: string }
interface DeliverableDto { id: string, name: string, ownerChannelId: string | null, required: number, status: string, acceptanceCriteriaJson: string }
interface WorkItemDto { id: string, deliverableId: string, channelId: string, title: string, state: string, stateReason: string | null, currentAttemptId: string | null, execBudgetMinutes: number }
interface ResultDto { id: string, deliverableId: string, channelId: string, title: string, summary: string, status: string, version: number, evidenceJson: string, reviewedBy: string | null, approvedBy: string | null }
interface ApprovalDto { id: string, kind: string, subjectId: string, status: string, expiresAt: string | null, payloadJson?: string, reason?: string, argsDigest?: string }
interface DecisionDto { id: string, seq: number, decisionType: string, state: string, outcome: string, traceId: string, createdAt: string }
interface EventDto { id: string, seq: number, type: string, eventKey: string, traceId: string, createdAt: string }

const route = useRoute()
const id = String(route.params.id)
const http = useHttp()
const loading = ref(false)
const error = ref('')
const project = ref<ProjectDto | null>(null)
const channels = ref<ChannelBindingDto[]>([])
const deliverables = ref<DeliverableDto[]>([])
const workItems = ref<WorkItemDto[]>([])
const results = ref<ResultDto[]>([])
const approvals = ref<ApprovalDto[]>([])
const decisions = ref<DecisionDto[]>([])
const events = ref<EventDto[]>([])

/** PR15 五 tab（plan §7.2）：概览/计划与工作/交付物/审批/决策与事件。 */
type TabKey = 'overview' | 'plan' | 'deliverables' | 'approvals' | 'events'
const activeTab = ref<TabKey>('overview')
const tabs: Array<{ key: TabKey, label: string }> = [
  { key: 'overview', label: '概览' },
  { key: 'plan', label: '计划与工作' },
  { key: 'deliverables', label: '交付物' },
  { key: 'approvals', label: '审批' },
  { key: 'events', label: '决策与事件' },
]

// ===== 持续开发：项目办公室 Leader 对话 =====
const chatMessages = ref<AepChatMessage[]>([])
const chatText = ref('')
const chatLoading = ref(false)
const chatSending = ref(false)
const chatError = ref('')
const chatNotice = ref('')
const chatThread = ref<HTMLElement | null>(null)
const chatInput = ref<HTMLTextAreaElement | null>(null)
const chatInitialized = ref(false)
/** 服务端 access.canManage：只有 owner/admin 可继续开发；加载前默认关闭，避免非 owner 闪现可提交入口 */
const canManageProject = ref(false)
let chatTimer: ReturnType<typeof setInterval> | null = null

const canContinueProject = computed(() => Boolean(
  canManageProject.value
  && project.value?.officeChannelId
  && project.value?.leadAgentId
  && project.value.status !== 'archived'
  && project.value.status !== 'draft',
))

function formatChatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function scrollChatToBottom(force = false): void {
  void nextTick(() => {
    const el = chatThread.value
    if (!el) return
    // 轮询刷新时，用户可能正在往上读历史；只有本来就在底部才跟随新消息。
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (force || nearBottom) el.scrollTop = el.scrollHeight
  })
}

function focusContinue(): void {
  activeTab.value = 'overview'
  void nextTick(() => {
    // 以输入框为锚点居中，而不是把对话卡顶端顶到视口上沿：
    // 900px 高的桌面/手机上，卡顶端对齐会把 composer 推到折叠线以下。
    chatInput.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    chatInput.value?.focus({ preventScroll: true })
  })
}

async function loadChat(): Promise<void> {
  const officeChannelId = project.value?.officeChannelId
  if (!officeChannelId) return
  chatLoading.value = true
  try {
    const res = await http.get<{ data: { messages?: AepChatMessage[] } }>(
      `/workshop/channels/${officeChannelId}/chat/messages?limit=100`,
    )
    // 服务端返回新→旧；对话区按时间正序渲染。
    chatMessages.value = [...(res.data?.messages ?? [])].reverse()
    chatError.value = ''
    scrollChatToBottom(!chatInitialized.value)
    chatInitialized.value = true
  }
  catch (e) {
    if (!chatMessages.value.length) chatError.value = e instanceof Error ? e.message : '对话加载失败'
  }
  finally {
    chatLoading.value = false
  }
}

async function sendContinuation(): Promise<void> {
  const text = chatText.value.trim()
  if (!text || chatSending.value || !canContinueProject.value) return
  chatSending.value = true
  chatError.value = ''
  chatNotice.value = ''
  try {
    const res = await http.post<{
      data: {
        project: ProjectDto
        reopened: boolean
        chatMessageId: string
        deliveries: Array<{ deliveryId: string, agentId: string, status: string }>
        duplicates: boolean
      }
    }>(`/workshop/projects/${id}/continue`, {
      message: text,
      clientMessageId: `project-continue-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    })
    project.value = res.data.project
    chatText.value = ''
    const delivered = res.data.deliveries.filter(d => d.status === 'delivered' || d.status === 'consumed').length
    chatNotice.value = res.data.reopened
      ? `项目已重新打开；需求已发给 Project Leader（已投递 ${delivered} 个目标），批准增量计划后继续派发。`
      : `需求已发给 Project Leader（已投递 ${delivered} 个目标）。`
    await Promise.all([load(), loadChat(), loadObservability()])
    scrollChatToBottom(true)
  }
  catch (e) {
    chatError.value = e instanceof Error ? e.message : '发送失败'
  }
  finally {
    chatSending.value = false
  }
}

const bindForm = reactive({ channelId: '', charter: '' })
const deliverableForm = reactive({ name: '', ownerChannelId: '', acceptance: '' })
const workForm = reactive({ deliverableId: '', channelId: '', title: '', brief: '', execBudgetMinutes: 60 })

const pendingApprovals = computed(() => approvals.value.filter(a => a.status === 'pending'))
const currentResults = computed(() => results.value)

// ── 页面展示派生值（只读；不改业务状态） ─────────────────────────────────
const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  archived: '已归档',
}

function statusText(status?: string): string {
  return STATUS_LABEL[status ?? ''] ?? (status || '—')
}

/** 工作项 / 成果 / 审批 / 绑定状态的中文展示；未知值原样透出。 */
const STATE_LABEL: Record<string, string> = {
  draft: '草稿',
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  archived: '已归档',
  planned: '计划中',
  approved: '已验收',
  waived: '已豁免',
  submitted: '已提交',
  reviewed: '已复核',
  rejected: '已驳回',
  pending: '待处理',
  expired: '已过期',
  dispatched: '已派发',
  running: '执行中',
  failed: '失败',
  canceled: '已取消',
  superseded: '已替代',
  blocked: '阻塞',
  detached: '已解绑',
  disabled: '已停用',
}

function stateText(value?: string): string {
  if (!value) return '—'
  return STATE_LABEL[value.toLowerCase()] ?? value
}

/** 审批语境：approved 是“已批准”，不是交付物的“已验收”。 */
const APPROVAL_STATE_LABEL: Record<string, string> = {
  pending: '待处理',
  approved: '已批准',
  rejected: '已拒绝',
  expired: '已过期',
}

function approvalText(value?: string): string {
  if (!value) return '—'
  return APPROVAL_STATE_LABEL[value.toLowerCase()] ?? stateText(value)
}

/** 审批类型的人话标签；原始 kind 保留在 title 中。 */
const APPROVAL_KIND_LABEL: Record<string, string> = {
  plan_approval: '计划批准',
  deliverable_acceptance: '交付物验收',
  result_acceptance: '成果验收',
  project_complete: '项目完成',
}

function approvalKindText(value?: string): string {
  if (!value) return '—'
  return APPROVAL_KIND_LABEL[value] ?? value
}

/** 绑定语境：active 是“已绑定”，不是项目的“进行中”。 */
function bindingText(value?: string): string {
  if (value === 'active') return '已绑定'
  if (value === 'detached') return '已解绑'
  return stateText(value)
}

/** 状态只映射到语义 tone，不新增颜色。 */
function statusTone(status?: string): string {
  if (status === 'active') return 'green'
  if (status === 'completed') return 'blue'
  if (status === 'paused') return 'amber'
  if (status === 'archived') return 'gray'
  return 'neutral'
}

const workStats = computed(() => {
  const total = workItems.value.length
  const done = workItems.value.filter(w => w.state === 'COMPLETED').length
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0 }
})

const deliverableStats = computed(() => {
  const total = deliverables.value.length
  const approved = deliverables.value.filter(d => d.status === 'approved').length
  const required = deliverables.value.filter(d => d.required)
  const requiredApproved = required.filter(d => d.status === 'approved').length
  return { total, approved, requiredTotal: required.length, requiredApproved }
})

const activeChannels = computed(() => channels.value.filter(c => c.status === 'active'))
const channelOptions = computed(() => activeChannels.value.map(c => ({
  value: c.channelId,
  label: c.charter ? `${c.channelId.slice(0, 8)}… · ${c.charter}` : c.channelId,
})))
const deliverableOptions = computed(() => deliverables.value.map(d => ({ value: d.id, label: d.name })))

/** 对话正文走 mdLite（先转义再注入受控标记），避免直接渲染裸 Markdown 源码。 */
function renderChat(text: string): string {
  return mdLite(text)
}

function tabCount(key: TabKey): number | null {
  if (key === 'plan') return workItems.value.length || null
  if (key === 'deliverables') return deliverables.value.length || null
  if (key === 'approvals') return pendingApprovals.value.length || null
  if (key === 'events') return events.value.length || null
  return null
}

/** acceptanceCriteriaJson 是字符串列；解析失败按无 criteria 处理，不阻塞列表。 */
function criteriaOf(d: DeliverableDto): string[] {
  try {
    const parsed: unknown = JSON.parse(d.acceptanceCriteriaJson || '[]')
    return Array.isArray(parsed) ? parsed.map(String) : []
  }
  catch {
    return []
  }
}

async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  loading.value = true
  error.value = ''
  try {
    return await fn()
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败'
    return undefined
  }
  finally {
    loading.value = false
  }
}

async function load(): Promise<void> {
  await run(async () => {
    const [p, ch, d, w, r, a, dec, ev] = await Promise.all([
      http.get<{ data: ProjectDto }>(`/workshop/projects/${id}`),
      http.get<{ data: ChannelBindingDto[] }>(`/workshop/projects/${id}/channels`),
      http.get<{ data: DeliverableDto[] }>(`/workshop/projects/${id}/deliverables`),
      http.get<{ data: WorkItemDto[] }>(`/workshop/projects/${id}/work-items`),
      http.get<{ data: ResultDto[] }>(`/workshop/projects/${id}/results`),
      http.get<{ data: ApprovalDto[] }>(`/workshop/projects/${id}/approvals`),
      http.get<{ data: DecisionDto[] }>(`/workshop/projects/${id}/decisions`),
      http.get<{ data: EventDto[] }>(`/workshop/projects/${id}/events`),
    ])
    project.value = p.data
    channels.value = ch.data ?? []
    deliverables.value = d.data ?? []
    workItems.value = w.data ?? []
    results.value = r.data ?? []
    approvals.value = a.data ?? []
    decisions.value = dec.data ?? []
    events.value = ev.data ?? []
    if (!workForm.deliverableId && deliverables.value[0]) workForm.deliverableId = deliverables.value[0].id
    if (!workForm.channelId && activeChannels.value[0]) workForm.channelId = activeChannels.value[0].channelId
    if (!deliverableForm.ownerChannelId && activeChannels.value[0]) deliverableForm.ownerChannelId = activeChannels.value[0].channelId
  })
  await loadChat()
}

async function lifecycle(action: 'activate' | 'pause' | 'resume' | 'archive' | 'reconcile'): Promise<void> {
  await run(async () => {
    if (action === 'reconcile') await http.post(`/workshop/projects/${id}/reconcile`, {})
    else await http.post(`/workshop/projects/${id}/${action}`, {})
    await load()
  })
}

async function completeProject(): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/complete`, {})
    await load()
  })
}

async function bindChannel(): Promise<void> {
  if (!bindForm.channelId.trim()) return
  await run(async () => {
    await http.post(`/workshop/projects/${id}/channels`, { channelId: bindForm.channelId.trim(), charter: bindForm.charter.trim() })
    bindForm.channelId = ''
    bindForm.charter = ''
    await load()
  })
}

async function createDeliverable(): Promise<void> {
  if (!deliverableForm.name.trim()) return
  await run(async () => {
    await http.post(`/workshop/projects/${id}/deliverables`, {
      name: deliverableForm.name.trim(),
      ownerChannelId: deliverableForm.ownerChannelId || undefined,
      acceptanceCriteria: deliverableForm.acceptance ? deliverableForm.acceptance.split('\n').filter(Boolean) : [],
    })
    deliverableForm.name = ''
    deliverableForm.acceptance = ''
    await load()
  })
}

async function createWorkItem(): Promise<void> {
  if (!workForm.title.trim() || !workForm.deliverableId || !workForm.channelId) return
  await run(async () => {
    await http.post(`/workshop/projects/${id}/work-items`, {
      deliverableId: workForm.deliverableId,
      channelId: workForm.channelId,
      title: workForm.title.trim(),
      brief: workForm.brief.trim(),
      execBudgetMinutes: Number(workForm.execBudgetMinutes) || 60,
      dedupeKey: `ui:${workForm.title.trim()}`,
    })
    workForm.title = ''
    workForm.brief = ''
    await load()
  })
}

async function dispatch(workItemId: string): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/work-items/${workItemId}/dispatch`, {})
    await load()
  })
}

async function submitResult(result: ResultDto): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/results/${result.id}/submit`, {
      summary: result.summary || '（由成果页提交）',
    })
    await load()
  })
}

async function review(result: ResultDto, decision: 'reviewed' | 'rejected'): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/results/${result.id}/review`, { decision })
    await load()
  })
}

async function requestAcceptance(result: ResultDto): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/results/${result.id}/request-acceptance`, {})
    await load()
  })
}

async function decide(approval: ApprovalDto, approve: boolean): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/approvals/${approval.id}/decide`, { approve })
    await load()
  })
}

/** owner 应用 project leader 的派发提案（decision.state='proposed'）。 */
async function applyProposal(decision: DecisionDto): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/proposals/${decision.id}/apply`, {})
    await load()
  })
}

onMounted(load)

/** PR11 周报：拉取 + JSON 导出（与库同源的数字）。 */
interface ReportDto {
  projectId: string
  name: string
  status: string
  planVersion: number
  generatedAt: string
  deliverables?: { total?: number, requiredTotal?: number, requiredApproved?: number }
  workItems?: { total?: number, blocked?: number }
  results?: { total?: number }
  approvals?: { pending?: number }
  progress?: { ratio?: number, completedWorkItems?: number, scoreableWorkItems?: number }
  recentEvents?: { count?: number }
}
const report = ref<ReportDto | null>(null)
async function loadReport(): Promise<void> {
  await run(async () => {
    const r = await http.get<{ data: ReportDto }>(`/workshop/projects/${id}/report`)
    report.value = r.data ?? null
  })
}
function exportReport(): void {
  if (!report.value) return
  const blob = new Blob([JSON.stringify(report.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `weekly-report-${id}.json`
  a.click()
  URL.revokeObjectURL(url)
}
onMounted(loadReport)

/** 审批历史（scope=all）。 */
const approvalHistory = ref<ApprovalDto[]>([])
async function loadHistory(): Promise<void> {
  await run(async () => {
    const r = await http.get<{ data: ApprovalDto[] }>(`/workshop/projects/${id}/approvals?scope=all`)
    approvalHistory.value = r.data ?? []
  })
}
onMounted(loadHistory)

/** 成果按交付物分组（成果 Map）。 */
const resultsByDeliverable = computed(() => deliverables.value.map(d => ({
  deliverable: d,
  results: results.value.filter(r => r.deliverableId === d.id),
})))

/** PR15：当前计划 JSON 美化 + 计划类决策快照（plan §7.2 diff 源）。 */
const planJsonPretty = computed(() => {
  if (!project.value) return ''
  try {
    const parsed = JSON.parse((project.value as unknown as { planJson?: string }).planJson ?? '{}')
    return JSON.stringify(parsed, null, 2)
  }
  catch {
    return '{}'
  }
})
const planDecisions = computed(() => decisions.value.filter(d => d.decisionType.includes('plan')).slice(-10))

/** 重派工作项（FAILED/CANCELED 后新 attempt）。 */
async function retryWorkItem(workItemId: string): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/work-items/${workItemId}/retry`, {})
    await load()
  })
}

/** owner 取消工作项（完成门豁免入口）。 */
async function cancelWorkItem(workItemId: string): Promise<void> {
  const reason = window.prompt('取消工作项的理由：') ?? ''
  if (!reason.trim()) return
  await run(async () => {
    await http.post(`/workshop/projects/${id}/work-items/${workItemId}/cancel`, { reason })
    await load()
  })
}

/** owner 豁免交付物（完成门豁免入口）。 */
async function waiveDeliverable(deliverableId: string): Promise<void> {
  const reason = window.prompt('豁免交付物的理由：') ?? ''
  if (!reason.trim()) return
  await run(async () => {
    await http.post(`/workshop/projects/${id}/deliverables/${deliverableId}/waive`, { reason })
    await load()
  })
}

// ===== Router v3 P3：执行工作台（后端派生 stage；前端只渲染） =====
interface AttemptObs {
  id: string
  attemptNo: number
  state: string
  channelTaskId: string | null
  failureClass: string
  retryable: boolean
  nextRetryAt: string | null
  createdAt: string
}
interface WorkItemObs {
  id: string
  title: string
  brief: string
  channelId: string
  deliverableId: string
  state: string
  stage: string
  waitingOn: string
  waitingReason: string
  attemptCount: number
  maxAttempts: number
  reworkCount: number
  deferredUntil: string | null
  stateReason: string | null
  acceptedResultId: string | null
  lastResultStatus: string
  currentAttempt: AttemptObs | null
  dependsOn: string[]
  contract: Record<string, unknown>
}
interface ChannelObs { channelId: string, name: string, enabled: number, leadAgentId: string | null, status: string, workItems: number, inFlight: number, ready: number, blocked: number }
interface DeliverableObs { id: string, name: string, status: string, required: boolean, dependsOn: string[], acceptanceCriteria: string[], contentReady: boolean, technicalAccepted: boolean, businessApproved: boolean, resultCount: number, currentResultId: string | null }
interface ObservabilityDto {
  project: ProjectDto & { autoDispatch: boolean, routingPolicy: string }
  access: { role: string, canManage: boolean, canDecide: boolean }
  summary: Record<string, number | Record<string, number>>
  channels: ChannelObs[]
  deliverables: DeliverableObs[]
  workItems: WorkItemObs[]
  route: {
    autoDispatch: boolean
    routingPolicy: string
    mode: string
    planVersion: number
    routeGate: string
    ready: Array<{ id: string, title: string, channelId: string }>
    waiting: Array<{ id: string, title: string, stage: string, waitingOn: string, reason: string }>
    blocked: Array<{ id: string, title: string, stage: string, reason: string | null }>
  }
  kernel: { health: Array<Record<string, unknown>>, effects: Record<string, number>, planApprovedVersion: number | null, ledger: { count: number, lastAt: string | null } }
  generatedAt: string
}
interface DetailDto {
  workItem: WorkItemObs & { readiness: { ready: boolean, waitingOn: string, reason: string, upstreamResultIds: string[] }, acceptance: string[], traceId: string }
  deliverable: { id: string, name: string, status: string, required: boolean, acceptanceCriteria: string[], dependsOn: string[] } | null
  attempts: Array<{
    id: string
    attemptNo: number
    state: string
    channelTaskId: string | null
    failureClass: string
    retryable: boolean
    nextRetryAt: string | null
    createdAt: string
    closedAt: string | null
    task: null | { id: string, title: string, state: string, progress: number, assigneeId: string, parentId: string | null, closeReason: string | null, deadlineAt: string | null, createdAt: string, updatedAt: string, artifacts: Array<{ artifactId: string, name: string, bytes: number, sha256: string, preview: string }>, history: Array<{ at: string, role: string, text: string }> }
    workers: Array<{ id: string, title: string, state: string, progress: number, assigneeId: string, closeReason: string | null, createdAt: string, artifacts: Array<{ artifactId: string, name: string, bytes: number, sha256: string }> }>
  }>
  results: Array<{ id: string, version: number, status: string, title: string, summary: string, contentSha256: string, evidenceVerifiedAt: string | null, criteriaCheck: Record<string, unknown>, technicalVerdict: Record<string, unknown>, reworkRequired: boolean, supersedesId: string | null, evidence: Array<Record<string, unknown>>, reviews: Array<Record<string, unknown>>, inputs: Array<Record<string, unknown>>, createdAt: string }>
  events: Array<{ id: string, type: string, at: string, traceId: string, payload: Record<string, unknown> }>
}

const obs = ref<ObservabilityDto | null>(null)
const obsLoading = ref(false)
const selectedWorkItemId = ref('')
const detail = ref<DetailDto | null>(null)
const detailLoading = ref(false)
const lastObsAt = ref('')
let obsTimer: ReturnType<typeof setInterval> | null = null

const stageLabels: Record<string, string> = {
  ready: '就绪待派发',
  dispatching: '派发中',
  dispatched: '已派发',
  running: 'Channel 执行中',
  blocked: '阻塞',
  rework: '待返工',
  deferred: '已延后',
  waiting_dependency: '等待上游工作项',
  waiting_upstream_result: '等待上游成果',
  waiting_technical_review: '等待技术验收',
  waiting_deliverable: '等待上游交付物',
  completed_pending_result: '任务完成·待生成成果',
  result_pending_submit: '成果待提交',
  result_pending_review: '成果待技术验收',
  result_pending_acceptance: '成果待业务签核',
  result_rejected: '成果被驳回',
  accepted: '已验收',
  failed: '失败',
  canceled: '已取消',
  superseded: '已替代',
}
function stageLabel(stage: string): string {
  return stageLabels[stage] ?? stage
}
function stageTone(stage: string): string {
  if (['accepted', 'running'].includes(stage)) return 'green'
  if (['ready', 'dispatched'].includes(stage)) return 'blue'
  if (['blocked', 'failed', 'result_rejected', 'rework'].includes(stage)) return 'red'
  if (stage.startsWith('waiting') || stage.startsWith('result_pending') || stage === 'deferred') return 'amber'
  return 'gray'
}
const itemsByChannel = computed(() => obs.value?.channels.map(c => ({
  channel: c,
  items: (obs.value?.workItems ?? []).filter(w => w.channelId === c.channelId),
})) ?? [])
const dispatchLog = computed(() => events.value
  .filter(e => ['work.dispatched', 'work.dispatch_auto', 'work.retry_scheduled', 'work.retried', 'work.rework', 'route.deferred', 'route.escalated'].includes(e.type))
  .slice(-30)
  .reverse())
const routeDecisions = computed(() => decisions.value.filter(d => d.decisionType === 'route.proposed').slice(-20).reverse())

async function loadObservability(): Promise<void> {
  obsLoading.value = true
  try {
    const r = await http.get<{ data: ObservabilityDto }>(`/workshop/projects/${id}/observability`)
    obs.value = r.data ?? null
    canManageProject.value = r.data?.access?.canManage === true
    lastObsAt.value = new Date().toLocaleTimeString()
  }
  catch (e) {
    // 轮询失败不覆盖主错误条（页面可能正处于长操作）
    if (!obs.value) error.value = e instanceof Error ? e.message : '执行快照加载失败'
  }
  finally {
    obsLoading.value = false
  }
}

async function openWorkItem(workItemId: string): Promise<void> {
  selectedWorkItemId.value = workItemId
  detail.value = null
  detailLoading.value = true
  try {
    const r = await http.get<{ data: DetailDto }>(`/workshop/projects/${id}/observability/work-items/${workItemId}`)
    detail.value = r.data ?? null
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : '执行链加载失败'
  }
  finally {
    detailLoading.value = false
  }
}
function closeDrawer(): void {
  selectedWorkItemId.value = ''
  detail.value = null
}

async function toggleAutoDispatch(): Promise<void> {
  if (!obs.value) return
  await run(async () => {
    await http.patch(`/workshop/projects/${id}`, { autoDispatch: !obs.value!.project.autoDispatch })
    await Promise.all([load(), loadObservability()])
  })
}

onMounted(() => {
  void loadObservability()
  obsTimer = setInterval(() => {
    void loadObservability()
  }, 5000)
  chatTimer = setInterval(() => {
    if (!chatSending.value) void loadChat()
  }, 5000)
})
onUnmounted(() => {
  if (obsTimer) clearInterval(obsTimer)
  obsTimer = null
  if (chatTimer) clearInterval(chatTimer)
  chatTimer = null
})
</script>

<template>
  <div class="project-page">
    <header class="aw-page-head project-head">
      <div class="head-main">
        <button
          type="button"
          class="crumb"
          @click="navigateTo('/projects')"
        >
          <span
            class="i-tabler-arrow-left"
            aria-hidden="true"
          />
          项目列表
        </button>
        <div class="title-line">
          <h1>{{ project?.name ?? '项目' }}</h1>
          <span
            v-if="project"
            class="status-pill"
            :class="statusTone(project.status)"
          >{{ statusText(project.status) }}</span>
        </div>
        <p class="objective">
          {{ project?.objective || '尚未填写项目目标' }}
        </p>
        <div class="meta-row">
          <span class="meta-chip">
            <span
              class="i-tabler-versions"
              aria-hidden="true"
            />
            plan v{{ project?.planVersion ?? 0 }}
          </span>
          <span class="meta-chip">
            <span
              class="i-tabler-clock-hour-4"
              aria-hidden="true"
            />
            待审批 {{ pendingApprovals.length }}
          </span>
          <span
            class="meta-chip mono"
            :title="project?.leadAgentId ?? ''"
          >
            <span
              class="i-tabler-user-shield"
              aria-hidden="true"
            />
            leader {{ project?.leadAgentId ? `${project.leadAgentId.slice(0, 8)}…` : '—' }}
          </span>
        </div>
      </div>
      <div class="head-actions">
        <button
          v-if="canContinueProject"
          class="btn primary"
          data-testid="continue-project"
          @click="focusContinue"
        >
          <span
            class="i-tabler-message-2"
            aria-hidden="true"
          />
          {{ project?.status === 'completed' ? '继续开发' : '补充需求' }}
        </button>
        <button
          class="btn ghost"
          :disabled="loading"
          @click="lifecycle('reconcile')"
        >
          <span
            class="i-tabler-refresh"
            aria-hidden="true"
          />
          对账
        </button>
        <button
          v-if="project?.status === 'draft' || project?.status === 'paused'"
          class="btn primary"
          :disabled="loading"
          @click="lifecycle('activate')"
        >
          激活
        </button>
        <button
          v-if="project?.status === 'active'"
          class="btn ghost"
          :disabled="loading"
          @click="lifecycle('pause')"
        >
          暂停
        </button>
        <button
          v-if="project?.status === 'paused'"
          class="btn primary"
          :disabled="loading"
          @click="lifecycle('resume')"
        >
          恢复
        </button>
        <button
          v-if="project?.status === 'active'"
          class="btn primary"
          :disabled="loading"
          @click="completeProject"
        >
          完成
        </button>
        <button
          v-if="project && project.status !== 'active' && project.status !== 'archived'"
          class="btn ghost"
          :disabled="loading"
          @click="lifecycle('archive')"
        >
          归档
        </button>
      </div>
    </header>

    <p
      v-if="error"
      class="notice danger"
    >
      {{ error }}
    </p>

    <section
      class="kpi-strip"
      aria-label="项目进度概览"
    >
      <div class="kpi">
        <span class="kpi-label">交付物签核</span>
        <span class="kpi-value">{{ deliverableStats.approved }}<small> / {{ deliverableStats.total }}</small></span>
        <span class="kpi-note">必选 {{ deliverableStats.requiredApproved }}/{{ deliverableStats.requiredTotal }}</span>
      </div>
      <div class="kpi">
        <span class="kpi-label">工作项完成</span>
        <span class="kpi-value">{{ workStats.done }}<small> / {{ workStats.total }}</small></span>
        <span class="kpi-note">{{ workStats.pct }}% 已完成</span>
      </div>
      <div class="kpi">
        <span class="kpi-label">待审批</span>
        <span class="kpi-value">{{ pendingApprovals.length }}<small> 项</small></span>
        <span class="kpi-note">plan v{{ project?.planVersion ?? 0 }}</span>
      </div>
      <div class="kpi">
        <span class="kpi-label">Leader 对话</span>
        <span class="kpi-value">{{ chatMessages.length }}<small> 条</small></span>
        <span class="kpi-note">项目办公室 · 持续开发</span>
      </div>
    </section>

    <nav
      class="tabs"
      data-testid="project-tabs"
      aria-label="项目视图"
    >
      <button
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        :class="{ active: activeTab === t.key }"
        :data-testid="`tab-${t.key}`"
        :aria-current="activeTab === t.key ? 'page' : undefined"
        @click="activeTab = t.key"
      >
        {{ t.label }}
        <span
          v-if="tabCount(t.key)"
          class="tab-count"
          :class="{ alert: t.key === 'approvals' }"
        >{{ tabCount(t.key) }}</span>
      </button>
    </nav>

    <!-- 持续开发：同一个 Project Leader 的项目内对话；completed 项目发送即重开 -->
    <section
      v-show="activeTab === 'overview'"
      class="card chat-card"
      data-testid="project-leader-chat"
    >
      <header class="chat-head">
        <div class="leader-id">
          <span
            class="leader-avatar"
            aria-hidden="true"
          >PL</span>
          <div class="leader-copy">
            <h2>Project Leader 对话</h2>
            <p>
              项目办公室
              <template v-if="project?.officeChannelId">
                · <code>{{ project.officeChannelId.slice(0, 8) }}…</code>
              </template>
            </p>
          </div>
        </div>
        <div class="chat-head-actions">
          <span
            v-if="project"
            class="status-pill"
            :class="statusTone(project.status)"
          >{{ statusText(project.status) }}</span>
          <span class="muted">{{ chatMessages.length }} 条对话</span>
          <button
            type="button"
            class="icon-btn"
            :disabled="chatLoading"
            title="刷新对话"
            aria-label="刷新对话"
            @click="loadChat"
          >
            <span
              class="i-tabler-refresh"
              :class="{ spin: chatLoading }"
              aria-hidden="true"
            />
          </button>
        </div>
      </header>

      <p
        v-if="project?.status === 'completed'"
        class="chat-hint"
      >
        <span
          class="i-tabler-info-circle"
          aria-hidden="true"
        />
        <span>项目已完成。<b>发送补充需求会自动重新打开项目</b>；Leader 会先读现状，再提出增量计划（plan vN+1），owner 批准后继续派发、验收，不需要新建项目。</span>
      </p>
      <p
        v-else-if="project?.status === 'paused'"
        class="chat-hint"
      >
        <span
          class="i-tabler-player-pause"
          aria-hidden="true"
        />
        <span>项目已暂停；发送补充需求会自动恢复为进行中，再交给同一个 Project Leader 评估。</span>
      </p>
      <p
        v-else
        class="chat-hint"
      >
        <span
          class="i-tabler-messages"
          aria-hidden="true"
        />
        <span>消息直接进入项目办公室，由同一个 Project Leader 接收；适合补充 bug 复现、变更需求和验收反馈。</span>
      </p>

      <div
        ref="chatThread"
        class="chat-thread"
        data-testid="project-leader-thread"
      >
        <div
          v-if="!chatMessages.length && !chatLoading"
          class="chat-empty"
        >
          <span
            class="i-tabler-messages"
            aria-hidden="true"
          />
          <strong>还没有对话</strong>
          <span>可以直接描述 bug、复现步骤或下一轮需求。</span>
        </div>
        <div
          v-else-if="chatLoading && !chatMessages.length"
          class="chat-empty"
        >
          <span class="muted">正在同步对话…</span>
        </div>
        <div
          v-for="m in chatMessages"
          :key="m.id"
          class="chat-row"
          :class="m.senderType"
          :data-testid="`project-chat-${m.senderType}`"
        >
          <span
            class="chat-avatar"
            aria-hidden="true"
          >{{ m.senderType === 'user' ? '你' : 'PL' }}</span>
          <div class="chat-bubble-wrap">
            <div class="chat-meta">
              <strong>{{ m.senderType === 'user' ? '你' : m.senderName }}</strong>
              <span>{{ formatChatTime(m.createdAt) }}</span>
            </div>
            <!-- eslint-disable vue/no-v-html -- mdLite 先 escapeHtml，仅注入受控标记 -->
            <div
              class="chat-body"
              v-html="renderChat(m.text)"
            />
            <!-- eslint-enable vue/no-v-html -->
          </div>
        </div>
      </div>

      <p
        v-if="chatError"
        class="notice danger"
      >
        {{ chatError }}
      </p>
      <p
        v-if="chatNotice"
        class="notice ok"
      >
        <span
          class="i-tabler-circle-check"
          aria-hidden="true"
        />
        {{ chatNotice }}
      </p>

      <div class="chat-compose">
        <textarea
          ref="chatInput"
          v-model="chatText"
          rows="3"
          maxlength="8000"
          data-testid="project-continue-input"
          :disabled="!canContinueProject"
          :placeholder="canContinueProject
            ? '例如：游戏在移动端无法操作；第 2 关闪电伤害判定偏大；请修复并补回归验证。'
            : '只有项目 owner 可以在这里继续开发。'"
          @keydown.ctrl.enter.prevent="sendContinuation"
          @keydown.meta.enter.prevent="sendContinuation"
        />
        <div class="chat-compose-actions">
          <span class="composer-hint">
            <span
              class="i-tabler-keyboard"
              aria-hidden="true"
            />
            Ctrl/⌘ + Enter 发送
            <template v-if="!canContinueProject">
              · 只有项目 owner 可继续开发
            </template>
          </span>
          <div class="composer-right">
            <span class="muted mono">{{ chatText.length }} / 8000</span>
            <button
              class="btn primary"
              data-testid="project-continue-send"
              :disabled="chatSending || !chatText.trim() || !canContinueProject"
              @click="sendContinuation"
            >
              <span
                class="i-tabler-send-2"
                aria-hidden="true"
              />
              {{ chatSending ? '发送中…' : '发送并继续开发' }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <section
      v-show="activeTab === 'overview'"
      class="card"
    >
      <div class="card-head">
        <div>
          <h2>项目组频道</h2>
          <p class="card-sub">
            生产与评审 Channel；项目办公室只承载 Leader 对话。
          </p>
        </div>
        <a
          v-if="project?.officeChannelId"
          class="link"
          :href="`/workshop`"
          data-testid="open-office"
        >
          打开办公室频道
          <span
            class="i-tabler-arrow-up-right"
            aria-hidden="true"
          />
        </a>
      </div>
      <p
        v-if="!channels.length"
        class="muted"
      >
        尚未绑定成员 Channel。
      </p>
      <ul
        v-else
        class="channel-list"
      >
        <li
          v-for="c in channels"
          :key="c.channelId"
          :class="{ detached: c.status !== 'active' }"
        >
          <span
            class="channel-dot"
            :class="{ off: c.status !== 'active' }"
            aria-hidden="true"
          />
          <code>{{ c.channelId }}</code>
          <span
            class="badge"
            :class="c.status === 'active' ? 'approved' : 'gray'"
          >{{ bindingText(c.status) }}</span>
          <span
            class="badge"
            :class="{ protected: c.bindingType === 'user_bound' }"
            data-testid="protected-badge"
          >
            {{ c.bindingType === 'user_bound' ? '用户绑定 · 受保护' : c.bindingType }}
          </span>
          <span class="muted channel-charter">{{ c.charter || '无 charter' }}</span>
        </li>
      </ul>
      <div class="form-grid">
        <input
          v-model="bindForm.channelId"
          data-testid="bind-channel-id"
          placeholder="Channel ID（owner 自己的、已有 lead）"
        >
        <input
          v-model="bindForm.charter"
          placeholder="该频道在项目中的使命（可选）"
        >
        <button
          class="btn primary"
          :disabled="loading"
          @click="bindChannel"
        >
          绑定频道
        </button>
      </div>
    </section>

    <section
      v-show="activeTab === 'deliverables'"
      class="card"
    >
      <div class="card-head">
        <div>
          <h2>交付物</h2>
          <p class="card-sub">
            至少一个必选交付物才能激活；验收标准按行拆分为结构化 criteria。
          </p>
        </div>
        <span class="badge gray">{{ deliverables.length }} 项</span>
      </div>
      <p
        v-if="!deliverables.length"
        class="muted"
      >
        还没有交付物。先新增一个必选交付物，才能激活项目。
      </p>
      <ul
        v-else
        class="deliverable-list"
      >
        <li
          v-for="d in deliverables"
          :key="d.id"
        >
          <div class="deliverable-main">
            <strong>{{ d.name }}</strong>
            <span
              class="badge"
              :class="d.status"
              :data-state="d.status"
              :title="d.status"
            >{{ stateText(d.status) }}</span>
            <span class="muted">{{ d.required ? '必选' : '可选' }}</span>
          </div>
          <p
            v-if="criteriaOf(d).length"
            class="deliverable-criteria"
          >
            <span class="criteria-label">验收</span>
            {{ criteriaOf(d).join(' · ') }}
          </p>
        </li>
      </ul>
      <div class="form-grid">
        <input
          v-model="deliverableForm.name"
          data-testid="deliverable-name"
          placeholder="交付物名称"
        >
        <a-select
          v-model:value="deliverableForm.ownerChannelId"
          class="field-select"
          placeholder="所属频道"
          :options="channelOptions"
          data-testid="select-deliverable-channel"
        />
        <textarea
          v-model="deliverableForm.acceptance"
          rows="2"
          placeholder="验收标准（每行一条）"
        />
        <button
          class="btn primary"
          :disabled="loading"
          @click="createDeliverable"
        >
          新增交付物
        </button>
      </div>
    </section>

    <section
      v-show="activeTab === 'plan'"
      class="card exec-workbench"
      data-testid="exec-workbench"
    >
      <div class="card-head">
        <div>
          <h2>执行工作台</h2>
          <p class="card-sub">
            按 Channel 泳道查看派发、执行与验收阶段；点击工作项查看完整执行链。
          </p>
        </div>
        <div class="card-head-meta">
          <span
            class="live-dot"
            :class="{ on: obsLoading }"
            aria-hidden="true"
          />
          <span class="muted">快照 {{ lastObsAt || '—' }} · 5s 轮询</span>
          <label
            v-if="obs?.access.canManage"
            class="inline-check"
          >
            <input
              type="checkbox"
              data-testid="toggle-auto-dispatch"
              :checked="obs?.project.autoDispatch"
              @change="toggleAutoDispatch"
            >
            自动派发
          </label>
          <span
            v-if="obs"
            class="badge"
          >{{ obs.access.role }}</span>
        </div>
      </div>

      <div
        v-if="obs"
        class="stat-strip"
        data-testid="exec-summary"
      >
        <span class="stat"><b>{{ obs.summary.ready }}</b> 就绪</span>
        <span class="stat"><b>{{ obs.summary.inFlight }}</b> 执行中</span>
        <span class="stat"><b>{{ obs.summary.waiting }}</b> 等待</span>
        <span class="stat"><b>{{ obs.summary.blocked }}</b> 阻塞/返工</span>
        <span class="stat"><b>{{ Math.round(Number(obs.summary.progress ?? 0) * 100) }}%</b> 工作项完成</span>
        <span class="stat"><b>{{ Math.round(Number(obs.summary.acceptanceProgress ?? 0) * 100) }}%</b> 交付物签核</span>
      </div>

      <div
        v-if="obs"
        class="lanes"
      >
        <div
          v-for="lane in itemsByChannel"
          :key="lane.channel.channelId"
          class="lane"
          :data-testid="`channel-lane-${lane.channel.channelId}`"
        >
          <div class="lane-head">
            <strong>{{ lane.channel.name }}</strong>
            <span
              class="badge"
              :class="lane.channel.enabled ? 'active' : 'archived'"
            >{{ lane.channel.enabled ? '启用' : '停用' }}</span>
            <span class="muted">{{ lane.channel.inFlight }} 执行 · {{ lane.channel.ready }} 就绪</span>
          </div>
          <p
            v-if="!lane.items.length"
            class="muted lane-empty"
          >
            无工作项
          </p>
          <button
            v-for="w in lane.items"
            :key="w.id"
            class="exec-card"
            :data-testid="`exec-work-item-${w.id}`"
            @click="openWorkItem(w.id)"
          >
            <span class="exec-card-top">
              <strong>{{ w.title }}</strong>
              <span
                class="badge"
                :class="stageTone(w.stage)"
              >{{ stageLabel(w.stage) }}</span>
            </span>
            <span class="muted">attempt {{ w.attemptCount }}/{{ w.maxAttempts }} · 成果 {{ w.lastResultStatus || '—' }}<template v-if="w.reworkCount"> · rework {{ w.reworkCount }}</template></span>
            <span
              v-if="w.waitingReason"
              class="muted"
            >{{ w.waitingOn }}: {{ w.waitingReason }}</span>
            <span
              v-else-if="w.stateReason"
              class="muted"
            >{{ w.stateReason }}</span>
          </button>
        </div>
      </div>
      <p
        v-else
        class="muted"
      >
        执行快照加载中…
      </p>

      <div
        v-if="obs"
        class="route-strip"
        data-testid="route-strip"
      >
        <span>routeGate <b>{{ obs.route.routeGate }}</b></span>
        <span>mode <b>{{ obs.route.mode }}</b></span>
        <span>plan v<b>{{ obs.route.planVersion }}</b></span>
        <span>effects <b>{{ obs.kernel.effects.pending ?? 0 }}</b> pending</span>
        <span>ledger <b>{{ obs.kernel.ledger.count }}</b></span>
      </div>
    </section>

    <section
      v-show="activeTab === 'plan'"
      class="card"
      data-testid="route-log"
    >
      <div class="card-head">
        <div>
          <h2>路由与派发日志</h2>
          <p class="card-sub">
            Leader 只提案；平台内核负责 CAS 派发与重试。
          </p>
        </div>
      </div>
      <div class="grid2">
        <div>
          <h3>派发 / 重试 / 返工 / 升级</h3>
          <p
            v-if="!dispatchLog.length"
            class="muted"
          >
            暂无派发记录。
          </p>
          <ul class="timeline-list">
            <li
              v-for="e in dispatchLog"
              :key="e.id"
            >
              <span class="timeline-type">{{ e.type }}</span>
              <code>{{ e.traceId }}</code>
              <span class="muted">{{ e.createdAt }}</span>
            </li>
          </ul>
        </div>
        <div>
          <h3>Leader 路由提案</h3>
          <p
            v-if="!routeDecisions.length"
            class="muted"
          >
            暂无 route 提案。
          </p>
          <ul class="timeline-list">
            <li
              v-for="d in routeDecisions"
              :key="d.id"
            >
              <span>#{{ d.seq }} {{ d.decisionType }}</span>
              <span class="badge">{{ d.state }}</span>
              <code>{{ d.traceId }}</code>
            </li>
          </ul>
        </div>
      </div>
      <div
        v-if="obs?.route.waiting.length"
        class="waiting-box"
      >
        <h3>等待原因（后端派生）</h3>
        <ul class="timeline-list">
          <li
            v-for="w in obs.route.waiting"
            :key="w.id"
          >
            <span>{{ w.title }}</span>
            <span class="badge amber">{{ stageLabel(w.stage) }}</span>
            <span class="muted">{{ w.waitingOn }} · {{ w.reason }}</span>
          </li>
        </ul>
      </div>
    </section>

    <section
      v-show="activeTab === 'plan'"
      class="card"
    >
      <div class="card-head">
        <div>
          <h2>计划快照</h2>
          <p class="card-sub">
            当前 v{{ project?.planVersion ?? 0 }}；已批准版本才可物化派发。
          </p>
        </div>
      </div>
      <pre
        v-if="project"
        class="plan-json"
      >{{ planJsonPretty }}</pre>
      <p
        v-else
        class="muted"
      >
        加载中。
      </p>
      <h3>计划决策快照</h3>
      <ul class="timeline-list">
        <li
          v-for="pd in planDecisions"
          :key="pd.id"
        >
          <span>{{ pd.decisionType }}</span>
          <span class="badge">{{ pd.state }}</span>
          <code class="muted">{{ pd.traceId }}</code>
        </li>
      </ul>
    </section>

    <section
      v-show="activeTab === 'plan'"
      class="card"
    >
      <div class="card-head">
        <div>
          <h2>工作项 / 派发</h2>
          <p class="card-sub">
            工作项必须挂在交付物下；派发前会检查计划门与上游 readiness。
          </p>
        </div>
        <span class="badge gray">{{ workItems.length }} 个工作项</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>标题</th>
              <th>频道</th>
              <th>状态</th>
              <th>预算</th>
              <th class="col-actions">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="w in workItems"
              :key="w.id"
            >
              <td>
                {{ w.title }}<div
                  v-if="w.stateReason"
                  class="muted"
                >
                  {{ w.stateReason }}
                </div>
              </td>
              <td><code>{{ w.channelId }}</code></td>
              <td>
                <span
                  class="badge"
                  :class="w.state.toLowerCase()"
                  :data-state="w.state"
                  :title="w.state"
                >{{ stateText(w.state) }}</span>
              </td>
              <td>{{ w.execBudgetMinutes }}m</td>
              <td class="col-actions">
                <button
                  class="btn small"
                  :disabled="loading || Boolean(w.currentAttemptId)"
                  @click="dispatch(w.id)"
                >
                  派发
                </button>
                <button
                  v-if="['FAILED', 'CANCELED', 'COMPLETED'].includes(w.state)"
                  class="btn small ghost"
                  data-testid="btn-retry"
                  :disabled="loading"
                  @click="retryWorkItem(w.id)"
                >
                  重试
                </button>
                <button
                  v-if="!['COMPLETED', 'CANCELED', 'SUPERSEDED'].includes(w.state)"
                  class="btn small danger"
                  :disabled="loading"
                  @click="cancelWorkItem(w.id)"
                >
                  取消
                </button>
              </td>
            </tr>
            <tr v-if="!workItems.length">
              <td
                colspan="5"
                class="muted"
              >
                暂无工作项。批准计划后会自动物化，或在下方手动新增。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="form-grid">
        <a-select
          v-model:value="workForm.deliverableId"
          class="field-select"
          placeholder="选择交付物"
          :options="deliverableOptions"
          data-testid="select-work-deliverable"
        />
        <a-select
          v-model:value="workForm.channelId"
          class="field-select"
          placeholder="选择频道"
          :options="channelOptions"
          data-testid="select-work-channel"
        />
        <input
          v-model="workForm.title"
          data-testid="input-work-title"
          placeholder="工作项标题"
        >
        <input
          v-model="workForm.brief"
          data-testid="input-work-brief"
          placeholder="给 Channel lead 的 brief"
        >
        <input
          v-model.number="workForm.execBudgetMinutes"
          type="number"
          min="1"
          max="1440"
          aria-label="执行预算（分钟）"
        >
        <button
          class="btn primary"
          :disabled="loading"
          @click="createWorkItem"
        >
          新增工作项
        </button>
      </div>
    </section>

    <section
      v-show="activeTab === 'deliverables'"
      class="card"
    >
      <div class="card-head">
        <div>
          <h2>成果与验收</h2>
          <p class="card-sub">
            Channel root task COMPLETED 后点“对账”生成 draft；技术验收与业务签核分离。
          </p>
        </div>
        <span class="badge gray">{{ currentResults.length }} 份成果</span>
      </div>
      <p
        v-if="!currentResults.length"
        class="muted"
      >
        Channel root task COMPLETED 后，点“对账”会自动生成 draft。
      </p>
      <template
        v-for="group in resultsByDeliverable"
        :key="group.deliverable.id"
      >
        <div
          v-if="group.results.length"
          class="group-head"
        >
          <strong>{{ group.deliverable.name }}</strong>
          <span
            class="badge"
            :class="group.deliverable.status"
            :data-state="group.deliverable.status"
            :title="group.deliverable.status"
          >{{ stateText(group.deliverable.status) }}</span>
          <button
            v-if="group.deliverable.status === 'planned'"
            class="btn small ghost"
            :disabled="loading"
            @click="waiveDeliverable(group.deliverable.id)"
          >
            豁免
          </button>
        </div>
        <article
          v-for="r in group.results"
          :key="r.id"
          class="result"
        >
          <div class="result-head">
            <strong>{{ r.title }}</strong>
            <span
              class="badge"
              :class="r.status"
              :data-state="r.status"
              :title="r.status"
            >{{ stateText(r.status) }}</span>
            <span class="muted mono">v{{ r.version }}</span>
          </div>
          <p class="summary">
            {{ r.summary }}
          </p>
          <details class="evidence">
            <summary>evidence</summary>
            <code>{{ r.evidenceJson }}</code>
          </details>
          <div class="result-actions">
            <button
              v-if="r.status === 'draft' || r.status === 'rejected'"
              class="btn small primary"
              :disabled="loading"
              @click="submitResult(r)"
            >
              提交
            </button>
            <button
              v-if="r.status === 'submitted'"
              class="btn small ghost"
              :disabled="loading"
              @click="review(r, 'reviewed')"
            >
              复核通过
            </button>
            <button
              v-if="r.status === 'submitted'"
              class="btn small danger"
              :disabled="loading"
              @click="review(r, 'rejected')"
            >
              驳回
            </button>
            <button
              v-if="r.status === 'reviewed'"
              class="btn small primary"
              :disabled="loading"
              @click="requestAcceptance(r)"
            >
              申请验收
            </button>
          </div>
        </article>
      </template>
    </section>

    <section
      v-show="activeTab === 'overview'"
      class="card"
    >
      <div class="card-head">
        <div>
          <h2>周报</h2>
          <p class="card-sub">
            与库同源的进度数字，可导出 JSON 归档。
          </p>
        </div>
        <div class="row actions">
          <button
            class="btn small ghost"
            data-testid="btn-report-refresh"
            :disabled="loading"
            @click="loadReport"
          >
            刷新
          </button>
          <button
            class="btn small"
            data-testid="btn-report-export"
            :disabled="loading || !report"
            @click="exportReport"
          >
            导出
          </button>
        </div>
      </div>
      <p
        v-if="!report"
        class="muted"
      >
        周报未加载。
      </p>
      <template v-else>
        <div class="report-grid">
          <div class="report-stat">
            <span class="kpi-label">进度</span>
            <b>{{ report.progress?.completedWorkItems ?? 0 }}/{{ report.progress?.scoreableWorkItems ?? 0 }}</b>
          </div>
          <div class="report-stat">
            <span class="kpi-label">必选验收</span>
            <b>{{ report.deliverables?.requiredApproved ?? 0 }}/{{ report.deliverables?.requiredTotal ?? 0 }}</b>
          </div>
          <div class="report-stat">
            <span class="kpi-label">成果</span>
            <b>{{ report.results?.total ?? 0 }}</b>
          </div>
          <div class="report-stat">
            <span class="kpi-label">阻塞</span>
            <b>{{ report.workItems?.blocked ?? 0 }}</b>
          </div>
          <div class="report-stat">
            <span class="kpi-label">近 7 天事件</span>
            <b>{{ report.recentEvents?.count ?? 0 }}</b>
          </div>
        </div>
        <p class="muted mono">
          generatedAt: {{ report.generatedAt }}
        </p>
      </template>
    </section>

    <section
      v-show="activeTab === 'approvals'"
      class="card"
    >
      <div class="card-head">
        <div>
          <h2>待审批</h2>
          <p class="card-sub">
            计划、成果签核与项目完成都需要 owner / approver 决策。
          </p>
        </div>
        <span
          v-if="pendingApprovals.length"
          class="badge amber"
        >{{ pendingApprovals.length }} 项待处理</span>
      </div>
      <p
        v-if="!pendingApprovals.length"
        class="muted"
      >
        无待审批。
      </p>
      <ul class="approval-list">
        <li
          v-for="a in pendingApprovals"
          :key="a.id"
        >
          <div class="approval-main">
            <span
              class="approval-kind"
              :title="a.kind"
            >{{ approvalKindText(a.kind) }}</span>
            <code>{{ a.subjectId }}</code>
            <span
              v-if="a.payloadJson && a.payloadJson !== '{}'"
              class="muted approval-payload"
            >
              {{ a.payloadJson.slice(0, 180) }}{{ a.payloadJson.length > 180 ? '…' : '' }}
            </span>
            <span
              v-else-if="a.reason"
              class="muted"
            >
              {{ a.reason }}
            </span>
          </div>
          <div class="approval-actions">
            <button
              class="btn small primary"
              :disabled="loading"
              @click="decide(a, true)"
            >
              批准
            </button>
            <button
              class="btn small danger"
              :disabled="loading"
              @click="decide(a, false)"
            >
              拒绝
            </button>
          </div>
        </li>
      </ul>
    </section>

    <section
      v-show="activeTab === 'approvals'"
      class="card"
    >
      <div class="card-head">
        <div>
          <h2>审批历史</h2>
          <p class="card-sub">
            最近 50 条决策留痕。
          </p>
        </div>
      </div>
      <p
        v-if="!approvalHistory.length"
        class="muted"
      >
        暂无审批记录。
      </p>
      <ul class="history-list">
        <li
          v-for="h in approvalHistory.slice(0, 50)"
          :key="h.id"
        >
          <div class="history-main">
            <span
              class="approval-kind"
              :title="h.kind"
            >{{ approvalKindText(h.kind) }}</span>
            <code class="history-subject">{{ h.subjectId }}</code>
            <span
              class="badge"
              :class="h.status"
              :data-state="h.status"
              :title="h.status"
            >{{ approvalText(h.status) }}</span>
            <code class="muted history-time">{{ h.expiresAt ?? '' }}</code>
          </div>
          <details
            v-if="h.payloadJson && h.payloadJson !== '{}'"
            class="evidence"
          >
            <summary>payload</summary>
            <code>{{ h.payloadJson }}</code>
          </details>
        </li>
      </ul>
    </section>

    <section
      v-show="activeTab === 'events'"
      class="grid2"
    >
      <div class="card">
        <div class="card-head">
          <div>
            <h2>决策（最近 50）</h2>
            <p class="card-sub">
              Leader 提案与平台决策审计。
            </p>
          </div>
        </div>
        <ul class="timeline-list">
          <li
            v-for="d in decisions.slice(-50)"
            :key="d.id"
          >
            <span>#{{ d.seq }} {{ d.decisionType }}</span>
            <span class="badge">{{ d.state }}</span>
            <button
              v-if="d.decisionType === 'dispatch.proposed' && d.state === 'proposed'"
              class="btn small primary"
              :disabled="loading"
              @click="applyProposal(d)"
            >
              应用提案
            </button>
            <code>{{ d.traceId }}</code>
          </li>
        </ul>
      </div>
      <div class="card">
        <div class="card-head">
          <div>
            <h2>事件（最近 50）</h2>
            <p class="card-sub">
              事件枚举与审计键。
            </p>
          </div>
        </div>
        <ul class="timeline-list">
          <li
            v-for="e in events.slice(-50)"
            :key="e.id"
          >
            <span>#{{ e.seq }} {{ e.type }}</span>
            <span class="muted">{{ e.eventKey }}</span>
          </li>
        </ul>
      </div>
    </section>

    <div
      v-if="selectedWorkItemId"
      class="drawer-mask"
      @click.self="closeDrawer"
    >
      <aside
        class="drawer"
        data-testid="exec-drawer"
        role="dialog"
        aria-label="工作项执行链"
      >
        <header class="drawer-head">
          <div>
            <p class="aw-kicker">
              执行链
            </p>
            <h2>{{ detail?.workItem.title ?? '工作项' }}</h2>
          </div>
          <div class="row actions">
            <span class="muted mono">{{ selectedWorkItemId.slice(0, 8) }}…</span>
            <button
              class="btn small ghost"
              @click="closeDrawer"
            >
              关闭
            </button>
          </div>
        </header>
        <p
          v-if="detailLoading"
          class="muted"
        >
          加载执行链…
        </p>
        <template v-else-if="detail">
          <div class="row">
            <span
              class="badge"
              :class="stageTone(detail.workItem.stage)"
            >{{ stageLabel(detail.workItem.stage) }}</span>
            <span class="muted">{{ detail.workItem.state }} · attempt {{ detail.workItem.attemptCount }}/{{ detail.workItem.maxAttempts }}</span>
          </div>
          <p
            v-if="detail.workItem.readiness.reason"
            class="muted"
          >
            {{ detail.workItem.readiness.waitingOn }} · {{ detail.workItem.readiness.reason }}
          </p>
          <p
            v-if="detail.workItem.acceptance.length"
            class="muted"
          >
            验收标准：{{ detail.workItem.acceptance.join('；') }}
          </p>

          <h4>尝试链</h4>
          <p
            v-if="!detail.attempts.length"
            class="muted"
          >
            尚未派发。
          </p>
          <div
            v-for="a in detail.attempts"
            :key="a.id"
            class="attempt"
            :data-testid="`exec-attempt-${a.attemptNo}`"
          >
            <div class="row">
              <strong>Attempt #{{ a.attemptNo }}</strong>
              <span class="badge">{{ a.state }}</span>
              <code>{{ a.channelTaskId ? a.channelTaskId.slice(0, 8) : 'no-task' }}</code>
              <span
                v-if="a.failureClass"
                class="badge red"
              >{{ a.failureClass }}</span>
              <span class="muted">{{ a.createdAt }}</span>
            </div>
            <template v-if="a.task">
              <div class="muted">
                root {{ a.task.state }} · {{ a.task.progress }}% · assignee {{ a.task.assigneeId.slice(0, 8) }}{{ a.task.closeReason ? ` · ${a.task.closeReason}` : '' }}
              </div>
              <ul
                v-if="a.task.artifacts.length"
                class="artifact-list"
              >
                <li
                  v-for="art in a.task.artifacts"
                  :key="art.artifactId"
                >
                  <code>{{ art.name || art.artifactId }}</code>
                  <span class="muted">{{ art.bytes }}B · sha {{ art.sha256.slice(0, 12) }}…</span>
                </li>
              </ul>
              <p
                v-else
                class="muted"
              >
                无 artifact
              </p>
            </template>
            <div
              v-if="a.workers.length"
              class="workers"
            >
              <div class="muted">
                worker 子任务（{{ a.workers.length }}）
              </div>
              <div
                v-for="w in a.workers"
                :key="w.id"
                class="worker"
              >
                <span>{{ w.title }}</span>
                <span
                  class="badge"
                  :title="w.state"
                >{{ stateText(w.state) }}</span>
                <span class="muted">{{ w.progress }}% · {{ w.artifacts.length }} artifacts</span>
              </div>
            </div>
          </div>

          <h4>成果与验收链</h4>
          <p
            v-if="!detail.results.length"
            class="muted"
          >
            尚无成果（root 完成后自动生成 draft）。
          </p>
          <div
            v-for="r in detail.results"
            :key="r.id"
            class="result"
            :data-testid="`exec-result-${r.version}`"
          >
            <div class="row">
              <strong>v{{ r.version }} {{ r.title }}</strong>
              <span
                class="badge"
                :class="r.status"
                :data-state="r.status"
                :title="r.status"
              >{{ stateText(r.status) }}</span>
              <span
                v-if="r.reworkRequired"
                class="badge red"
              >需返工</span>
              <span
                v-if="r.supersedesId"
                class="muted"
              >supersedes {{ r.supersedesId.slice(0, 8) }}…</span>
            </div>
            <p class="summary">
              {{ r.summary.slice(0, 800) }}
            </p>
            <div class="muted mono">
              evidence {{ r.evidence.length }} · sha {{ r.contentSha256.slice(0, 12) }}… · verified {{ r.evidenceVerifiedAt ?? '—' }}
            </div>
            <div
              v-for="rv in r.reviews"
              :key="String(rv.id)"
              class="muted"
            >
              L1 {{ rv.verdict }} · {{ rv.reviewerKind }} · {{ rv.reviewerChannelId }} · {{ rv.note || '' }}
            </div>
            <div
              v-if="r.inputs.length"
              class="muted"
            >
              消费上游：{{ r.inputs.map(i => String(i.inputResultId)).join(', ') }}
            </div>
          </div>

          <h4>事件</h4>
          <ul class="timeline-list">
            <li
              v-for="e in detail.events.slice(-20)"
              :key="e.id"
            >
              <span>{{ e.type }}</span>
              <span class="muted">{{ e.at }}</span>
            </li>
          </ul>
        </template>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* ============================================================
 * 项目详情 —— 全部颜色取自全局令牌（--paper / --ink / --tone-*），
 * 亮暗两档自动成立。页面只负责“编排”，不再自带一套暗色主题。
 * ============================================================ */
.project-page {
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: 4px 8px 48px;
  color: var(--ink);
}

/* ── 页头 ─────────────────────────────────────────────── */
.project-head {
  align-items: flex-start;
}

.head-main {
  flex: 1 1 520px;
  min-width: 0;
}

.crumb {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 0 0 7px;
  padding: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-faint);
  cursor: pointer;
  background: none;
  border: 0;
  transition: color var(--transition-fast);
}

.crumb:hover {
  color: var(--accent);
}

.title-line {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.title-line h1 {
  margin: 0;
  font-size: clamp(24px, 2.4vw, 30px);
  font-weight: 600;
  line-height: 1.18;
  letter-spacing: -0.022em;
  color: var(--ink);
  text-wrap: balance;
}

.objective {
  max-width: 76ch;
  margin: 8px 0 0;
  font-size: 13.5px;
  line-height: 1.68;
  color: var(--ink-soft);
  text-wrap: pretty;
}

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}

.meta-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.02em;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}

.head-actions {
  display: flex;
  flex: 0 1 480px;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
  max-width: 520px;
  padding-top: 2px;
}

/* ── 状态胶囊（语义 tone，不自造颜色）──────────────────── */
.status-pill {
  --pill-bg: var(--tone-neutral-bg);
  --pill-fg: var(--tone-neutral-dot);

  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 4px 10px;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--pill-fg);
  white-space: nowrap;
  background: var(--pill-bg);
  border: 1px solid color-mix(in srgb, var(--pill-fg) 22%, transparent);
  border-radius: var(--radius-pill);
}

.status-pill::before {
  width: 6px;
  height: 6px;
  content: '';
  background: currentcolor;
  border-radius: 50%;
}

.status-pill.green {
  --pill-bg: var(--tone-success-bg);
  --pill-fg: var(--tone-success-dot);
}

.status-pill.blue {
  --pill-bg: var(--tone-info-bg);
  --pill-fg: var(--tone-info-dot);
}

.status-pill.amber {
  --pill-bg: var(--tone-warning-bg);
  --pill-fg: var(--tone-warning-dot);
}

/* ── KPI 条 ───────────────────────────────────────────── */
.kpi-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  margin: 0 0 16px;
  overflow: hidden;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}

.kpi {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 13px 16px;
  background: var(--paper-raised);
}

.kpi-label {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-faint);
}

.kpi-value {
  font-family: var(--font-mono);
  font-size: 21px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.kpi-value small {
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-faint);
}

.kpi-note {
  overflow: hidden;
  font-size: 11px;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 视图切换（吸顶，窄屏横向滚动）────────────────────── */
.tabs {
  position: sticky;
  top: var(--app-header-h, 56px);
  z-index: 20;
  display: flex;
  gap: 2px;
  align-items: center;
  margin: 0 -8px 16px;
  padding: 7px 8px;
  overflow-x: auto;
  background: color-mix(in srgb, var(--paper) 92%, transparent);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line);
  scrollbar-width: none;
}

.tabs::-webkit-scrollbar {
  display: none;
}

.tab {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  padding: 7px 12px;
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
  white-space: nowrap;
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.tab:hover {
  color: var(--ink);
  background: var(--hover-tint);
}

.tab.active {
  color: var(--ink);
  background: var(--paper-raised);
  border-color: var(--line);
  box-shadow: var(--shadow-lift-1);
}

.tab-count {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ink-faint);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
}

.tab.active .tab-count {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: transparent;
}

.tab-count.alert {
  color: var(--tone-warning-dot);
  background: var(--tone-warning-bg);
  border-color: color-mix(in srgb, var(--tone-warning-dot) 20%, transparent);
}

/* ── 卡片骨架 ─────────────────────────────────────────── */
.card {
  padding: 18px;
  margin-bottom: 16px;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-lift-1);
}

.card-head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 14px;
}

.card-head h2 {
  margin: 0;
  font-size: 15.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.card-sub {
  max-width: 70ch;
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-faint);
}

.card-head-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 10px;
  align-items: center;
  font-size: 11.5px;
}

h3 {
  margin: 18px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-soft);
}

h4 {
  margin: 18px 0 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink-soft);
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 16px;
}

.grid2 > .card {
  margin-bottom: 0;
}

/* ── 按钮（令牌化，替代页面私有的蓝/绿/红）──────────────── */
.btn {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  justify-content: center;
  padding: 7px 14px;
  font-family: var(--font-body);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--ink);
  white-space: nowrap;
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast),
    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}

.btn:hover:not(:disabled) {
  background: var(--hover-tint);
  border-color: var(--ink-fainter);
}

.btn:active:not(:disabled) {
  transform: scale(0.97);
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.btn.primary {
  font-weight: 600;
  color: var(--on-accent);
  background: var(--accent);
  border-color: var(--accent);
}

.btn.primary:hover:not(:disabled) {
  background: var(--accent-strong);
  border-color: var(--accent-strong);
}

.btn.ghost {
  color: var(--ink-soft);
  background: transparent;
  border-color: var(--line-strong);
}

.btn.ghost:hover:not(:disabled) {
  color: var(--ink);
  background: var(--hover-tint);
}

.btn.danger {
  color: var(--tone-danger-dot);
  background: transparent;
  border-color: color-mix(in srgb, var(--tone-danger-dot) 45%, transparent);
}

.btn.danger:hover:not(:disabled) {
  background: var(--tone-danger-bg);
}

.btn.small {
  padding: 4px 10px;
  font-size: 11.5px;
  border-radius: var(--radius-chip);
}

.icon-btn {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  color: var(--ink-soft);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.icon-btn:hover:not(:disabled) {
  color: var(--ink);
  background: var(--hover-tint);
}

.icon-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── 链接 / 文本 ─────────────────────────────────────── */
.link {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 0;
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
  cursor: pointer;
  background: none;
  border: 0;
}

.link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.muted {
  font-size: 12px;
  color: var(--ink-faint);
}

.mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

code {
  padding: 1px 5px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-soft);
  overflow-wrap: anywhere;
  background: var(--surface-sunken);
  border: 1px solid var(--line);
  border-radius: 4px;
}

/* ── 徽标（状态语义；与全站 tone 同源）───────────────── */
.badge {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 2px 8px;
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--tone-neutral-dot);
  white-space: nowrap;
  background: var(--tone-neutral-bg);
  border-radius: var(--radius-pill);
}

.badge.active,
.badge.approved,
.badge.completed,
.badge.accepted,
.badge.green {
  color: var(--tone-success-dot);
  background: var(--tone-success-bg);
}

.badge.paused,
.badge.blocked,
.badge.draft,
.badge.amber,
.badge.planned,
.badge.pending,
.badge.protected {
  color: var(--tone-warning-dot);
  background: var(--tone-warning-bg);
}

.badge.failed,
.badge.rejected,
.badge.red,
.badge.canceled {
  color: var(--tone-danger-dot);
  background: var(--tone-danger-bg);
}

.badge.archived,
.badge.superseded,
.badge.gray,
.badge.waived,
.badge.expired {
  color: var(--tone-neutral-dot);
  background: var(--tone-neutral-bg);
}

.badge.blue,
.badge.dispatched,
.badge.running,
.badge.submitted {
  color: var(--tone-info-dot);
  background: var(--tone-info-bg);
}

.badge.reviewed {
  color: var(--tone-retry-dot);
  background: var(--tone-retry-bg);
}

/* ── 提示条 ───────────────────────────────────────────── */
.notice {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  padding: 9px 12px;
  margin: 0 0 14px;
  font-size: 12.5px;
  line-height: 1.55;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
}

.notice.danger {
  color: var(--tone-danger-dot);
  background: var(--tone-danger-bg);
  border-color: color-mix(in srgb, var(--tone-danger-dot) 20%, transparent);
}

.notice.ok {
  color: var(--tone-success-dot);
  background: var(--tone-success-bg);
  border-color: color-mix(in srgb, var(--tone-success-dot) 20%, transparent);
}

/* ── 对话 ─────────────────────────────────────────────── */
.chat-card {
  padding: 0;
  overflow: hidden;
  scroll-margin-top: 120px;
}

.chat-head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px;
  border-bottom: 1px solid var(--line);
}

.leader-id {
  display: flex;
  gap: 11px;
  align-items: center;
  min-width: 0;
}

.leader-avatar {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 38px;
  height: 38px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
  border-radius: 11px;
}

.leader-copy h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
}

.leader-copy p {
  margin: 3px 0 0;
  font-size: 11.5px;
  color: var(--ink-faint);
}

.chat-head-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.chat-hint {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin: 14px 18px 0;
  padding: 9px 11px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--tone-info-dot);
  background: var(--tone-info-bg);
  border: 1px solid color-mix(in srgb, var(--tone-info-dot) 20%, transparent);
  border-radius: var(--radius-control);
}

.chat-hint b {
  font-weight: 700;
  color: var(--tone-info-dot);
}

.chat-thread {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 132px;
  max-height: clamp(220px, 24vh, 420px);
  padding: 14px;
  margin: 14px 18px 0;
  overflow-y: auto;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
  scrollbar-gutter: stable;
}

.chat-empty {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  justify-content: center;
  min-height: 100px;
  font-size: 12px;
  color: var(--ink-faint);
  text-align: center;
}

.chat-empty strong {
  font-size: 13px;
  color: var(--ink-soft);
}

.chat-empty .i-tabler-messages {
  margin-bottom: 2px;
  font-size: 22px;
  opacity: 0.7;
}

.chat-row {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  max-width: min(86%, 680px);
}

.chat-row.user {
  flex-direction: row-reverse;
  align-self: flex-end;
}

.chat-avatar {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 26px;
  height: 26px;
  font-size: 10px;
  font-weight: 700;
  color: var(--ink-soft);
  background: var(--paper-tint);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.chat-row.agent .chat-avatar {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 22%, transparent);
}

.chat-row.user .chat-avatar {
  color: var(--tone-info-dot);
  background: var(--tone-info-bg);
  border-color: color-mix(in srgb, var(--tone-info-dot) 22%, transparent);
}

.chat-bubble-wrap {
  min-width: 0;
}

.chat-meta {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-bottom: 4px;
  font-size: 10.5px;
  color: var(--ink-faint);
}

.chat-row.user .chat-meta {
  justify-content: flex-end;
}

.chat-meta strong {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ink-soft);
}

.chat-body {
  padding: 9px 12px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink);
  overflow-wrap: anywhere;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: 4px 12px 12px 12px;
}

.chat-row.user .chat-body {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 20%, transparent);
  border-radius: 12px 4px 12px 12px;
}

.chat-body :deep(p) {
  margin: 0 0 7px;
}

.chat-body :deep(p:last-child) {
  margin-bottom: 0;
}

.chat-body :deep(ul),
.chat-body :deep(ol) {
  padding-left: 18px;
  margin: 6px 0;
}

.chat-body :deep(li) {
  margin: 2px 0;
}

.chat-body :deep(blockquote) {
  padding: 2px 0 2px 10px;
  margin: 7px 0;
  color: var(--ink-soft);
  border-left: 2px solid var(--accent);
}

.chat-body :deep(pre) {
  padding: 10px;
  margin: 8px 0;
  overflow-x: auto;
  background: var(--surface-sunken);
  border: 1px solid var(--line);
  border-radius: 6px;
}

.chat-body :deep(pre code) {
  padding: 0;
  font-size: 11.5px;
  background: none;
  border: 0;
}

.chat-body :deep(.code-block) {
  margin: 8px 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 6px;
}

.chat-body :deep(.code-head) {
  display: flex;
  justify-content: space-between;
  padding: 4px 8px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ink-faint);
  background: var(--paper-deep);
  border-bottom: 1px solid var(--line);
}

/* mdLite 的复制按钮在项目对话里没有事件委托，隐藏而不是留一个假控件 */
.chat-body :deep(.code-copy) {
  display: none;
}

.chat-compose {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 18px 18px;
}

.chat-compose textarea {
  width: 100%;
  min-height: 78px;
  line-height: 1.6;
  resize: vertical;
}

.chat-compose-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}

.composer-hint {
  display: inline-flex;
  flex: 1 1 260px;
  gap: 6px;
  align-items: center;
  font-size: 11.5px;
  color: var(--ink-faint);
}

.composer-right {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-left: auto;
}

/* ── 列表 / 表单 ─────────────────────────────────────── */
.channel-list,
.deliverable-list,
.approval-list,
.timeline-list,
.artifact-list {
  padding: 0;
  margin: 0;
  list-style: none;
}

.channel-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.channel-list li {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  align-items: center;
  padding: 9px 11px;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
}

.channel-list li.detached {
  opacity: 0.72;
}

.channel-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  background: var(--tone-success-dot);
  border-radius: 50%;
  box-shadow: 0 0 0 3px var(--tone-success-bg);
}

.channel-dot.off {
  background: var(--ink-fainter);
  box-shadow: none;
}

.channel-charter {
  margin-left: auto;
}

.deliverable-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.deliverable-list li {
  padding: 11px 13px;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
}

.deliverable-main {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.deliverable-criteria {
  margin: 7px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-soft);
}

.criteria-label {
  padding: 1px 6px;
  margin-right: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-faint);
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: 4px;
}

.form-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-start;
  margin-top: 14px;
}

.form-grid > input {
  flex: 1 1 220px;
}

.form-grid > textarea {
  flex: 1 1 100%;
}

.form-grid > .field-select {
  flex: 1 1 220px;
  min-width: 180px;
}

.form-grid > .btn {
  margin-left: auto;
}

input,
select,
textarea {
  min-height: 34px;
  padding: 8px 10px;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

input::placeholder,
textarea::placeholder {
  color: var(--ink-fainter);
}

input:hover,
textarea:hover,
select:hover {
  border-color: var(--line-strong);
}

input:focus,
select:focus,
textarea:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.inline-check {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 11.5px;
  color: var(--ink-soft);
  cursor: pointer;
}

.inline-check input {
  width: 14px;
  min-height: 0;
  padding: 0;
  accent-color: var(--accent);
}

/* Ant Design Select：容器跟随页面表面，弹层由 ConfigProvider 主题接管 */
.form-grid :deep(.ant-select-selector) {
  background: var(--paper-deep) !important;
  border-color: var(--line) !important;
}

.form-grid :deep(.ant-select-selection-placeholder) {
  color: var(--ink-fainter);
}

/* ── 执行工作台 ───────────────────────────────────────── */
.live-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  background: var(--ink-fainter);
  border-radius: 50%;
}

.live-dot.on {
  background: var(--tone-success-dot);
  box-shadow: 0 0 0 3px var(--tone-success-bg);
  animation: livePulse 1.8s ease-in-out infinite;
}

@keyframes livePulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.stat-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0 14px;
}

.stat {
  display: inline-flex;
  gap: 5px;
  align-items: baseline;
  padding: 6px 10px;
  font-size: 11.5px;
  color: var(--ink-faint);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}

.stat b {
  font-family: var(--font-mono);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}

.lanes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
  margin: 12px 0;
}

.lane {
  padding: 11px;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
}

.lane-head {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  align-items: center;
  margin-bottom: 8px;
}

.lane-head strong {
  font-size: 12.5px;
  color: var(--ink);
}

.lane-empty {
  margin: 4px 0 0;
}

.exec-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 10px;
  margin-bottom: 7px;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
  transition:
    border-color var(--transition-fast),
    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}

.exec-card:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}

.exec-card-top {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  justify-content: space-between;
}

.exec-card strong {
  font-size: 12.5px;
  line-height: 1.4;
}

.route-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding-top: 10px;
  margin-top: 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-faint);
  border-top: 1px dashed var(--line-strong);
}

.route-strip b {
  color: var(--ink-soft);
}

.timeline-list {
  display: flex;
  flex-direction: column;
}

.timeline-list li {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  align-items: center;
  padding: 7px 0;
  font-size: 12.5px;
  color: var(--ink-soft);
  border-bottom: 1px solid var(--line);
}

.timeline-list li:last-child {
  border-bottom: 0;
}

.timeline-type {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
}

.waiting-box {
  padding-top: 10px;
  margin-top: 12px;
  border-top: 1px dashed var(--line-strong);
}

/* ── 表格 ─────────────────────────────────────────────── */
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
}

table {
  width: 100%;
  min-width: 640px;
  font-size: 12.5px;
  border-collapse: collapse;
}

th {
  padding: 9px 12px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
  text-align: left;
  text-transform: uppercase;
  background: var(--paper-deep);
  border-bottom: 1px solid var(--line);
}

td {
  padding: 10px 12px;
  color: var(--ink-soft);
  vertical-align: top;
  border-bottom: 1px solid var(--line);
}

tbody tr:last-child td {
  border-bottom: 0;
}

tbody tr:hover td {
  background: var(--hover-tint);
}

.col-actions {
  white-space: nowrap;
}

.col-actions .btn + .btn {
  margin-left: 4px;
}

/* ── 计划 JSON / 成果 ────────────────────────────────── */
.plan-json {
  padding: 12px;
  margin: 10px 0 0;
  max-height: 320px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ink-soft);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--surface-sunken);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
}

.group-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding-top: 12px;
  margin: 18px 0 8px;
  border-top: 1px solid var(--line);
}

.group-head:first-of-type {
  padding-top: 0;
  margin-top: 4px;
  border-top: 0;
}

.result {
  padding: 12px 0;
  border-top: 1px dashed var(--line);
}

.result-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.summary {
  margin: 8px 0;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--ink-soft);
}

.evidence {
  margin: 6px 0 8px;
}

.evidence summary {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ink-faint);
  cursor: pointer;
}

.evidence code {
  display: block;
  max-height: 160px;
  padding: 8px;
  margin-top: 6px;
  overflow: auto;
  white-space: pre-wrap;
}

.result-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* ── 周报 ─────────────────────────────────────────────── */
.report-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 1px;
  margin-bottom: 10px;
  overflow: hidden;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
}

.report-stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  background: var(--paper-raised);
}

.report-stat b {
  font-family: var(--font-mono);
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}

/* ── 审批 ─────────────────────────────────────────────── */
.approval-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.approval-list li {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
}

.approval-main {
  display: flex;
  flex: 1 1 420px;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-width: 0;
}

.approval-kind {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink);
}

.approval-payload {
  flex: 1 1 100%;
  overflow-wrap: anywhere;
}

.approval-actions {
  display: flex;
  gap: 6px;
}

.history-list {
  display: flex;
  flex-direction: column;
  padding: 0;
  margin: 0;
  list-style: none;
}

.history-list li {
  padding: 9px 0;
  border-bottom: 1px solid var(--line);
}

.history-list li:last-child {
  border-bottom: 0;
}

.history-main {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.history-subject {
  flex: 1 1 240px;
  max-width: 46ch;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-time {
  margin-left: auto;
  white-space: nowrap;
}

/* ── 执行链抽屉 ──────────────────────────────────────── */
.drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  justify-content: flex-end;
  background: var(--scrim);
  backdrop-filter: blur(3px);
}

.drawer {
  width: min(760px, 94vw);
  height: 100%;
  padding: 18px 20px 40px;
  overflow: auto;
  background: var(--paper-raised);
  border-left: 1px solid var(--line);
  box-shadow: var(--shadow-lift-3);
}

.drawer-head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--line);
}

.drawer-head h2 {
  margin: 2px 0 0;
  font-size: 17px;
}

.attempt {
  padding: 12px 0;
  border-top: 1px dashed var(--line);
}

.artifact-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 6px 0;
}

.artifact-list li {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 11.5px;
}

.workers {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 8px;
}

.worker {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  font-size: 11.5px;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}

/* ── 焦点 ─────────────────────────────────────────────── */
.btn:focus-visible,
.tab:focus-visible,
.crumb:focus-visible,
.exec-card:focus-visible,
.icon-btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

/* ── 响应式 ───────────────────────────────────────────── */
@media (max-width: 900px) {
  .project-page {
    padding: 0 2px 40px;
  }

  .project-head {
    flex-direction: column;
    align-items: stretch;
  }

  .head-main,
  .head-actions {
    flex: 0 0 auto;
  }

  .head-actions {
    justify-content: flex-start;
    max-width: none;
  }

  .kpi-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .tabs {
    margin-inline: -4px;
    padding-inline: 4px;
  }

  .card {
    padding: 14px;
  }

  .grid2 {
    grid-template-columns: 1fr;
  }

  .chat-head {
    padding: 14px;
  }

  .chat-hint {
    margin-inline: 12px;
  }

  .chat-thread {
    max-height: clamp(200px, 28vh, 320px);
    padding: 12px;
    margin-inline: 12px;
  }

  .chat-compose {
    padding: 12px 14px 14px;
  }

  .chat-row {
    max-width: 96%;
  }

  .channel-charter {
    flex-basis: 100%;
    margin-left: 0;
  }

  .form-grid > .btn {
    flex: 1 1 100%;
    margin-left: 0;
  }

  .composer-right {
    width: 100%;
    justify-content: flex-end;
  }

  .drawer {
    width: 100vw;
  }
}

@media (max-width: 520px) {
  .title-line h1 {
    font-size: 23px;
  }

  .tab {
    padding: 6px 10px;
    font-size: 12.5px;
  }

  .chat-avatar {
    display: none;
  }

  .chat-row {
    max-width: 100%;
  }

  .chat-compose-actions {
    flex-direction: column;
    align-items: stretch;
  }

  /* 列向布局里 flex-basis 作用于高度：清掉 260px 基线，避免动作栏被撑高 300px */
  .composer-hint {
    flex: 0 0 auto;
  }

  .composer-right {
    justify-content: space-between;
  }

  .composer-right .btn {
    flex: 1;
  }

  .kpi {
    padding: 11px 12px;
  }

  .kpi-value {
    font-size: 19px;
  }
}

@media (pointer: coarse) {
  .btn,
  .tab,
  .icon-btn {
    min-height: 40px;
  }

  .btn.small {
    min-height: 34px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .live-dot.on,
  .spin {
    animation: none;
  }

  .btn,
  .tab,
  .exec-card {
    transition: none;
  }
}
</style>
