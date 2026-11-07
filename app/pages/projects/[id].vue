<script setup lang="ts">
/**
 * /projects/:id —— 项目详情（2026-11-07 控制台 ChatGPT 化三区重建）。
 * 覆盖：概览、频道、计划/交付物、工作项派发、成果提交/复核/验收、审计。
 *
 * 布局：裸 console 布局下的三区应用框 —— 左侧导航(分组条目,tab 语义原样保留
 * data-testid=tab-*)+ 中央列(标题条 + 卡片分区)+ 右侧项目快照(≥1200px 常驻)。
 * 交互契约:全部 data-testid 原位保留(projects-smoke/interactions 依赖);
 * 数据逻辑零改动,本轮只动模板外壳与样式声部。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { mdLite } from '@/app/composables/workshop/useEventBlocks'
import { useUserStore } from '~/stores/workshop/user'
import type { AepChatMessage } from '#shared/workshop-protocol'

definePageMeta({ layout: 'console' })

// 认证守卫(与 workspace 页同语义:裸布局无全局页头登录框,未登录回总览)
// SSR 阶段不判(会话恢复是客户端插件),客户端挂载后校验。
const userStore = useUserStore()
onMounted(() => {
  if (!userStore.isLoggedIn) navigateTo('/workshop')
})

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

const bindForm = reactive({ channelId: '', charter: '' })
const deliverableForm = reactive({ name: '', ownerChannelId: '', acceptance: '' })
const workForm = reactive({ deliverableId: '', channelId: '', title: '', brief: '', execBudgetMinutes: 60 })

const pendingApprovals = computed(() => approvals.value.filter(a => a.status === 'pending'))
const currentResults = computed(() => results.value)

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
    if (!workForm.channelId && channels.value[0]) workForm.channelId = channels.value[0].channelId
    if (!deliverableForm.ownerChannelId && channels.value[0]) deliverableForm.ownerChannelId = channels.value[0].channelId
  })
  void loadProjectSessions()
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

/**
 * 打开会话（2026-11-07）：把 session 所属 Channel 挂到 workspace 后直达控制台会话视图。
 * 已挂载的频道直接跳；未挂载时自动挂载（幂等）——这是「project/task session → 控制台」的可视入口。
 */
async function openSessionConsole(channelId: string): Promise<void> {
  if (!channelId) return
  await run(async () => {
    const res = await http.get<{ data: Array<{ id: string, channelIds: string[] }> }>('/workshop/workspaces')
    const list = res.data ?? []
    let target: { id: string, channelIds: string[] } | undefined = list.find(w => w.channelIds.includes(channelId))
    if (!target && list.length > 0) {
      const first = list[0]!
      target = first
      await http.post(`/workshop/workspaces/${first.id}/channels/${channelId}`, {})
    }
    if (!target) {
      error.value = '还没有 Workspace，请先在「Agent 工作台」创建一个'
      return
    }
    await navigateTo(`/workshop/w/${target.id}?view=sessions&channel=${channelId}`)
  })
}

async function openTaskSession(wi: WorkItemObs): Promise<void> {
  if (wi.instanceChannelId) await openSessionConsole(wi.instanceChannelId)
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

/** Session Context：project/task session 目录（brief 预览；不拉原始 transcript） */
const projectSessions = ref<ProjectSessionObs[]>([])
async function loadProjectSessions(): Promise<void> {
  try {
    const r = await http.get<{ data: ProjectSessionObs[] }>(`/workshop/projects/${id}/sessions`)
    projectSessions.value = r.data ?? []
  }
  catch {
    projectSessions.value = []
  }
}
onMounted(loadProjectSessions)

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

/** PR15 五 tab（plan §7.2）：概览/计划与工作/交付物/审批/决策与事件。 */
type TabKey = 'overview' | 'plan' | 'deliverables' | 'approvals' | 'events'
const activeTab = ref<TabKey>('overview')
/** 侧栏导航项(ChatGPT 化):tab 语义不变,icon 供侧栏条目使用 */
const tabs: Array<{ key: TabKey, label: string, icon: string }> = [
  { key: 'overview', label: '概览', icon: 'i-tabler-dashboard' },
  { key: 'plan', label: '计划与工作', icon: 'i-tabler-route' },
  { key: 'deliverables', label: '交付物', icon: 'i-tabler-package' },
  { key: 'approvals', label: '审批', icon: 'i-tabler-circle-check' },
  { key: 'events', label: '决策与事件', icon: 'i-tabler-history' },
]

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
  /** 任务实例（2026-11-07）：专属执行 Channel + 会话行 */
  instanceChannelId?: string | null
  sessionId?: string | null
  sessionStatus?: string | null
}
/** 任务会话（项目观测 lanes[].sessions[]；一任务一实例一会话） */
interface TaskSessionObs {
  workItemId: string
  workItemTitle: string
  workItemState: string
  sessionId: string | null
  sessionTitle: string | null
  sessionStatus: string | null
  sessionKind: string | null
  instanceChannelId: string | null
  instanceEnabled: boolean
}

/** Session Context：Project project/task session 目录（只返回 brief 预览） */
interface ProjectSessionObs {
  id: string
  kind: 'manual' | 'task' | 'project'
  title: string
  status: string
  channelId: string
  projectId: string | null
  workItemId: string | null
  summary: string
  currentTask: string | null
  lastActiveAt: string | null
}
interface ChannelObs { channelId: string, name: string, enabled: number, leadAgentId: string | null, status: string, workItems: number, inFlight: number, ready: number, blocked: number, sessions?: TaskSessionObs[] }
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
  <div class="page">
    <!-- ══ 左区:项目导航侧栏(ChatGPT 侧栏声部;tab/生命周期入口全部在此) ══ -->
    <aside class="side">
      <div class="side-head">
        <button
          class="back"
          type="button"
          title="项目列表"
          @click="navigateTo('/projects')"
        >
          <span class="i-tabler-arrow-right" />
        </button>
        <span class="brand">AgentWorkShop</span>
      </div>

      <div class="proj-id">
        <div class="proj-name">
          {{ project?.name ?? '项目' }}
        </div>
        <div class="proj-tags">
          <span
            v-if="project"
            class="badge"
            :class="project.status"
          >{{ project.status }}</span>
          <span
            v-if="obs"
            class="badge gray"
          >{{ obs.access.role }}</span>
        </div>
        <p
          v-if="project?.objective"
          class="proj-obj"
        >
          {{ project.objective }}
        </p>
      </div>

      <nav
        class="side-nav"
        data-testid="project-tabs"
      >
        <div class="side-label">
          项目导航
        </div>
        <button
          v-for="t in tabs"
          :key="t.key"
          class="side-item"
          :class="{ active: activeTab === t.key }"
          :data-testid="`tab-${t.key}`"
          @click="activeTab = t.key"
        >
          <span :class="t.icon" />
          <span class="side-item-label">{{ t.label }}</span>
          <span
            v-if="t.key === 'approvals' && pendingApprovals.length"
            class="side-count"
          >{{ pendingApprovals.length }}</span>
        </button>
      </nav>

      <div class="side-life">
        <div class="side-label">
          生命周期
        </div>
        <div class="life-grid">
          <button
            v-if="canContinueProject"
            class="btn small"
            data-testid="continue-project"
            @click="focusContinue"
          >
            {{ project?.status === 'completed' ? '继续开发' : '补充需求' }}
          </button>
          <button
            class="btn small ghost"
            :disabled="loading"
            @click="lifecycle('reconcile')"
          >
            对账
          </button>
          <button
            v-if="project?.status === 'draft' || project?.status === 'paused'"
            class="btn small"
            :disabled="loading"
            @click="lifecycle('activate')"
          >
            激活
          </button>
          <button
            v-if="project?.status === 'active'"
            class="btn small ghost"
            :disabled="loading"
            @click="lifecycle('pause')"
          >
            暂停
          </button>
          <button
            v-if="project?.status === 'paused'"
            class="btn small"
            :disabled="loading"
            @click="lifecycle('resume')"
          >
            恢复
          </button>
          <button
            v-if="project?.status === 'active'"
            class="btn small"
            :disabled="loading"
            @click="completeProject"
          >
            完成
          </button>
          <button
            v-if="project && project.status !== 'active' && project.status !== 'archived'"
            class="btn small ghost"
            :disabled="loading"
            @click="lifecycle('archive')"
          >
            归档
          </button>
        </div>
      </div>

      <div class="side-foot">
        <span class="side-meta">plan v{{ project?.planVersion ?? 0 }} · leader {{ project?.leadAgentId?.slice(0, 8) ?? '-' }}</span>
      </div>
    </aside>

    <!-- ══ 中区:主列(标题条 + 卡片分区) ══ -->
    <div class="main-col">
      <header class="top">
        <h1>{{ project?.name ?? '项目' }}</h1>
        <p class="sub">
          plan v{{ project?.planVersion ?? 0 }} · 待审批 {{ pendingApprovals.length }} 项 · leader {{ project?.leadAgentId ?? '-' }}
        </p>
      </header>

      <p
        v-if="error"
        class="error"
      >
        {{ error }}
      </p>

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
            <span class="muted">{{ chatMessages.length }} 条对话</span>
            <button
              type="button"
              class="btn small ghost"
              :disabled="chatLoading"
              @click="loadChat"
            >
              刷新
            </button>
          </div>
        </header>

        <p
          v-if="project?.status === 'completed'"
          class="chat-hint"
        >
          项目已完成。<b>发送补充需求会自动重新打开项目</b>；Leader 会先读现状，再提出增量计划（plan vN+1），owner 批准后继续派发、验收，不需要新建项目。
        </p>
        <p
          v-else-if="project?.status === 'paused'"
          class="chat-hint"
        >
          项目已暂停；发送补充需求会自动恢复为进行中，再交给同一个 Project Leader 评估。
        </p>
        <p
          v-else
          class="chat-hint"
        >
          消息直接进入项目办公室，由同一个 Project Leader 接收；适合补充 bug 复现、变更需求和验收反馈。
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
                v-html="mdLite(m.text)"
              />
              <!-- eslint-enable vue/no-v-html -->
            </div>
          </div>
        </div>

        <p
          v-if="chatError"
          class="error"
        >
          {{ chatError }}
        </p>
        <p
          v-if="chatNotice"
          class="muted"
        >
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
              Ctrl/⌘ + Enter 发送
              <template v-if="!canContinueProject">
                · 只有项目 owner 可继续开发
              </template>
            </span>
            <div class="composer-right">
              <span class="muted mono">{{ chatText.length }} / 8000</span>
              <button
                class="btn small"
                data-testid="project-continue-send"
                :disabled="chatSending || !chatText.trim() || !canContinueProject"
                @click="sendContinuation"
              >
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
        <div class="row actions">
          <h2>频道</h2>
          <a
            v-if="project?.officeChannelId"
            class="link"
            :href="`/workshop`"
            data-testid="open-office"
          >
            在 Agent 工作台打开办公室频道（{{ project.officeChannelId.slice(0, 8) }}…）
          </a>
        </div>
        <p
          v-if="!channels.length"
          class="muted"
        >
          尚未绑定成员 Channel。
        </p>
        <ul class="list">
          <li
            v-for="c in channels"
            :key="c.channelId"
          >
            <code>{{ c.channelId }}</code>
            <span
              class="badge"
              :class="{ protected: c.bindingType === 'user_bound' }"
              data-testid="protected-badge"
            >
              {{ c.bindingType === 'user_bound' ? '用户绑定 · 受保护' : c.bindingType }}
            </span>
            <span class="muted">{{ c.charter || '无 charter' }}</span>
          </li>
        </ul>
        <div class="form">
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
            class="btn"
            :disabled="loading"
            @click="bindChannel"
          >
            绑定
          </button>
        </div>
      </section>

      <section
        v-show="activeTab === 'deliverables'"
        class="card"
      >
        <h2>交付物</h2>
        <p
          v-if="!deliverables.length"
          class="muted"
        >
          至少一个必选交付物才能激活。
        </p>
        <ul class="list">
          <li
            v-for="d in deliverables"
            :key="d.id"
          >
            <strong>{{ d.name }}</strong>
            <span
              class="badge"
              :class="d.status"
            >{{ d.status }}</span>
            <span class="muted">{{ d.required ? '必选' : '可选' }}</span>
          </li>
        </ul>
        <div class="form">
          <input
            v-model="deliverableForm.name"
            data-testid="deliverable-name"
            placeholder="交付物名称"
          >
          <select v-model="deliverableForm.ownerChannelId">
            <option value="">
              选择所属频道
            </option>
            <option
              v-for="c in channels"
              :key="c.channelId"
              :value="c.channelId"
            >
              {{ c.channelId }}
            </option>
          </select>
          <textarea
            v-model="deliverableForm.acceptance"
            rows="2"
            placeholder="验收标准（每行一条）"
          />
          <button
            class="btn"
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
        <div class="row actions">
          <h2 style="margin:0">
            执行工作台
          </h2>
          <span
            class="live-dot"
            :class="{ on: obsLoading }"
          />
          <span class="muted">快照 {{ lastObsAt || '—' }} · 5s 轮询</span>
          <label
            v-if="obs?.access.canManage"
            class="muted inline-check"
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
            :class="obs.project.routingPolicy"
          >{{ obs.project.routingPolicy }}</span>
          <span
            v-if="obs"
            class="badge"
          >{{ obs.access.role }}</span>
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
              <span class="muted">{{ lane.channel.inFlight }} 执行 · {{ lane.channel.ready }} 就绪<template v-if="lane.channel.sessions?.length"> · {{ lane.channel.sessions.length }} 任务会话</template></span>
            </div>
            <p
              v-if="!lane.items.length"
              class="muted"
            >
              无工作项
            </p>
            <div
              v-for="w in lane.items"
              :key="w.id"
              class="exec-card"
              role="button"
              tabindex="0"
              :data-testid="`exec-work-item-${w.id}`"
              @click="openWorkItem(w.id)"
              @keydown.enter="openWorkItem(w.id)"
            >
              <span class="row">
                <strong>{{ w.title }}</strong>
                <span
                  class="badge"
                  :class="stageTone(w.stage)"
                >{{ stageLabel(w.stage) }}</span>
              </span>
              <span class="muted">attempt {{ w.attemptCount }}/{{ w.maxAttempts }} · 成果 {{ w.lastResultStatus || '—' }}<template v-if="w.reworkCount"> · rework {{ w.reworkCount }}</template></span>
              <!-- 任务实例（2026-11-07）：每任务一个专属 Channel + 会话，点击直达会话视图 -->
              <span
                v-if="w.sessionId || w.instanceChannelId"
                class="task-session-row"
              >
                <span
                  class="badge"
                  :class="w.sessionStatus === 'active' ? 'active' : 'archived'"
                  :data-testid="`task-session-${w.id}`"
                >{{ w.sessionStatus === 'active' ? '任务会话 · 进行中' : '任务会话 · 已归档' }}</span>
                <span class="muted mono">{{ (w.sessionId || '—').slice(0, 14) }}</span>
                <a-button
                  v-if="w.instanceChannelId"
                  size="small"
                  type="link"
                  :data-testid="`open-task-session-${w.id}`"
                  @click.stop="openTaskSession(w)"
                >
                  打开会话
                </a-button>
              </span>
              <span
                v-if="w.waitingReason"
                class="muted"
              >{{ w.waitingOn }}: {{ w.waitingReason }}</span>
              <span
                v-else-if="w.stateReason"
                class="muted"
              >{{ w.stateReason }}</span>
            </div>
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
        <h2>路由与派发日志</h2>
        <div class="grid2">
          <div>
            <h3>派发 / 重试 / 返工 / 升级</h3>
            <p
              v-if="!dispatchLog.length"
              class="muted"
            >
              暂无派发记录。
            </p>
            <ul class="list">
              <li
                v-for="e in dispatchLog"
                :key="e.id"
              >
                <span>{{ e.type }}</span>
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
            <ul class="list">
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
          <ul class="list">
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
        <h2>计划快照（当前 v{{ project?.planVersion ?? 0 }}）</h2>
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
        <h3>计划决策快照（decisions.args_json）</h3>
        <ul class="list">
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
        <h2>工作项 / 派发</h2>
        <table>
          <thead><tr><th>标题</th><th>频道</th><th>状态</th><th>预算</th><th /></tr></thead>
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
                >{{ w.state }}</span>
              </td>
              <td>{{ w.execBudgetMinutes }}m</td>
              <td>
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
          </tbody>
        </table>
        <div class="form inline">
          <select
            v-model="workForm.deliverableId"
            data-testid="select-work-deliverable"
          >
            <option value="">
              选择交付物
            </option>
            <option
              v-for="d in deliverables"
              :key="d.id"
              :value="d.id"
            >
              {{ d.name }}
            </option>
          </select>
          <select
            v-model="workForm.channelId"
            data-testid="select-work-channel"
          >
            <option value="">
              选择频道
            </option>
            <option
              v-for="c in channels"
              :key="c.channelId"
              :value="c.channelId"
            >
              {{ c.channelId }}
            </option>
          </select>
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
          >
          <button
            class="btn"
            :disabled="loading"
            @click="createWorkItem"
          >
            新增
          </button>
        </div>
      </section>

      <section
        v-show="activeTab === 'deliverables'"
        class="card"
      >
        <h2>成果（按交付物分组）</h2>
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
            >{{ group.deliverable.status }}</span>
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
            <div class="row">
              <strong>{{ r.title }}</strong>
              <span
                class="badge"
                :class="r.status"
              >{{ r.status }}</span>
              <span class="muted">v{{ r.version }}</span>
            </div>
            <p class="summary">
              {{ r.summary }}
            </p>
            <div class="muted">
              evidence: {{ r.evidenceJson }}
            </div>
            <div class="row actions">
              <button
                v-if="r.status === 'draft' || r.status === 'rejected'"
                class="btn small"
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
                class="btn small"
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
        <h2>周报</h2>
        <p
          v-if="!report"
          class="muted"
        >
          周报未加载。
        </p>
        <template v-else>
          <p class="sub">
            进度 {{ report.progress?.ratio ?? 0 }}（{{ report.progress?.completedWorkItems ?? 0 }}/{{ report.progress?.scoreableWorkItems ?? 0 }} 工作项） ·
            交付物 {{ report.deliverables?.total ?? 0 }}（必选验收 {{ report.deliverables?.requiredApproved ?? 0 }}/{{ report.deliverables?.requiredTotal ?? 0 }}） ·
            成果 {{ report.results?.total ?? 0 }} · 阻塞 {{ report.workItems?.blocked ?? 0 }} · 近 7 天事件 {{ report.recentEvents?.count ?? 0 }}
          </p>
          <p class="muted">
            generatedAt: {{ report.generatedAt }}
          </p>
        </template>
        <div class="row actions">
          <button
            class="btn small ghost"
            data-testid="btn-report-refresh"
            :disabled="loading"
            @click="loadReport"
          >
            刷新周报
          </button>
          <button
            class="btn small"
            data-testid="btn-report-export"
            :disabled="loading || !report"
            @click="exportReport"
          >
            导出周报
          </button>
        </div>
      </section>

      <section
        v-show="activeTab === 'overview'"
        class="card"
        data-testid="project-sessions"
      >
        <div class="row actions">
          <h2 style="margin:0">
            项目会话
          </h2>
          <span class="muted">{{ projectSessions.length }} 个 session</span>
          <span style="flex:1" />
          <button
            class="btn small ghost"
            :disabled="loading"
            @click="loadProjectSessions"
          >
            刷新会话
          </button>
        </div>
        <p
          v-if="!projectSessions.length"
          class="muted"
        >
          暂无会话。项目创建会生成 project session；工作项派发会生成 task session。
        </p>
        <ul
          v-else
          class="list"
        >
          <li
            v-for="s in projectSessions"
            :key="s.id"
          >
            <span class="badge blue">{{ s.kind }}</span>
            <strong>{{ s.title }}</strong>
            <span
              class="badge"
              :class="s.status === 'active' ? 'active' : 'archived'"
            >{{ s.status }}</span>
            <span class="muted">{{ s.currentTask || s.summary || '—' }}</span>
            <a-button
              size="small"
              type="link"
              :data-testid="`open-project-session-${s.id}`"
              @click="openSessionConsole(s.channelId)"
            >
              打开会话
            </a-button>
          </li>
        </ul>
      </section>

      <section
        v-show="activeTab === 'approvals'"
        class="card"
      >
        <h2>待审批</h2>
        <p
          v-if="!pendingApprovals.length"
          class="muted"
        >
          无待审批。
        </p>
        <ul class="list">
          <li
            v-for="a in pendingApprovals"
            :key="a.id"
          >
            <span>{{ a.kind }} · {{ a.subjectId }}</span>
            <span
              v-if="a.payloadJson && a.payloadJson !== '{}'"
              class="muted"
            >
              payload: {{ a.payloadJson.slice(0, 180) }}{{ a.payloadJson.length > 180 ? '…' : '' }}
            </span>
            <span
              v-else-if="a.reason"
              class="muted"
            >
              {{ a.reason }}
            </span>
            <button
              class="btn small green"
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
          </li>
        </ul>
      </section>

      <section
        v-show="activeTab === 'approvals'"
        class="card"
      >
        <h2>审批历史</h2>
        <p
          v-if="!approvalHistory.length"
          class="muted"
        >
          暂无审批记录。
        </p>
        <ul class="list">
          <li
            v-for="h in approvalHistory.slice(0, 50)"
            :key="h.id"
          >
            <span>{{ h.kind }} · {{ h.subjectId }}</span>
            <span
              class="badge"
              :class="h.status"
            >{{ h.status }}</span>
            <span
              v-if="h.payloadJson && h.payloadJson !== '{}'"
              class="muted"
            >
              payload: {{ h.payloadJson.slice(0, 140) }}{{ h.payloadJson.length > 140 ? '…' : '' }}
            </span>
            <code class="muted">{{ h.expiresAt ?? '' }}</code>
          </li>
        </ul>
      </section>

      <section
        v-show="activeTab === 'events'"
        class="grid2"
      >
        <div class="card">
          <h2>决策（最近 50）</h2>
          <ul class="list">
            <li
              v-for="d in decisions.slice(-50)"
              :key="d.id"
            >
              <span>#{{ d.seq }} {{ d.decisionType }}</span>
              <span class="badge">{{ d.state }}</span>
              <button
                v-if="d.decisionType === 'dispatch.proposed' && d.state === 'proposed'"
                class="btn small green"
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
          <h2>事件（最近 50）</h2>
          <ul class="list">
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
        >
          <header class="row actions">
            <h2 style="margin:0">
              执行链
            </h2>
            <span class="muted">{{ selectedWorkItemId.slice(0, 8) }}…</span>
            <button
              class="btn small ghost"
              @click="closeDrawer"
            >
              关闭
            </button>
          </header>
          <p
            v-if="detailLoading"
            class="muted"
          >
            加载执行链…
          </p>
          <template v-else-if="detail">
            <h3>{{ detail.workItem.title }}</h3>
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
                  <span class="badge">{{ w.state }}</span>
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
                >{{ r.status }}</span>
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
              <div class="muted">
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
            <ul class="list">
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

    <!-- ══ 右区:项目快照(ChatGPT 上下文卡;纯附加,不含任何 data-testid) ══ -->
    <aside
      v-if="obs"
      class="ctx"
    >
      <div class="ctx-card">
        <div class="ctx-head">
          项目快照
          <span class="badge gray">{{ obs.project.routingPolicy }}</span>
        </div>
        <div class="ctx-stats">
          <div class="ctx-stat">
            <b>{{ obs.summary.ready }}</b><span>就绪</span>
          </div>
          <div class="ctx-stat">
            <b>{{ obs.summary.inFlight }}</b><span>执行中</span>
          </div>
          <div class="ctx-stat">
            <b>{{ obs.summary.waiting }}</b><span>等待</span>
          </div>
          <div class="ctx-stat">
            <b>{{ obs.summary.blocked }}</b><span>阻塞</span>
          </div>
        </div>
        <div class="ctx-progress">
          <div class="ctx-progress-row">
            <span>工作项完成</span>
            <b>{{ Math.round(Number(obs.summary.progress ?? 0) * 100) }}%</b>
          </div>
          <div class="ctx-bar">
            <i :style="{ width: `${Math.round(Number(obs.summary.progress ?? 0) * 100)}%` }" />
          </div>
          <div class="ctx-progress-row">
            <span>交付物签核</span>
            <b>{{ Math.round(Number(obs.summary.acceptanceProgress ?? 0) * 100) }}%</b>
          </div>
          <div class="ctx-bar">
            <i :style="{ width: `${Math.round(Number(obs.summary.acceptanceProgress ?? 0) * 100)}%` }" />
          </div>
        </div>
      </div>

      <div
        v-for="lane in itemsByChannel"
        :key="lane.channel.channelId"
        class="ctx-card"
      >
        <div class="ctx-head">
          <span class="ctx-lane-name">{{ lane.channel.name }}</span>
          <span
            class="badge"
            :class="lane.channel.enabled ? 'green' : 'gray'"
          >{{ lane.channel.enabled ? '启用' : '停用' }}</span>
        </div>
        <div class="ctx-meta">
          {{ lane.channel.inFlight }} 执行 · {{ lane.channel.ready }} 就绪
          <template v-if="lane.channel.sessions?.length">
            · {{ lane.channel.sessions.length }} 任务会话
          </template>
        </div>
        <div class="ctx-items">
          <div
            v-for="w in lane.items.slice(0, 4)"
            :key="w.id"
            class="ctx-item"
            role="button"
            tabindex="0"
            @click="openWorkItem(w.id)"
            @keydown.enter="openWorkItem(w.id)"
          >
            <span class="ctx-item-name">{{ w.title }}</span>
            <span
              class="badge"
              :class="stageTone(w.stage)"
            >{{ stageLabel(w.stage) }}</span>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* ═══ 三区应用框(ChatGPT 声部;令牌 = --chat-* 家族,2026-11-07) ═══ */
.page {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  color: var(--chat-ink);
  background: var(--chat-canvas);
}

/* ── 左区:导航侧栏 ── */
.side {
  display: flex;
  flex: 0 0 248px;
  flex-direction: column;
  min-height: 0;
  padding: 14px 12px 12px;
  overflow: hidden;
  background: var(--chat-surface-raised);
  border-right: 1px solid var(--chat-line);
}
.side-head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 0 4px 10px;
}
.back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  font-size: 15px;
  color: var(--chat-ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 8px;
  transition: color var(--transition-fast), background var(--transition-fast);
}
.back:hover {
  color: var(--chat-ink);
  background: color-mix(in srgb, var(--chat-ink) 6%, transparent);
}
.back .i-tabler-arrow-right { transform: rotate(180deg); }
.brand {
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.02em;
  color: var(--chat-ink-faint);
}
.proj-id {
  padding: 8px 6px 12px;
  border-bottom: 1px solid var(--chat-line);
}
.proj-name {
  overflow: hidden;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proj-tags {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 6px;
}
.proj-obj {
  display: -webkit-box;
  margin: 8px 0 0;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.55;
  color: var(--chat-ink-faint);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.side-nav {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  margin-top: 12px;
  overflow-y: auto;
}
.side-label {
  padding: 0 8px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--chat-ink-faint);
}
.side-item {
  display: flex;
  gap: 9px;
  align-items: center;
  width: 100%;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--chat-ink-soft);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 10px;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.side-item:hover { background: color-mix(in srgb, var(--chat-ink) 5%, transparent); }
.side-item.active {
  color: var(--chat-ink);
  font-weight: 600;
  background: color-mix(in srgb, var(--chat-ink) 9%, transparent);
}
.side-item .i-tabler-dashboard,
.side-item .i-tabler-route,
.side-item .i-tabler-package,
.side-item .i-tabler-circle-check,
.side-item .i-tabler-history { font-size: 15px; color: var(--chat-ink-faint); }
.side-item.active .i-tabler-dashboard,
.side-item.active .i-tabler-route,
.side-item.active .i-tabler-package,
.side-item.active .i-tabler-circle-check,
.side-item.active .i-tabler-history { color: var(--chat-accent); }
.side-item-label {
  flex: 1 1 auto;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-count {
  padding: 0 7px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 18px;
  color: var(--chat-accent-strong);
  background: var(--chat-accent-soft);
  border-radius: var(--radius-pill);
}
.side-life {
  padding: 12px 0 4px;
  border-top: 1px solid var(--chat-line);
}
.life-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  padding: 0 2px;
}
.life-grid .btn { width: 100%; }
.side-foot {
  padding: 10px 6px 0;
}
.side-meta {
  display: block;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--chat-ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 中区:主列 ── */
.main-col {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 0 24px 40px;
}
.top {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px 4px 14px;
  margin: 0 0 4px;
  background: var(--chat-canvas);
  border-bottom: 1px solid var(--chat-line);
}
h1 {
  padding: 0;
  margin: 0;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.015em;
}
h2 { font-size: 15px; font-weight: 650; margin: 0 0 12px; }
h3 { font-size: 13.5px; font-weight: 600; margin: 14px 0 8px; }
h4 { font-size: 13px; font-weight: 600; margin: 16px 0 8px; }
.sub { color: var(--chat-ink-faint); margin: 0; font-size: 12.5px; }
.link { background: none; border: 0; color: var(--chat-accent-strong); cursor: pointer; padding: 0; }
.row, .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

/* 卡片:白面发丝线圆角(ChatGPT 卡片声部) */
.card {
  padding: 18px 20px;
  margin: 16px 0;
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: 16px;
}
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.group-head {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 14px 0 6px;
  padding-top: 12px;
  border-top: 1px dashed var(--chat-line);
}
.plan-json {
  padding: 12px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  background: color-mix(in srgb, var(--chat-ink) 4%, transparent);
  border: 1px solid var(--chat-line);
  border-radius: 10px;
}
.list { list-style: none; padding: 0; margin: 0 0 10px; display: flex; flex-direction: column; gap: 8px; }
.list li { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; color: var(--chat-ink); }
.form { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.form.inline { flex-direction: row; flex-wrap: wrap; }
input, select, textarea {
  padding: 8px 10px;
  font-size: 13px;
  color: var(--chat-ink);
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: 10px;
  transition: border-color var(--transition-fast);
}
input:focus, select:focus, textarea:focus {
  border-color: var(--chat-line-strong);
  outline: none;
}
input::placeholder, textarea::placeholder { color: var(--chat-ink-faint); }

/* 按钮:反色主钮(前景取画布色;暗色自动翻为黑字白底)+ 幽灵/语义色 */
.btn {
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--chat-canvas);
  cursor: pointer;
  background: var(--chat-ink);
  border: 0;
  border-radius: 10px;
  transition: opacity var(--transition-fast);
}
.btn:hover { opacity: 0.88; }
.btn.small { padding: 5px 10px; font-size: 12px; }
.btn.ghost {
  color: var(--chat-ink);
  background: transparent;
  border: 1px solid var(--chat-line);
}
.btn.ghost:hover { opacity: 1; border-color: var(--chat-line-strong); }
.btn.green { background: var(--tone-success-dot); }
.btn.danger { background: var(--tone-danger-dot); }
.btn:disabled { opacity: .5; cursor: not-allowed; }

/* 徽标:tinted pill(tone 语义沿用全局令牌) */
.badge {
  padding: 2px 9px;
  font-size: 11px;
  line-height: 16px;
  color: var(--chat-ink-soft);
  background: color-mix(in srgb, var(--chat-ink) 6%, transparent);
  border-radius: 999px;
}
.badge.active, .badge.approved, .badge.completed, .badge.reviewed {
  color: var(--tone-success-dot);
  background: var(--tone-success-bg);
}
.badge.paused, .badge.blocked, .badge.draft, .badge.submitted, .badge.planned {
  color: var(--tone-warning-dot);
  background: var(--tone-warning-bg);
}
.badge.failed, .badge.rejected {
  color: var(--tone-danger-dot);
  background: var(--tone-danger-bg);
}
.badge.archived, .badge.superseded, .badge.canceled {
  color: var(--chat-ink-faint);
  background: color-mix(in srgb, var(--chat-ink) 6%, transparent);
}
.badge.protected { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.muted { color: var(--chat-ink-faint); font-size: 12px; }
.error { color: var(--tone-danger-dot); }
.result { padding: 12px 0; border-top: 1px solid var(--chat-line); }
.summary { color: var(--chat-ink-soft); font-size: 13px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 8px; text-align: left; border-bottom: 1px solid var(--chat-line); vertical-align: top; }
code {
  padding: 1px 5px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  color: var(--chat-accent-strong);
  background: var(--chat-accent-soft);
  border-radius: 5px;
}

/* Router v3 执行工作台 */
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--chat-line-strong); display: inline-block; }
.live-dot.on { background: var(--tone-success-dot); box-shadow: 0 0 8px var(--tone-success-dot); }
.inline-check { display: inline-flex; gap: 6px; align-items: center; }
.stat-strip { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0; }
.stat {
  padding: 7px 11px;
  font-size: 12px;
  color: var(--chat-ink-faint);
  background: color-mix(in srgb, var(--chat-ink) 3%, transparent);
  border: 1px solid var(--chat-line);
  border-radius: 10px;
}
.stat b { margin-right: 4px; font-size: 15px; color: var(--chat-ink); }
.lanes { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin: 12px 0; }
.lane {
  padding: 14px;
  background: color-mix(in srgb, var(--chat-ink) 3%, transparent);
  border: 1px solid var(--chat-line);
  border-radius: 12px;
}
.lane-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.exec-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  padding: 11px 12px;
  margin-bottom: 8px;
  color: var(--chat-ink);
  text-align: left;
  cursor: pointer;
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: 12px;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.exec-card:hover {
  border-color: var(--chat-line-strong);
  box-shadow: 0 6px 18px rgb(12 10 9 / 6%);
}
.exec-card strong { font-size: 13px; }
/* 任务实例：任务卡内的会话行（徽标 + 会话 id + 直达入口） */
.task-session-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.task-session-row :deep(.ant-btn-link) { padding: 0; height: auto; font-size: 12px; }
.mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.route-strip {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  padding-top: 10px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--chat-ink-faint);
  border-top: 1px dashed var(--chat-line);
}
.route-strip b { color: var(--chat-ink); }
.badge.blue { color: var(--tone-info-dot); background: var(--tone-info-bg); }
.badge.amber { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.badge.red { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.badge.green { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.badge.gray { color: var(--chat-ink-faint); background: color-mix(in srgb, var(--chat-ink) 6%, transparent); }
.waiting-box { margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--chat-line); }

/* 执行链抽屉:白面(右侧滑入) */
.drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  justify-content: flex-end;
  background: rgb(12 10 9 / 32%);
}
.drawer {
  width: min(720px, 94vw);
  height: 100%;
  padding: 20px;
  overflow: auto;
  color: var(--chat-ink);
  background: var(--chat-surface);
  border-left: 1px solid var(--chat-line);
  box-shadow: -24px 0 60px rgb(12 10 9 / 12%);
}
.drawer h3 { font-size: 15px; margin: 4px 0 8px; }
.drawer h4 { font-size: 13px; margin: 18px 0 8px; color: var(--chat-ink-soft); }
.attempt { padding: 10px 0; border-top: 1px solid var(--chat-line); }
.artifact-list { list-style: none; padding: 0; margin: 6px 0; display: flex; flex-direction: column; gap: 4px; }
.artifact-list li { display: flex; gap: 8px; align-items: center; font-size: 12px; }
.workers { margin-top: 8px; display: flex; flex-direction: column; gap: 5px; }
.worker {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 9px;
  font-size: 12px;
  background: color-mix(in srgb, var(--chat-ink) 3%, transparent);
  border-radius: 8px;
}

/* ── 右区:项目快照上下文卡(ChatGPT 右栏同位;≥1200px 常驻) ── */
.ctx {
  display: flex;
  flex: 0 0 292px;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 16px 14px;
  overflow-y: auto;
  background: var(--chat-surface-raised);
  border-left: 1px solid var(--chat-line);
}
.ctx-card {
  padding: 14px;
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: 14px;
}
.ctx-head {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 650;
}
.ctx-lane-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.ctx-stat {
  display: flex;
  gap: 6px;
  align-items: baseline;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--chat-ink) 3%, transparent);
  border-radius: 10px;
}
.ctx-stat b { font-size: 16px; }
.ctx-stat span { font-size: 11px; color: var(--chat-ink-faint); }
.ctx-progress { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
.ctx-progress-row {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--chat-ink-faint);
}
.ctx-progress-row b { color: var(--chat-ink); }
.ctx-meta { margin-bottom: 8px; font-size: 11px; color: var(--chat-ink-faint); }
.ctx-items { display: flex; flex-direction: column; gap: 4px; }
.ctx-item {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  font-size: 12px;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 8px;
  transition: background var(--transition-fast);
}
.ctx-item:hover { background: color-mix(in srgb, var(--chat-ink) 5%, transparent); }
.ctx-item-name {
  overflow: hidden;
  color: var(--chat-ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 徽标不换行(窄卡里"成果待提交"会被压成竖排) */
.ctx-item .badge {
  flex: 0 0 auto;
  white-space: nowrap;
}
/* 自绘进度条(antd 默认蓝不属本声部;发丝线槽 + 油墨填充) */
.ctx-bar {
  height: 6px;
  overflow: hidden;
  margin-top: 6px;
  background: color-mix(in srgb, var(--chat-ink) 8%, transparent);
  border-radius: 999px;
}
.ctx-bar i {
  display: block;
  height: 100%;
  background: var(--chat-ink);
  border-radius: inherit;
  transition: width var(--transition-slow);
}

/* ── 响应式 ── */
@media (max-width: 1199.98px) {
  .ctx { display: none; }
}
@media (max-width: 860px) {
  .page { flex-direction: column; overflow-y: auto; }
  .side {
    flex: 0 0 auto;
    padding: 12px;
    border-right: 0;
    border-bottom: 1px solid var(--chat-line);
  }
  .proj-obj { display: none; }
  .side-nav { flex-direction: row; flex-wrap: wrap; overflow-x: auto; }
  .side-nav .side-label { display: none; }
  .side-item { width: auto; }
  .side-life, .side-foot { display: none; }
  .main-col { padding: 0 12px 40px; }
  .grid2 { grid-template-columns: 1fr; }
  .drawer { width: 100vw; }
}

/* ── Project Leader 对话（持续开发）────────────────────────────── */
.chat-card { display: flex; flex-direction: column; gap: 12px; }
.chat-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--chat-line);
}
.leader-id { display: flex; align-items: center; gap: 10px; min-width: 0; }
.leader-avatar {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--chat-canvas);
  background: var(--chat-ink);
  border-radius: 50%;
}
.leader-copy h2 { margin: 0; font-size: 15px; font-weight: 650; }
.leader-copy p { margin: 2px 0 0; font-size: 12px; color: var(--chat-ink-faint); }
.chat-head-actions { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
.chat-hint {
  margin: 0;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--chat-ink-soft);
  background: color-mix(in srgb, var(--chat-ink) 4%, transparent);
  border-radius: 10px;
}
.chat-thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 420px;
  overflow-y: auto;
  padding: 4px 2px;
}
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 28px 12px;
  font-size: 13px;
  color: var(--chat-ink-faint);
  text-align: center;
}
.chat-empty strong { font-size: 14px; color: var(--chat-ink-soft); }
.chat-row { display: flex; gap: 10px; align-items: flex-start; }
.chat-row.user { flex-direction: row-reverse; }
.chat-avatar {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--chat-ink-soft);
  background: color-mix(in srgb, var(--chat-ink) 7%, transparent);
  border-radius: 50%;
}
.chat-bubble-wrap { max-width: min(78%, 640px); min-width: 0; }
.chat-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 3px;
  font-size: 11px;
  color: var(--chat-ink-faint);
}
.chat-row.user .chat-meta { justify-content: flex-end; }
.chat-meta strong { font-size: 12px; color: var(--chat-ink-soft); }
.chat-body {
  padding: 9px 12px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--chat-ink);
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: 12px;
  overflow-wrap: anywhere;
}
.chat-row.user .chat-body { background: var(--chat-bubble-user, color-mix(in srgb, var(--chat-ink) 6%, transparent)); }
.chat-body :deep(p) { margin: 0 0 6px; }
.chat-body :deep(p:last-child) { margin-bottom: 0; }
.chat-body :deep(ul),
.chat-body :deep(ol) { margin: 6px 0; padding-left: 18px; }
.chat-body :deep(code) {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  background: color-mix(in srgb, var(--chat-ink) 6%, transparent);
  border-radius: 4px;
  padding: 1px 4px;
}
.chat-body :deep(pre) {
  margin: 6px 0;
  padding: 8px 10px;
  overflow-x: auto;
  background: color-mix(in srgb, var(--chat-ink) 5%, transparent);
  border-radius: 8px;
}
.chat-body :deep(pre code) { background: transparent; padding: 0; }
.chat-compose { display: flex; flex-direction: column; gap: 8px; }
.chat-compose textarea {
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.6;
  color: var(--chat-ink);
  background: var(--chat-canvas);
  border: 1px solid var(--chat-line);
  border-radius: 12px;
  resize: vertical;
  transition: border-color var(--transition-fast);
}
.chat-compose textarea:focus { border-color: var(--chat-line-strong); outline: none; }
.chat-compose textarea:disabled { opacity: 0.6; cursor: not-allowed; }
.chat-compose-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.composer-hint { font-size: 11px; color: var(--chat-ink-faint); }
.composer-right { display: flex; align-items: center; gap: 10px; }
.mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; }
@media (max-width: 860px) {
  .chat-bubble-wrap { max-width: 86%; }
  .chat-compose-actions { flex-direction: column; align-items: stretch; }
  .composer-right { justify-content: space-between; }
}
</style>
