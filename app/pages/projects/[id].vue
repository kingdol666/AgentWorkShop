<script setup lang="ts">
/**
 * /projects/:id —— 项目详情（Project 工作台）。
 *
 * 布局：裸 console 布局下的三区应用框 —— 左导航（tab/生命周期）+ 中央工作区
 * （概览 / 计划与工作 / 交付物 / 审批 / 决策与事件）+ 右侧上下文（快照/泳道/成员/健康）。
 * 交互契约：data-testid=tab-* 等既有锚点原位保留（projects-smoke 依赖）；
 * 数据层：GET /projects/:id 八路并发 + observability(5s) + activity 游标分页
 * + /channels 目录（频道名/可绑定频道，2026-11-09）。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { mdLite } from '@/app/composables/workshop/useEventBlocks'
import { approvalSummary } from '@/app/utils/project-approval'
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
  successCriteriaJson?: string
  status: string
  mode: string
  routingPolicy?: string
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
interface ApprovalDto { id: string, kind: string, subjectId: string, status: string, createdAt?: string, expiresAt: string | null, payloadJson?: string, reason?: string, argsDigest?: string }
interface DecisionDto { id: string, seq: number, decisionType: string, state: string, outcome: string, traceId: string, createdAt: string }
interface EventDto { id: string, seq: number, type: string, eventKey: string, traceId: string, createdAt: string }
interface MemberDto { projectId: string, userId: string, role: string, addedBy?: string, addedAt?: string }
interface ChannelCatalogDto { id: string, name: string, leadAgentId: string | null, enabled: number, permissions?: { canManage?: boolean } | null }

const route = useRoute()
const id = String(route.params.id)
const http = useHttp()
const loading = ref(false)
const bootstrapLoading = ref(true)
const error = ref('')
const project = ref<ProjectDto | null>(null)
const channels = ref<ChannelBindingDto[]>([])
const deliverables = ref<DeliverableDto[]>([])
const workItems = ref<WorkItemDto[]>([])
const results = ref<ResultDto[]>([])
const approvals = ref<ApprovalDto[]>([])
const decisions = ref<DecisionDto[]>([])
const events = ref<EventDto[]>([])
const members = ref<MemberDto[]>([])
const channelCatalog = ref<ChannelCatalogDto[]>([])

const bindForm = reactive({ channelId: '', charter: '', manual: '' })
const bindManual = ref(false)
const deliverableForm = reactive({ name: '', ownerChannelId: '', acceptance: '' })
const workForm = reactive({ deliverableId: '', channelId: '', title: '', brief: '', execBudgetMinutes: 60 })

const pendingApprovals = computed(() => approvals.value.filter(a => a.status === 'pending'))
const currentResults = computed(() => results.value)
/** 任务实例绑定（每工作项一个专属 Channel）——与执行频道分开计数，避免"频道数"虚高。 */
const taskInstanceCount = computed(() => channels.value.filter(c => c.bindingType === 'task_instance').length)

const errMsg = (e: unknown): string =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message
  ?? (e instanceof Error ? e.message : '操作失败')

async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  loading.value = true
  error.value = ''
  try {
    return await fn()
  }
  catch (e) {
    error.value = errMsg(e)
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
}

/** 频道目录：给"ID → 名称"和"可绑定候选"提供人类可读数据（失败不影响主视图）。 */
async function loadChannelCatalog(): Promise<void> {
  try {
    const r = await http.get<{ data: ChannelCatalogDto[] }>('/workshop/channels')
    channelCatalog.value = r.data ?? []
  }
  catch {
    channelCatalog.value = []
  }
}

async function loadMembers(): Promise<void> {
  try {
    const r = await http.get<{ data: MemberDto[] }>(`/workshop/projects/${id}/members`)
    members.value = r.data ?? []
  }
  catch {
    members.value = []
  }
}

async function lifecycle(action: 'activate' | 'pause' | 'resume' | 'archive' | 'reconcile'): Promise<void> {
  if (action === 'archive' && !window.confirm('归档后项目只读，确定归档？')) return
  await run(async () => {
    if (action === 'reconcile') await http.post(`/workshop/projects/${id}/reconcile`, {})
    else await http.post(`/workshop/projects/${id}/${action}`, {})
    await Promise.all([load(), loadObservability(), loadActivity(true)])
  })
}

async function completeProject(): Promise<void> {
  if (!window.confirm('完成项目会走完成门（必选交付物必须签核）。确定继续？')) return
  await run(async () => {
    await http.post(`/workshop/projects/${id}/complete`, {})
    await Promise.all([load(), loadObservability(), loadActivity(true)])
  })
}

/** 绑定频道：优先下拉选择（真实频道目录），保留手动填 ID 的兜底通道。 */
async function bindChannel(): Promise<void> {
  const channelId = (bindForm.channelId || bindForm.manual).trim()
  if (!channelId) return
  await run(async () => {
    await http.post(`/workshop/projects/${id}/channels`, { channelId, charter: bindForm.charter.trim() })
    bindForm.channelId = ''
    bindForm.manual = ''
    bindForm.charter = ''
    await Promise.all([load(), loadObservability(), loadChannelCatalog(), loadActivity(true)])
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
    await Promise.all([load(), loadObservability(), loadActivity(true)])
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
    await Promise.all([load(), loadObservability(), loadActivity(true)])
  })
}

async function dispatch(workItemId: string): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/work-items/${workItemId}/dispatch`, {})
    await Promise.all([load(), loadObservability(), loadActivity(true)])
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

/** 打开项目办公室（Leader 频道），走与任务会话相同的 workspace 挂载逻辑。 */
async function openOffice(): Promise<void> {
  if (project.value?.officeChannelId) await openSessionConsole(project.value.officeChannelId)
}

async function submitResult(result: ResultDto): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/results/${result.id}/submit`, {
      summary: result.summary || '（由成果页提交）',
    })
    await Promise.all([load(), loadObservability(), loadActivity(true)])
  })
}

async function review(result: ResultDto, decision: 'reviewed' | 'rejected'): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/results/${result.id}/review`, { decision })
    await Promise.all([load(), loadObservability(), loadActivity(true)])
  })
}

async function requestAcceptance(result: ResultDto): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/results/${result.id}/request-acceptance`, {})
    await Promise.all([load(), loadObservability(), loadActivity(true)])
  })
}

async function decide(approval: ApprovalDto, approve: boolean): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/approvals/${approval.id}/decide`, { approve })
    await Promise.all([load(), loadObservability(), loadHistory(), loadActivity(true)])
  })
}

/** owner 应用 project leader 的派发提案（decision.state='proposed'）。 */
async function applyProposal(decisionId: string): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/proposals/${decisionId}/apply`, {})
    await Promise.all([load(), loadObservability(), loadActivity(true)])
  })
}

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
    if (!chatMessages.value.length) chatError.value = errMsg(e)
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
    await Promise.all([load(), loadChat(), loadObservability(), loadActivity(true)])
    scrollChatToBottom(true)
  }
  catch (e) {
    chatError.value = errMsg(e)
  }
  finally {
    chatSending.value = false
  }
}

/** PR15 五 tab（plan §7.2）：概览/计划与工作/交付物/审批/决策与事件。 */
type TabKey = 'overview' | 'plan' | 'deliverables' | 'approvals' | 'events'
const activeTab = ref<TabKey>('overview')
const activeTabLabel = computed(() => tabs.find(t => t.key === activeTab.value)?.label ?? '概览')
/** 侧栏导航项(ChatGPT 化):tab 语义不变,icon 供侧栏条目使用 */
const tabs: Array<{ key: TabKey, label: string, icon: string }> = [
  { key: 'overview', label: '概览', icon: 'i-tabler-dashboard' },
  { key: 'plan', label: '计划与工作', icon: 'i-tabler-route' },
  { key: 'deliverables', label: '交付物', icon: 'i-tabler-package' },
  { key: 'approvals', label: '审批', icon: 'i-tabler-circle-check' },
  { key: 'events', label: '决策与事件', icon: 'i-tabler-history' },
]
const tabCount = (key: TabKey): number => {
  if (key === 'plan') return workItems.value.length
  if (key === 'deliverables') return deliverables.value.length
  if (key === 'approvals') return pendingApprovals.value.length
  if (key === 'events') return decisions.value.length + events.value.length
  return 0
}

/** 深链：?tab=plan 直达；切 tab 写回 query（不产生历史堆栈）。 */
function syncTabFromQuery(): void {
  const q = String(route.query.tab ?? '')
  if (tabs.some(t => t.key === q)) activeTab.value = q as TabKey
}
watch(activeTab, (k) => {
  const query = { ...route.query }
  if (k === 'overview') delete query.tab
  else query.tab = k
  void navigateTo({ path: route.path, query }, { replace: true })
  if (k === 'approvals') void loadHistory()
  if (k === 'events') void loadActivity(true)
})

/** 审批历史（scope=all）。 */
const approvalHistory = ref<ApprovalDto[]>([])
async function loadHistory(): Promise<void> {
  await run(async () => {
    const r = await http.get<{ data: ApprovalDto[] }>(`/workshop/projects/${id}/approvals?scope=all`)
    approvalHistory.value = r.data ?? []
  })
}

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
const successCriteria = computed<string[]>(() => {
  if (obs.value?.project.successCriteria?.length) return obs.value.project.successCriteria
  try {
    const parsed = JSON.parse(project.value?.successCriteriaJson ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  }
  catch {
    return []
  }
})

/** 重派工作项（FAILED/CANCELED 后新 attempt）。 */
async function retryWorkItem(workItemId: string): Promise<void> {
  await run(async () => {
    await http.post(`/workshop/projects/${id}/work-items/${workItemId}/retry`, {})
    await Promise.all([load(), loadObservability(), loadActivity(true)])
  })
}

/** owner 取消工作项（完成门豁免入口）。 */
async function cancelWorkItem(workItemId: string): Promise<void> {
  const reason = window.prompt('取消工作项的理由：') ?? ''
  if (!reason.trim()) return
  await run(async () => {
    await http.post(`/workshop/projects/${id}/work-items/${workItemId}/cancel`, { reason })
    await Promise.all([load(), loadObservability(), loadActivity(true)])
  })
}

/** owner 豁免交付物（完成门豁免入口）。 */
async function waiveDeliverable(deliverableId: string): Promise<void> {
  const reason = window.prompt('豁免交付物的理由：') ?? ''
  if (!reason.trim()) return
  await run(async () => {
    await http.post(`/workshop/projects/${id}/deliverables/${deliverableId}/waive`, { reason })
    await Promise.all([load(), loadObservability(), loadActivity(true)])
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
interface HealthRow { component?: string, status?: string, consecutiveFailures?: number, lastError?: string | null, lastHeartbeatAt?: string | null }
interface ObservabilityDto {
  project: ProjectDto & { autoDispatch: boolean, routingPolicy: string, successCriteria?: string[] }
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
  kernel: { health: HealthRow[], effects: Record<string, number>, planApprovedVersion: number | null, ledger: { count: number, lastAt: string | null } }
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

/** 统一活动流（events + decisions，keyset 游标）。 */
interface ActivityItem {
  id: string
  kind: 'event' | 'decision'
  type: string
  at: string
  traceId?: string
  state?: string
  reason?: string
  actorKind?: string
  payload?: Record<string, unknown>
  workItemId?: string | null
  channelId?: string | null
}

const obs = ref<ObservabilityDto | null>(null)
const obsLoading = ref(false)
const selectedWorkItemId = ref('')
const detail = ref<DetailDto | null>(null)
const detailLoading = ref(false)
const lastObsAt = ref('')
let obsTimer: ReturnType<typeof setInterval> | null = null

const activity = ref<ActivityItem[]>([])
const activityCursor = ref<string | null>(null)
const activityHasMore = ref(false)
const activityLoading = ref(false)

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
const catalogNameOf = (channelId: string): string | undefined =>
  channelCatalog.value.find(c => c.id === channelId)?.name
/** 绑定行的人类可读频道名（observability → 频道目录 → 短 id 三级回退） */
const channelNameOf = (channelId: string): string =>
  obs.value?.channels.find(c => c.channelId === channelId)?.name
  ?? catalogNameOf(channelId)
  ?? channelId.slice(0, 8)
/** 任务实例行的可读标签:charter 里带着「任务实例: W1 …」,比裸 UUID 有信息量 */
const bindingLabel = (c: { channelId: string, bindingType: string, charter?: string }): string =>
  c.bindingType === 'task_instance'
    ? (c.charter || '任务实例')
    : channelNameOf(c.channelId)
/** 可绑定频道：目录中尚未绑定的频道（避免 select 里出现必然 409 的选项） */
const bindableChannels = computed(() => {
  const bound = new Set(channels.value.map(c => c.channelId))
  return channelCatalog.value.filter(c => !bound.has(c.id))
})
const dispatchLog = computed(() => events.value
  .filter(e => ['work.dispatched', 'work.dispatch_auto', 'work.retry_scheduled', 'work.retried', 'work.rework', 'route.deferred', 'route.escalated'].includes(e.type))
  .slice(-30)
  .reverse())
const routeDecisions = computed(() => decisions.value.filter(d => d.decisionType === 'route.proposed').slice(-20).reverse())

/** 执行看板列（后端派生 stage → 列；前端只分组，不改语义）。 */
interface BoardColumn { key: string, label: string, icon: string, tone: string, items: WorkItemObs[] }
const boardColumns = computed<BoardColumn[]>(() => {
  const items = obs.value?.workItems ?? []
  const pick = (pred: (w: WorkItemObs) => boolean) => items.filter(pred)
  const doneStages = ['completed_pending_result', 'result_pending_submit', 'result_pending_review', 'result_pending_acceptance', 'result_rejected', 'accepted', 'failed', 'canceled', 'superseded']
  return [
    { key: 'ready', label: '就绪待派发', icon: 'i-tabler-send', tone: 'blue', items: pick(w => w.stage === 'ready') },
    { key: 'running', label: '执行中', icon: 'i-tabler-player-play', tone: 'green', items: pick(w => ['dispatching', 'dispatched', 'running'].includes(w.stage)) },
    { key: 'waiting', label: '等待', icon: 'i-tabler-hourglass-high', tone: 'amber', items: pick(w => w.stage.startsWith('waiting') || w.stage === 'deferred') },
    { key: 'blocked', label: '阻塞 / 返工', icon: 'i-tabler-alert-octagon', tone: 'red', items: pick(w => ['blocked', 'rework'].includes(w.stage)) },
    { key: 'done', label: '完成 / 验收链', icon: 'i-tabler-circle-check', tone: 'gray', items: pick(w => doneStages.includes(w.stage)) },
  ]
})
const boardTotal = computed(() => boardColumns.value.reduce((n, c) => n + c.items.length, 0))

/** 交付物卡片：优先用 observability 的门禁投影，回退到原始行。 */
interface DeliverableCard {
  id: string
  name: string
  status: string
  required: boolean
  ownerChannelId: string | null
  acceptanceCriteria: string[]
  dependsOn: string[]
  contentReady: boolean
  technicalAccepted: boolean
  businessApproved: boolean
  resultCount: number
}
const deliverableCards = computed<DeliverableCard[]>(() => {
  if (obs.value?.deliverables?.length) {
    return obs.value.deliverables.map(d => ({
      id: d.id,
      name: d.name,
      status: d.status,
      required: d.required,
      ownerChannelId: deliverables.value.find(x => x.id === d.id)?.ownerChannelId ?? null,
      acceptanceCriteria: d.acceptanceCriteria ?? [],
      dependsOn: d.dependsOn ?? [],
      contentReady: d.contentReady,
      technicalAccepted: d.technicalAccepted,
      businessApproved: d.businessApproved,
      resultCount: d.resultCount,
    }))
  }
  return deliverables.value.map((d) => {
    let criteria: string[] = []
    try {
      const parsed = JSON.parse(d.acceptanceCriteriaJson || '[]')
      if (Array.isArray(parsed)) criteria = parsed.filter((x): x is string => typeof x === 'string')
    }
    catch { /* 容错：坏 JSON 当空标准 */ }
    return {
      id: d.id,
      name: d.name,
      status: d.status,
      required: d.required === 1,
      ownerChannelId: d.ownerChannelId,
      acceptanceCriteria: criteria,
      dependsOn: [],
      contentReady: results.value.some(r => r.deliverableId === d.id),
      technicalAccepted: results.value.some(r => r.deliverableId === d.id && ['reviewed', 'approved'].includes(r.status)),
      businessApproved: d.status === 'approved' || d.status === 'waived',
      resultCount: results.value.filter(r => r.deliverableId === d.id).length,
    }
  })
})
const deliverableName = (deliverableId: string): string =>
  deliverables.value.find(d => d.id === deliverableId)?.name ?? deliverableId.slice(0, 8)

/** 可重试口径：失败/取消/成果被驳回/任务完成但尚未生成成果；已验收不再给"重试"。 */
const retryableStages = ['failed', 'canceled', 'completed_pending_result', 'result_rejected']
const canRetryRow = (w: WorkItemDto): boolean => {
  const stage = obs.value?.workItems.find(x => x.id === w.id)?.stage
  return stage ? retryableStages.includes(stage) : ['FAILED', 'CANCELED'].includes(w.state)
}

const statusLabels: Record<string, string> = {
  draft: '草稿',
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  archived: '已归档',
  planned: '待生产',
  submitted: '待复核',
  reviewed: '待验收',
  approved: '已签核',
  rejected: '已驳回',
  waived: '已豁免',
  superseded: '已替代',
  pending: '待决定',
}
const statusLabel = (s: string): string => statusLabels[s] ?? s

const approvalKindLabels: Record<string, string> = {
  plan_approval: '计划审批',
  deliverable_acceptance: '交付物验收',
  result_acceptance: '成果验收',
  result_review: '成果复核',
  project_complete: '项目完成',
  production_write: '生产写授权',
}
const approvalKind = (kind: string): string => approvalKindLabels[kind] ?? kind

/** 审批摘要:用当前项目的交付物/成果名补全 payload 里只有 id 的情况 */
function approvalSummaryOf(h: ApprovalDto): string {
  return approvalSummary(h.kind, h.payloadJson, {
    subjectId: h.subjectId,
    deliverables: deliverables.value.map(d => ({ id: d.id, name: d.name })),
    results: results.value.map(r => ({ id: r.id, title: r.title })),
  })
}

/** 审批 reason 只有人话才展示;`deliverable acceptance` 这类枚举码不外露 */
function approvalReason(h: ApprovalDto): string {
  const r = (h.reason ?? '').trim()
  return r && !/^[a-z][a-z0-9_ -]*$/.test(r) ? r : '—'
}

const eventLabels: Record<string, string> = {
  'project.created': '项目创建',
  'project.activated': '项目激活',
  'project.paused': '项目暂停',
  'project.resumed': '项目恢复',
  'project.completed': '项目完成',
  'project.reopened': '项目重开',
  'project.reconciled': '对账完成',
  'channel.bound': '频道绑定',
  'channel.unbound': '频道解绑',
  'deliverable.created': '交付物新增',
  'deliverable.status': '交付物状态',
  'work.created': '工作项新增',
  'work.dispatched': '工作项派发',
  'work.dispatch_auto': '自动派发',
  'work.retried': '工作项重试',
  'work.completed': '工作项完成',
  'work.blocked': '工作项阻塞',
  'result.draft': '成稿生成',
  'result.submitted': '成果提交',
  'result.reviewed': '成果复核',
  'result.accepted': '成果签核',
  'result.rejected': '成果驳回',
  'route.proposed': '路由提案',
  'route.deferred': '路由延后',
  'route.escalated': '路由升级',
}
const eventLabel = (type: string): string => eventLabels[type] ?? type

/** 进度百分比（summary 里 0–1 还是 0–100 都兼容）。 */
const pct = (v: unknown): number => {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return 0
  return Math.round(n <= 1 ? n * 100 : n)
}
const projectProgress = computed(() => pct(obs.value?.summary.progress))
const acceptanceProgress = computed(() => pct(obs.value?.summary.acceptanceProgress))
const ringDash = computed(() => {
  const circ = 2 * Math.PI * 18
  return `${(circ * projectProgress.value) / 100} ${circ}`
})

function relTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(iso).toLocaleDateString()
}
function prettyJson(raw: string | undefined): string {
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  }
  catch {
    return raw
  }
}
const approvalPayload = (a: ApprovalDto): string => {
  const pretty = prettyJson(a.payloadJson)
  if (!pretty || pretty === '{}') return a.reason ?? ''
  return pretty.length > 320 ? `${pretty.slice(0, 320)}…` : pretty
}

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
    if (!obs.value) error.value = errMsg(e)
  }
  finally {
    obsLoading.value = false
  }
}

/** 活动流：首屏 80 条，页尾"加载更多"按游标续取。 */
async function loadActivity(reset = true): Promise<void> {
  activityLoading.value = true
  try {
    const after = !reset && activityCursor.value ? `&after=${encodeURIComponent(activityCursor.value)}` : ''
    const r = await http.get<{ data: { items: ActivityItem[], cursor: string | null, hasMore: boolean } }>(
      `/workshop/projects/${id}/observability/activity?limit=80${after}`,
    )
    const items = r.data?.items ?? []
    activity.value = reset ? items : [...activity.value, ...items]
    activityCursor.value = r.data?.cursor ?? null
    activityHasMore.value = r.data?.hasMore === true
  }
  catch {
    if (reset) activity.value = []
  }
  finally {
    activityLoading.value = false
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
    error.value = errMsg(e)
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

onMounted(async () => {
  syncTabFromQuery()
  await Promise.all([
    load(),
    loadChannelCatalog(),
    loadMembers(),
    loadReport(),
    loadProjectSessions(),
    loadObservability(),
    loadActivity(true),
  ])
  bootstrapLoading.value = false
  void loadChat()
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
    <!-- ══ 左区：项目导航（tab / 生命周期 / 返回平台） ══ -->
    <aside class="side">
      <div class="side-head">
        <button
          class="back"
          type="button"
          title="返回项目中心"
          aria-label="返回项目中心"
          @click="navigateTo('/projects')"
        >
          <span class="i-tabler-arrow-left" />
        </button>
        <button
          class="brand"
          type="button"
          title="返回 Agent 工作台"
          @click="navigateTo('/workshop')"
        >
          <span
            class="brand-dot"
            aria-hidden="true"
          />
          AgentWorkShop
        </button>
        <span class="side-version">project</span>
      </div>

      <div class="proj-id">
        <div
          class="proj-name"
          :title="project?.name"
        >
          {{ project?.name ?? '加载中…' }}
        </div>
        <div class="proj-tags">
          <span
            v-if="project"
            class="badge"
            :class="project.status"
          >{{ statusLabel(project.status) }}</span>
          <span
            v-if="obs"
            class="badge gray"
          >{{ obs.access.role }}</span>
          <span
            v-if="project"
            class="badge mono"
          >v{{ project.planVersion }}</span>
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
            v-if="tabCount(t.key)"
            class="side-count"
            :class="{ alert: t.key === 'approvals' }"
          >{{ tabCount(t.key) }}</span>
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
        <span class="side-meta mono">plan v{{ project?.planVersion ?? 0 }} · leader {{ project?.leadAgentId?.slice(0, 8) ?? '-' }}</span>
        <span class="side-meta">{{ project?.routingPolicy ?? obs?.project.routingPolicy ?? 'technical' }}</span>
      </div>
    </aside>

    <!-- ══ 中区：工作区 ══ -->
    <div class="main-col">
      <header class="top">
        <div class="crumb">
          <button
            class="crumb-link"
            type="button"
            @click="navigateTo('/projects')"
          >
            项目中心
          </button>
          <span class="crumb-sep">/</span>
          <h1>{{ activeTabLabel }}</h1>
        </div>
        <div class="top-actions">
          <span
            v-if="obs"
            class="live-pill"
            :class="{ on: !obsLoading, loading: obsLoading }"
          >
            <i aria-hidden="true" />
            实时快照 {{ lastObsAt || '—' }}
          </span>
          <button
            v-if="project?.officeChannelId"
            class="btn small ghost"
            data-testid="open-office"
            @click="openOffice"
          >
            <span class="i-tabler-message-2" />
            打开办公室
          </button>
          <button
            class="btn small ghost"
            :disabled="loading"
            @click="load(); loadObservability(); loadActivity(true)"
          >
            <span
              class="i-tabler-refresh"
              :class="{ spin: loading }"
            />
            刷新
          </button>
        </div>
      </header>

      <p
        v-if="error"
        class="error"
        role="alert"
      >
        <span class="i-tabler-alert-triangle" />
        {{ error }}
      </p>

      <!-- 首载骨架 -->
      <div
        v-if="bootstrapLoading && !project"
        class="skeleton-wrap"
        aria-busy="true"
      >
        <div class="sk-hero" />
        <div class="sk-card" />
        <div class="sk-card short" />
      </div>

      <!-- ══ 概览 ══ -->
      <template v-else>
        <section
          v-show="activeTab === 'overview'"
          class="hero"
        >
          <div class="hero-ring">
            <svg
              viewBox="0 0 44 44"
              aria-hidden="true"
            >
              <circle
                class="ring-bg"
                cx="22"
                cy="22"
                r="18"
              />
              <circle
                class="ring-fg"
                cx="22"
                cy="22"
                r="18"
                :style="{ strokeDasharray: ringDash }"
              />
            </svg>
            <div class="ring-label">
              <b>{{ projectProgress }}%</b>
              <span>工作项</span>
            </div>
          </div>
          <div class="hero-stats">
            <div class="hero-stat">
              <b>{{ obs?.summary.ready ?? 0 }}</b>
              <span>就绪</span>
            </div>
            <div class="hero-stat">
              <b>{{ obs?.summary.inFlight ?? 0 }}</b>
              <span>执行中</span>
            </div>
            <div class="hero-stat">
              <b>{{ obs?.summary.waiting ?? 0 }}</b>
              <span>等待</span>
            </div>
            <div
              class="hero-stat"
              :class="{ danger: Number(obs?.summary.blocked ?? 0) > 0 }"
            >
              <b>{{ obs?.summary.blocked ?? 0 }}</b>
              <span>阻塞</span>
            </div>
            <div class="hero-stat">
              <b>{{ acceptanceProgress }}%</b>
              <span>交付签核</span>
            </div>
          </div>
          <div
            v-if="successCriteria.length"
            class="hero-criteria"
          >
            <span class="hero-criteria-label">成功标准</span>
            <span
              v-for="(c, i) in successCriteria.slice(0, 4)"
              :key="i"
              class="criteria-chip"
            >{{ c }}</span>
          </div>
        </section>

        <!-- Project Leader 对话 -->
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
                    · <code>{{ channelNameOf(project.officeChannelId) }}</code>
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
                v-if="m.senderType !== 'user'"
                class="chat-avatar"
                aria-hidden="true"
              >PL</span>
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
            class="error inline"
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
              rows="2"
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

        <!-- 频道 -->
        <section
          v-show="activeTab === 'overview'"
          class="card"
        >
          <header class="card-head">
            <h2>频道</h2>
            <span class="muted">{{ channels.length }} 个绑定<template v-if="taskInstanceCount"> · {{ taskInstanceCount }} 个任务实例</template></span>
          </header>
          <p
            v-if="!channels.length"
            class="muted"
          >
            尚未绑定成员 Channel。绑定后 Leader 才能把工作项派发到执行频道。
          </p>
          <ul class="chan-list">
            <li
              v-for="c in channels"
              :key="c.channelId"
              class="chan-row"
            >
              <span
                class="chan-avatar"
                aria-hidden="true"
              >
                <span class="i-tabler-antenna" />
              </span>
              <div class="chan-main">
                <strong>{{ bindingLabel(c) }}</strong>
                <span class="chan-meta mono">{{ c.channelId.slice(0, 8) }}</span>
              </div>
              <span
                class="badge"
                :class="{ protected: c.bindingType === 'user_bound' }"
                data-testid="protected-badge"
              >
                {{ c.bindingType === 'user_bound' ? '用户绑定 · 受保护' : c.bindingType }}
              </span>
              <span class="chan-charter">{{ c.charter || '无 charter' }}</span>
              <button
                class="btn small ghost"
                @click="openSessionConsole(c.channelId)"
              >
                打开
              </button>
            </li>
          </ul>
          <p
            v-if="project?.status === 'completed'"
            class="form-locked"
          >
            项目已完成：频道绑定已冻结。如需变更，请用「继续开发」重新打开项目。
          </p>
          <div
            v-else
            class="form-grid bind-grid"
          >
            <label class="span2">
              <span>绑定已有 Channel</span>
              <select v-model="bindForm.channelId">
                <option value="">
                  {{ bindableChannels.length ? '选择可绑定频道' : '没有可绑定的频道（可手动填写 ID）' }}
                </option>
                <option
                  v-for="c in bindableChannels"
                  :key="c.id"
                  :value="c.id"
                >
                  {{ c.name }} · {{ c.id.slice(0, 8) }}
                </option>
              </select>
            </label>
            <label class="span2">
              <span>该频道在项目中的使命（charter，可选）</span>
              <input
                v-model="bindForm.charter"
                placeholder="例如：负责落地页视觉与前端实现"
              >
            </label>
            <label class="check-row">
              <input
                v-model="bindManual"
                type="checkbox"
              >
              <span>手动填写 Channel ID</span>
            </label>
            <label v-show="bindManual">
              <span>Channel ID</span>
              <input
                v-model="bindForm.manual"
                data-testid="bind-channel-id"
                placeholder="粘贴 Channel ID"
              >
            </label>
            <div class="span2 form-actions">
              <button
                class="btn"
                :disabled="loading || (!bindForm.channelId && !bindForm.manual.trim())"
                @click="bindChannel"
              >
                绑定频道
              </button>
            </div>
          </div>
        </section>

        <!-- 项目会话 + 周报 -->
        <div
          v-show="activeTab === 'overview'"
          class="two-col"
        >
          <section
            class="card"
            data-testid="project-sessions"
          >
            <header class="card-head">
              <h2>项目会话</h2>
              <span class="muted">{{ projectSessions.length }} 个 session</span>
              <span class="spacer" />
              <button
                class="btn small ghost"
                :disabled="loading"
                @click="loadProjectSessions"
              >
                刷新会话
              </button>
            </header>
            <p
              v-if="!projectSessions.length"
              class="muted"
            >
              暂无会话。项目创建会生成 project session；工作项派发会生成 task session。
            </p>
            <ul
              v-else
              class="session-list"
            >
              <li
                v-for="s in projectSessions"
                :key="s.id"
                class="session-row"
              >
                <span class="badge blue">{{ s.kind }}</span>
                <div class="session-main">
                  <strong>{{ s.title }}</strong>
                  <span class="muted">{{ s.currentTask || s.summary || '—' }}</span>
                </div>
                <span
                  class="badge"
                  :class="s.status === 'active' ? 'active' : 'archived'"
                >{{ s.status }}</span>
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

          <section class="card">
            <header class="card-head">
              <h2>周报</h2>
              <span class="muted">{{ report?.generatedAt ? relTime(report.generatedAt) : '未加载' }}</span>
            </header>
            <p
              v-if="!report"
              class="muted"
            >
              周报未加载。
            </p>
            <div
              v-else
              class="report-grid"
            >
              <div class="report-stat">
                <b>{{ report.progress?.completedWorkItems ?? 0 }}/{{ report.progress?.scoreableWorkItems ?? 0 }}</b>
                <span>工作项</span>
              </div>
              <div class="report-stat">
                <b>{{ report.deliverables?.requiredApproved ?? 0 }}/{{ report.deliverables?.requiredTotal ?? 0 }}</b>
                <span>必选签核</span>
              </div>
              <div class="report-stat">
                <b>{{ report.results?.total ?? 0 }}</b>
                <span>成果</span>
              </div>
              <div class="report-stat">
                <b :class="{ 'tone-warn': Number(report.workItems?.blocked ?? 0) > 0 }">{{ report.workItems?.blocked ?? 0 }}</b>
                <span>阻塞</span>
              </div>
            </div>
            <p
              v-if="report"
              class="muted report-line"
            >
              近 7 天事件 {{ report.recentEvents?.count ?? 0 }} · 待审批 {{ report.approvals?.pending ?? 0 }} · generatedAt {{ report.generatedAt }}
            </p>
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
        </div>

        <!-- ══ 计划与工作 ══ -->
        <section
          v-show="activeTab === 'plan'"
          class="card exec-workbench"
          data-testid="exec-workbench"
        >
          <header class="card-head">
            <h2>执行工作台</h2>
            <span
              class="live-dot"
              :class="{ on: obsLoading }"
              aria-hidden="true"
            />
            <span class="muted">快照 {{ lastObsAt || '—' }} · 5s 轮询</span>
            <span class="spacer" />
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
              class="badge mono"
            >{{ obs.project.routingPolicy }}</span>
            <span
              v-if="obs"
              class="badge"
            >{{ obs.access.role }}</span>
          </header>

          <div
            v-if="obs"
            class="stat-strip"
            data-testid="exec-summary"
          >
            <span class="stat"><b>{{ obs.summary.ready }}</b> 就绪</span>
            <span class="stat"><b>{{ obs.summary.inFlight }}</b> 执行中</span>
            <span class="stat"><b>{{ obs.summary.waiting }}</b> 等待</span>
            <span class="stat"><b>{{ obs.summary.blocked }}</b> 阻塞/返工</span>
            <span class="stat"><b>{{ projectProgress }}%</b> 工作项完成</span>
            <span class="stat"><b>{{ acceptanceProgress }}%</b> 交付物签核</span>
          </div>

          <!-- 执行看板：后端 stage → 列 -->
          <div
            v-if="obs"
            class="board"
            :class="{ empty: boardTotal === 0 }"
          >
            <div
              v-for="col in boardColumns"
              :key="col.key"
              class="board-col"
              :class="`tone-${col.tone}`"
            >
              <header class="board-col-head">
                <span
                  :class="col.icon"
                  aria-hidden="true"
                />
                <span class="board-col-label">{{ col.label }}</span>
                <span class="board-col-count">{{ col.items.length }}</span>
              </header>
              <p
                v-if="!col.items.length"
                class="board-empty"
              >
                空
              </p>
              <div
                v-for="w in col.items"
                :key="w.id"
                class="wc"
                role="button"
                tabindex="0"
                :data-testid="`exec-work-item-${w.id}`"
                @click="openWorkItem(w.id)"
                @keydown.enter="openWorkItem(w.id)"
              >
                <div class="wc-top">
                  <strong>{{ w.title }}</strong>
                  <span
                    class="badge"
                    :class="stageTone(w.stage)"
                  >{{ stageLabel(w.stage) }}</span>
                </div>
                <div class="wc-meta">
                  <span class="wc-chan">
                    <span
                      class="i-tabler-antenna"
                      aria-hidden="true"
                    />
                    {{ channelNameOf(w.channelId) }}
                  </span>
                  <span class="wc-deliv">{{ deliverableName(w.deliverableId) }}</span>
                </div>
                <div class="wc-foot">
                  <span class="mono">attempt {{ w.attemptCount }}/{{ w.maxAttempts }}</span>
                  <span
                    v-if="w.lastResultStatus"
                    class="muted"
                  >成果 {{ statusLabel(w.lastResultStatus) }}</span>
                  <span
                    v-if="w.reworkCount"
                    class="badge red"
                  >rework {{ w.reworkCount }}</span>
                </div>
                <div
                  v-if="w.waitingReason"
                  class="wc-wait"
                >
                  {{ w.waitingOn }} · {{ w.waitingReason }}
                </div>
                <div
                  v-else-if="w.stateReason"
                  class="wc-wait"
                >
                  {{ w.stateReason }}
                </div>
                <div
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
                </div>
                <div
                  class="wc-actions"
                  @click.stop
                >
                  <button
                    v-if="w.stage === 'ready'"
                    class="btn tiny"
                    :disabled="loading || Boolean(w.currentAttempt?.id)"
                    @click="dispatch(w.id)"
                  >
                    派发
                  </button>
                  <button
                    v-if="['failed', 'canceled', 'completed_pending_result', 'result_rejected'].includes(w.stage)"
                    class="btn tiny ghost"
                    data-testid="btn-retry"
                    :disabled="loading"
                    @click="retryWorkItem(w.id)"
                  >
                    重试
                  </button>
                  <button
                    v-if="!['accepted', 'failed', 'canceled', 'superseded'].includes(w.stage)"
                    class="btn tiny danger"
                    :disabled="loading"
                    @click="cancelWorkItem(w.id)"
                  >
                    取消
                  </button>
                </div>
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
            <span>生成于 <b>{{ relTime(obs.generatedAt) }}</b></span>
          </div>
        </section>

        <!-- 权威表：工作项 / 派发（精确操作面） -->
        <section
          v-show="activeTab === 'plan'"
          class="card"
        >
          <header class="card-head">
            <h2>工作项 / 派发</h2>
            <span class="muted">{{ workItems.length }} 项</span>
          </header>
          <table class="table">
            <thead><tr><th>标题</th><th>频道</th><th>交付物</th><th>状态</th><th>预算</th><th class="col-actions" /></tr></thead>
            <tbody>
              <tr
                v-for="w in workItems"
                :key="w.id"
              >
                <td>
                  <button
                    class="link-strong"
                    @click="openWorkItem(w.id)"
                  >
                    {{ w.title }}
                  </button>
                  <div
                    v-if="w.stateReason"
                    class="muted"
                  >
                    {{ w.stateReason }}
                  </div>
                </td>
                <td>{{ channelNameOf(w.channelId) }}</td>
                <td>{{ deliverableName(w.deliverableId) }}</td>
                <td>
                  <span
                    class="badge"
                    :class="stageTone(obs?.workItems.find(x => x.id === w.id)?.stage ?? '')"
                  >{{ obs?.workItems.find(x => x.id === w.id)?.stage ? stageLabel(obs.workItems.find(x => x.id === w.id)!.stage) : w.state }}</span>
                </td>
                <td class="mono">
                  {{ w.execBudgetMinutes }}m
                </td>
                <td class="col-actions">
                  <button
                    v-if="w.state === 'DRAFT'"
                    class="btn tiny"
                    :disabled="loading || Boolean(w.currentAttemptId)"
                    @click="dispatch(w.id)"
                  >
                    派发
                  </button>
                  <button
                    v-if="canRetryRow(w)"
                    class="btn tiny ghost"
                    data-testid="btn-retry"
                    :disabled="loading"
                    @click="retryWorkItem(w.id)"
                  >
                    重试
                  </button>
                  <button
                    v-if="!['COMPLETED', 'CANCELED', 'SUPERSEDED'].includes(w.state)"
                    class="btn tiny danger"
                    :disabled="loading"
                    @click="cancelWorkItem(w.id)"
                  >
                    取消
                  </button>
                </td>
              </tr>
              <tr v-if="!workItems.length">
                <td
                  colspan="6"
                  class="muted"
                >
                  还没有工作项。在下方新增，或让 Project Leader 出计划后自动生成。
                </td>
              </tr>
            </tbody>
          </table>

          <div class="form-grid work-grid">
            <label>
              <span>交付物</span>
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
            </label>
            <label>
              <span>执行频道</span>
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
                  {{ bindingLabel(c) }}
                </option>
              </select>
            </label>
            <label>
              <span>工作项标题</span>
              <input
                v-model="workForm.title"
                data-testid="input-work-title"
                placeholder="例如：落地页视觉稿"
              >
            </label>
            <label>
              <span>给 Channel lead 的 brief</span>
              <input
                v-model="workForm.brief"
                data-testid="input-work-brief"
                placeholder="范围、约束、验收线索"
              >
            </label>
            <label>
              <span>执行预算（分钟）</span>
              <input
                v-model.number="workForm.execBudgetMinutes"
                type="number"
                min="1"
                max="1440"
              >
            </label>
            <div class="form-actions">
              <button
                class="btn"
                :disabled="loading"
                @click="createWorkItem"
              >
                新增工作项
              </button>
            </div>
          </div>
        </section>

        <!-- 路由与派发日志 -->
        <section
          v-show="activeTab === 'plan'"
          class="card"
          data-testid="route-log"
        >
          <header class="card-head">
            <h2>路由与派发日志</h2>
          </header>
          <div class="grid2">
            <div>
              <h3>派发 / 重试 / 返工 / 升级</h3>
              <p
                v-if="!dispatchLog.length"
                class="muted"
              >
                暂无派发记录。
              </p>
              <ul class="timeline">
                <li
                  v-for="e in dispatchLog"
                  :key="e.id"
                  class="timeline-row"
                >
                  <span
                    class="timeline-dot"
                    aria-hidden="true"
                  />
                  <span class="timeline-main">
                    <b>{{ eventLabel(e.type) }}</b>
                    <span class="mono">{{ e.traceId }}</span>
                  </span>
                  <span class="timeline-at">{{ relTime(e.createdAt) }}</span>
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
              <ul class="timeline">
                <li
                  v-for="d in routeDecisions"
                  :key="d.id"
                  class="timeline-row"
                >
                  <span
                    class="timeline-dot"
                    aria-hidden="true"
                  />
                  <span class="timeline-main">
                    <b>#{{ d.seq }} {{ d.decisionType }}</b>
                    <span class="badge">{{ d.state }}</span>
                    <span class="mono">{{ d.traceId }}</span>
                  </span>
                  <span class="timeline-at">{{ relTime(d.createdAt) }}</span>
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

        <!-- 计划快照 -->
        <section
          v-show="activeTab === 'plan'"
          class="card"
        >
          <header class="card-head">
            <h2>计划快照（当前 v{{ project?.planVersion ?? 0 }}）</h2>
          </header>
          <details
            class="plan-details"
            open
          >
            <summary>plan JSON</summary>
            <pre class="plan-json">{{ planJsonPretty }}</pre>
          </details>
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
            <li
              v-if="!planDecisions.length"
              class="muted"
            >
              暂无计划决策。
            </li>
          </ul>
        </section>

        <!-- ══ 交付物 ══ -->
        <section
          v-show="activeTab === 'deliverables'"
          class="card"
        >
          <header class="card-head">
            <h2>交付物</h2>
            <span class="muted">{{ deliverableCards.length }} 项 · 必选 {{ deliverableCards.filter(d => d.required).length }}</span>
          </header>
          <p
            v-if="!deliverableCards.length"
            class="muted"
          >
            至少一个必选交付物才能激活。可在下方新增。
          </p>
          <div class="deliv-grid">
            <article
              v-for="d in deliverableCards"
              :key="d.id"
              class="deliv"
              :class="{ done: d.businessApproved }"
            >
              <header class="deliv-head">
                <div class="deliv-title">
                  <strong>{{ d.name }}</strong>
                  <span class="mono">{{ d.id.slice(0, 8) }}</span>
                </div>
                <span
                  class="badge"
                  :class="d.status"
                >{{ statusLabel(d.status) }}</span>
                <span
                  v-if="d.required"
                  class="badge amber"
                >必选</span>
              </header>
              <div class="gates">
                <span
                  class="gate"
                  :class="{ on: d.contentReady }"
                >
                  <span
                    v-if="d.contentReady"
                    class="i-tabler-check"
                    aria-hidden="true"
                  />内容
                </span>
                <span
                  class="gate"
                  :class="{ on: d.technicalAccepted }"
                >
                  <span
                    v-if="d.technicalAccepted"
                    class="i-tabler-check"
                    aria-hidden="true"
                  />技术验收
                </span>
                <span
                  class="gate"
                  :class="{ on: d.businessApproved }"
                >
                  <span
                    v-if="d.businessApproved"
                    class="i-tabler-check"
                    aria-hidden="true"
                  />业务签核
                </span>
              </div>
              <div
                v-if="d.acceptanceCriteria.length"
                class="criteria"
              >
                <span
                  v-for="(c, i) in d.acceptanceCriteria"
                  :key="i"
                  class="criteria-item"
                >
                  <span
                    class="i-tabler-check"
                    aria-hidden="true"
                  />{{ c }}
                </span>
              </div>
              <div class="deliv-foot">
                <span class="muted">
                  {{ d.ownerChannelId ? channelNameOf(d.ownerChannelId) : '未指派频道' }}
                  · {{ d.resultCount }} 个成果
                </span>
                <button
                  v-if="d.status === 'planned'"
                  class="btn tiny ghost"
                  :disabled="loading"
                  @click="waiveDeliverable(d.id)"
                >
                  豁免
                </button>
              </div>
            </article>
          </div>

          <p
            v-if="project?.status === 'completed'"
            class="form-locked"
          >
            项目已完成：新增交付物入口已收起。如需追加，请用「继续开发」重新打开项目。
          </p>
          <div
            v-else
            class="form-grid deliv-grid-form"
          >
            <label>
              <span>交付物名称</span>
              <input
                v-model="deliverableForm.name"
                data-testid="deliverable-name"
                placeholder="例如：落地页设计稿"
              >
            </label>
            <label>
              <span>所属频道</span>
              <select v-model="deliverableForm.ownerChannelId">
                <option value="">
                  选择所属频道
                </option>
                <option
                  v-for="c in channels"
                  :key="c.channelId"
                  :value="c.channelId"
                >
                  {{ bindingLabel(c) }}
                </option>
              </select>
            </label>
            <label class="span2">
              <span>验收标准（每行一条）</span>
              <textarea
                v-model="deliverableForm.acceptance"
                rows="2"
                placeholder="例如：首屏 3 秒内可读&#10;移动端 390px 无横向滚动"
              />
            </label>
            <div class="span2 form-actions">
              <button
                class="btn"
                :disabled="loading"
                @click="createDeliverable"
              >
                新增交付物
              </button>
            </div>
          </div>
        </section>

        <!-- 成果按交付物分组 -->
        <section
          v-show="activeTab === 'deliverables'"
          class="card"
        >
          <header class="card-head">
            <h2>成果（按交付物分组）</h2>
            <span class="muted">{{ results.length }} 个成果</span>
          </header>
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
              >{{ statusLabel(group.deliverable.status) }}</span>
              <button
                v-if="group.deliverable.status === 'planned'"
                class="btn tiny ghost"
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
                >{{ statusLabel(r.status) }}</span>
                <span class="muted mono">v{{ r.version }}</span>
              </div>
              <p class="summary">
                {{ r.summary }}
              </p>
              <details class="evidence">
                <summary>evidence · {{ r.evidenceJson?.slice(0, 60) ?? '—' }}</summary>
                <pre>{{ prettyJson(r.evidenceJson) }}</pre>
              </details>
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

        <!-- ══ 审批 ══ -->
        <section
          v-show="activeTab === 'approvals'"
          class="card"
        >
          <header class="card-head">
            <h2>待审批</h2>
            <span class="muted">{{ pendingApprovals.length }} 项待决定</span>
          </header>
          <p
            v-if="!pendingApprovals.length"
            class="muted"
          >
            无待审批。
          </p>
          <div class="approval-grid">
            <article
              v-for="a in pendingApprovals"
              :key="a.id"
              class="approval"
            >
              <header class="approval-head">
                <span class="badge amber">{{ approvalKind(a.kind) }}</span>
                <span class="mono muted">{{ a.subjectId.slice(0, 8) }}</span>
                <span
                  v-if="a.expiresAt"
                  class="muted expiry"
                >到期 {{ relTime(a.expiresAt) }}</span>
              </header>
              <pre
                v-if="approvalPayload(a)"
                class="approval-payload"
              >{{ approvalPayload(a) }}</pre>
              <div class="row actions">
                <button
                  class="btn small"
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
            </article>
          </div>
        </section>

        <section
          v-show="activeTab === 'approvals'"
          class="card"
        >
          <header class="card-head">
            <h2>审批历史</h2>
            <span class="muted">{{ approvalHistory.length }} 条</span>
          </header>
          <p
            v-if="!approvalHistory.length"
            class="muted"
          >
            暂无审批记录。
          </p>
          <ul class="ap-list">
            <li
              v-for="h in approvalHistory.slice(0, 50)"
              :key="h.id"
              class="ap-item"
              :title="`#${h.id} · ${h.subjectId}`"
            >
              <div class="ap-row1">
                <span class="badge gray">{{ approvalKind(h.kind) }}</span>
                <span
                  class="badge"
                  :class="h.status"
                >{{ statusLabel(h.status) }}</span>
                <span class="ap-when muted">{{ relTime(h.createdAt ?? h.expiresAt) }}</span>
              </div>
              <p
                v-if="approvalSummaryOf(h)"
                class="ap-summary"
              >
                {{ approvalSummaryOf(h) }}
              </p>
              <p
                v-else
                class="ap-summary muted"
              >
                {{ approvalReason(h) }}
              </p>
            </li>
          </ul>
        </section>

        <!-- ══ 决策与事件（统一活动流） ══ -->
        <section
          v-show="activeTab === 'events'"
          class="card"
        >
          <header class="card-head">
            <h2>决策与事件</h2>
            <span class="muted">{{ activity.length }} 条 · events + decisions 统一时间线</span>
            <span class="spacer" />
            <button
              class="btn small ghost"
              :disabled="activityLoading"
              @click="loadActivity(true)"
            >
              刷新
            </button>
          </header>
          <p
            v-if="!activity.length && !activityLoading"
            class="muted"
          >
            暂无活动记录。
          </p>
          <ul class="timeline activity">
            <li
              v-for="item in activity"
              :key="`${item.kind}-${item.id}`"
              class="timeline-row"
            >
              <span
                class="timeline-dot"
                :class="item.kind"
                aria-hidden="true"
              />
              <div class="timeline-main">
                <div class="timeline-line">
                  <b>{{ eventLabel(item.type) }}</b>
                  <span class="badge gray mono">{{ item.kind }}</span>
                  <span
                    v-if="item.state"
                    class="badge"
                  >{{ item.state }}</span>
                  <button
                    v-if="item.kind === 'decision' && item.type === 'dispatch.proposed' && item.state === 'proposed'"
                    class="btn tiny green"
                    :disabled="loading"
                    @click="applyProposal(item.id)"
                  >
                    应用提案
                  </button>
                  <span class="timeline-at">{{ relTime(item.at) }}</span>
                </div>
                <div class="timeline-sub">
                  <span
                    v-if="item.channelId"
                    class="mono"
                  >{{ channelNameOf(item.channelId) }}</span>
                  <span
                    v-if="item.workItemId"
                    class="mono"
                  >work {{ item.workItemId.slice(0, 8) }}</span>
                  <span
                    v-if="item.reason"
                    class="muted"
                  >{{ item.reason }}</span>
                  <span
                    v-if="item.traceId"
                    class="mono faint"
                  >trace {{ item.traceId.slice(0, 10) }}</span>
                </div>
                <details
                  v-if="item.payload && Object.keys(item.payload).length"
                  class="payload"
                >
                  <summary>payload</summary>
                  <pre>{{ JSON.stringify(item.payload, null, 2) }}</pre>
                </details>
              </div>
            </li>
          </ul>
          <div class="row actions">
            <button
              v-if="activityHasMore"
              class="btn small ghost"
              :disabled="activityLoading"
              @click="loadActivity(false)"
            >
              {{ activityLoading ? '加载中…' : '加载更多' }}
            </button>
            <span
              v-else-if="activity.length"
              class="muted"
            >已经到底了</span>
          </div>
        </section>

        <!-- 执行链抽屉 -->
        <div
          v-if="selectedWorkItemId"
          class="drawer-mask"
          @click.self="closeDrawer"
        >
          <aside
            class="drawer"
            data-testid="exec-drawer"
          >
            <header class="drawer-head">
              <h2>执行链</h2>
              <span class="muted mono">{{ selectedWorkItemId.slice(0, 8) }}…</span>
              <span class="spacer" />
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
                <span class="muted mono">{{ channelNameOf(detail.workItem.channelId) }}</span>
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
              <p
                v-if="detail.workItem.brief"
                class="drawer-brief"
              >
                {{ detail.workItem.brief }}
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
                  <span class="muted">{{ relTime(a.createdAt) }}</span>
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
                  >{{ statusLabel(r.status) }}</span>
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
                  <span>{{ eventLabel(e.type) }}</span>
                  <span class="muted">{{ relTime(e.at) }}</span>
                </li>
              </ul>
            </template>
          </aside>
        </div>
      </template>
    </div>

    <!-- ══ 右区：上下文（≥1200px 常驻；纯附加信息） ══ -->
    <aside
      v-if="obs"
      class="ctx"
    >
      <div class="ctx-card">
        <div class="ctx-head">
          项目快照
          <span class="badge mono">{{ obs.project.routingPolicy }}</span>
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
            <b>{{ projectProgress }}%</b>
          </div>
          <div class="ctx-bar">
            <i :style="{ width: `${projectProgress}%` }" />
          </div>
          <div class="ctx-progress-row">
            <span>交付物签核</span>
            <b>{{ acceptanceProgress }}%</b>
          </div>
          <div class="ctx-bar">
            <i :style="{ width: `${acceptanceProgress}%` }" />
          </div>
        </div>
        <div class="ctx-foot">
          <span>plan v{{ obs.project.planVersion }}</span>
          <span>ledger {{ obs.kernel.ledger.count }}</span>
          <span>{{ relTime(obs.generatedAt) }}</span>
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
          <p
            v-if="!lane.items.length"
            class="ctx-empty"
          >
            无工作项
          </p>
        </div>
      </div>

      <div class="ctx-card">
        <div class="ctx-head">
          成员
          <span class="badge gray">{{ members.length }}</span>
        </div>
        <div class="member-row">
          <span class="member-avatar">OW</span>
          <div class="member-main">
            <strong>owner</strong>
            <span class="mono">{{ project?.ownerUserId?.slice(0, 8) }}</span>
          </div>
        </div>
        <div
          v-for="m in members"
          :key="m.userId"
          class="member-row"
        >
          <span class="member-avatar gray">{{ m.role.slice(0, 2).toUpperCase() }}</span>
          <div class="member-main">
            <strong>{{ m.role }}</strong>
            <span class="mono">{{ m.userId.slice(0, 8) }}</span>
          </div>
        </div>
        <p
          v-if="!members.length"
          class="ctx-empty"
        >
          仅 owner（成员可读，审批权可由 approver 持有）
        </p>
      </div>

      <div class="ctx-card">
        <div class="ctx-head">
          项目健康
          <span class="badge gray mono">kernel</span>
        </div>
        <div
          v-for="h in obs.kernel.health"
          :key="String(h.component)"
          class="health-row"
        >
          <span
            class="health-dot"
            :class="h.status === 'ok' ? 'ok' : 'bad'"
            aria-hidden="true"
          />
          <span class="health-name">{{ h.component }}</span>
          <span class="health-status mono">{{ h.status }}</span>
        </div>
        <p
          v-if="!obs.kernel.health.length"
          class="ctx-empty"
        >
          暂无心跳（项目激活后内核组件会写入）
        </p>
        <div
          v-if="obs.kernel.effects && Object.keys(obs.kernel.effects).length"
          class="ctx-effects"
        >
          <span
            v-for="(n, k) in obs.kernel.effects"
            :key="k"
            class="effect-chip"
          >{{ k }} {{ n }}</span>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* ═══ 三区应用框（令牌 = --chat-* 家族） ═══ */
.page {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  color: var(--chat-ink);
  background: var(--chat-canvas);
}

/* 共享：按钮 */
.btn {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 7px 13px;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--chat-canvas);
  cursor: pointer;
  background: var(--chat-ink);
  border: 1px solid transparent;
  border-radius: 9px;
  transition: opacity var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}
.btn:hover { opacity: 0.9; }
.btn:disabled { cursor: not-allowed; opacity: 0.45; }
.btn.small { min-height: 30px; padding: 5px 10px; font-size: 12px; }
.btn.tiny { min-height: 26px; padding: 3px 8px; font-size: 11.5px; border-radius: 7px; }
.btn.ghost {
  color: var(--chat-ink);
  background: transparent;
  border-color: var(--chat-line-strong);
}
.btn.ghost:hover { background: var(--chat-surface-raised); opacity: 1; }
.btn.danger {
  color: var(--tone-danger-dot);
  background: transparent;
  border-color: color-mix(in srgb, var(--tone-danger-dot) 35%, transparent);
}
.btn.danger:hover { background: var(--tone-danger-bg); opacity: 1; }
.btn.green {
  color: var(--tone-success-dot);
  background: var(--tone-success-bg);
  border-color: transparent;
}
.btn.green:hover { background: color-mix(in srgb, var(--tone-success-dot) 18%, var(--tone-success-bg)); opacity: 1; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ═══ 左区 ═══ */
.side {
  display: flex;
  flex: 0 0 252px;
  flex-direction: column;
  min-height: 0;
  padding: 14px 12px 10px;
  overflow-y: auto;
  background: var(--chat-surface-raised);
  border-right: 1px solid var(--chat-line);
}
.side-head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 2px 4px 14px;
}
.back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  font-size: 15px;
  color: var(--chat-ink-soft);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--chat-line);
  border-radius: 8px;
}
.back:hover { color: var(--chat-ink); border-color: var(--chat-line-strong); }
.brand {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  padding: 0;
  font-family: inherit;
  font-size: 13px;
  font-weight: 650;
  color: var(--chat-ink);
  cursor: pointer;
  background: transparent;
  border: 0;
}
.brand:hover { opacity: .8; }
.brand-dot {
  width: 9px;
  height: 9px;
  background: var(--chat-accent);
  border-radius: 3px;
}
.side-version {
  font-family: var(--font-mono, monospace);
  font-size: 9.5px;
  color: var(--chat-ink-faint);
  letter-spacing: .08em;
  text-transform: uppercase;
}

.proj-id { padding: 4px 6px 14px; }
.proj-name {
  overflow: hidden;
  font-size: 16px;
  font-weight: 650;
  color: var(--chat-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.01em;
}
.proj-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.proj-obj {
  display: -webkit-box;
  margin: 9px 0 0;
  overflow: hidden;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--chat-ink-faint);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.side-nav { display: flex; flex-direction: column; gap: 2px; }
.side-label {
  padding: 10px 8px 6px;
  font-family: var(--font-mono, monospace);
  font-size: 9.5px;
  color: var(--chat-ink-faint);
  letter-spacing: .1em;
  text-transform: uppercase;
}
.side-item {
  display: flex;
  gap: 9px;
  align-items: center;
  width: 100%;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--chat-ink-soft);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 9px;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.side-item span[class^='i-tabler'] { font-size: 15px; color: var(--chat-ink-faint); }
.side-item:hover { color: var(--chat-ink); background: color-mix(in srgb, var(--chat-ink) 4%, transparent); }
.side-item.active {
  font-weight: 600;
  color: var(--chat-ink);
  background: color-mix(in srgb, var(--chat-ink) 7%, transparent);
}
.side-item.active span[class^='i-tabler'] { color: var(--chat-accent); }
.side-item-label { flex: 1 1 auto; }
.side-count {
  min-width: 18px;
  padding: 0 5px;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  line-height: 16px;
  color: var(--chat-ink-faint);
  text-align: center;
  background: color-mix(in srgb, var(--chat-ink) 6%, transparent);
  border-radius: 999px;
}
.side-count.alert { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }

.side-life { padding-top: 6px; }
.life-grid { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 4px; }
.side-foot {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 8px 2px;
  margin-top: auto;
  border-top: 1px solid var(--chat-line);
}
.side-meta { font-size: 10.5px; color: var(--chat-ink-faint); }

/* ═══ 中区 ═══ */
.main-col {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  min-height: 0;
  padding: 18px 24px 36px;
  overflow-y: auto;
}
.top {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--chat-line);
}
.crumb { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.crumb-link {
  padding: 0;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--chat-ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
}
.crumb-link:hover { color: var(--chat-ink); text-decoration: underline; text-underline-offset: 3px; }
.crumb-sep { color: var(--chat-ink-faint); }
.crumb h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
  color: var(--chat-ink);
  letter-spacing: -0.015em;
}
.top-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.live-pill {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 4px 9px;
  font-size: 10.5px;
  color: var(--chat-ink-faint);
  background: var(--chat-surface-raised);
  border-radius: 999px;
}
.live-pill i {
  width: 6px;
  height: 6px;
  background: var(--tone-neutral-dot);
  border-radius: 50%;
}
.live-pill.on i { background: var(--tone-success-dot); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone-success-dot) 18%, transparent); }
.live-pill.loading i { animation: live-pulse 1s ease-in-out infinite; }
@keyframes live-pulse {
  50% { opacity: .35; }
}

.error {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 9px 12px;
  margin: 0;
  font-size: 12.5px;
  color: var(--tone-danger-dot);
  background: var(--tone-danger-bg);
  border-radius: 9px;
}
.error.inline { margin-top: 8px; }

/* 卡片 */
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: 14px;
}
.card-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.card-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--chat-ink);
  letter-spacing: -0.01em;
}
.card-head .muted { font-size: 11.5px; }
.spacer { flex: 1 1 auto; }
h3 { margin: 4px 0 0; font-size: 12.5px; font-weight: 650; color: var(--chat-ink-soft); }
h4 { margin: 14px 0 6px; font-size: 12px; font-weight: 650; color: var(--chat-ink-soft); }
.muted { color: var(--chat-ink-faint); font-size: 12px; }
.mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.faint { opacity: .7; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 徽标 */
.badge {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 2px 8px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 16px;
  color: var(--chat-ink-soft);
  white-space: nowrap;
  background: color-mix(in srgb, var(--chat-ink) 6%, transparent);
  border-radius: 999px;
}
.badge.mono { font-family: var(--font-mono, monospace); font-weight: 500; }
.badge.gray { color: var(--chat-ink-faint); }
.badge.blue { color: var(--tone-info-dot); background: var(--tone-info-bg); }
.badge.green, .badge.active, .badge.approved { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.badge.amber, .badge.draft, .badge.paused, .badge.pending, .badge.planned, .badge.submitted, .badge.reviewed { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.badge.red, .badge.blocked, .badge.failed, .badge.rejected { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.badge.completed { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.badge.archived, .badge.waived, .badge.superseded, .badge.canceled { color: var(--chat-ink-faint); }
.badge.protected { color: var(--tone-info-dot); background: var(--tone-info-bg); }

/* Hero */
.hero {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  align-items: center;
  padding: 16px 20px;
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: 16px;
}
.hero-ring { position: relative; flex: 0 0 auto; width: 76px; height: 76px; }
.hero-ring svg { width: 76px; height: 76px; transform: rotate(-90deg); }
.ring-bg { fill: none; stroke: var(--chat-line); stroke-width: 4; }
.ring-fg {
  fill: none;
  /* 完成度是“正常/已完成”语义,不是品牌的强调橙 */
  stroke: var(--tone-success-dot);
  stroke-linecap: round;
  stroke-width: 4;
  transition: stroke-dasharray var(--transition-base);
}
.ring-label {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  align-items: center;
  justify-content: center;
}
.ring-label b { font-family: var(--font-mono, monospace); font-size: 16px; font-weight: 650; color: var(--chat-ink); }
.ring-label span { font-size: 9px; color: var(--chat-ink-faint); }
.hero-stats { display: flex; flex: 1 1 auto; flex-wrap: wrap; gap: 8px 26px; }
.hero-stat { display: flex; flex-direction: column; gap: 1px; }
.hero-stat b {
  font-family: var(--font-mono, monospace);
  font-size: 20px;
  font-weight: 600;
  color: var(--chat-ink);
  letter-spacing: -0.02em;
}
.hero-stat span { font-size: 10.5px; color: var(--chat-ink-faint); }
.hero-stat.danger b { color: var(--tone-danger-dot); }
.hero-criteria {
  display: flex;
  flex-basis: 100%;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding-top: 10px;
  border-top: 1px solid var(--chat-line);
}
.hero-criteria-label {
  font-family: var(--font-mono, monospace);
  font-size: 9.5px;
  color: var(--chat-ink-faint);
  letter-spacing: .08em;
  text-transform: uppercase;
}
.criteria-chip {
  padding: 3px 9px;
  font-size: 11px;
  color: var(--chat-ink-soft);
  background: var(--chat-surface-raised);
  border-radius: 7px;
}

/* 对话 */
.chat-card { gap: 10px; }
.chat-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
.leader-id { display: flex; gap: 10px; align-items: center; }
.leader-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-weight: 700;
  color: var(--chat-canvas);
  background: var(--chat-ink);
  border-radius: 9px;
}
.leader-copy h2 { margin: 0; font-size: 13.5px; font-weight: 650; }
.leader-copy p { margin: 1px 0 0; font-size: 11px; color: var(--chat-ink-faint); }
.leader-copy code { font-family: var(--font-mono, monospace); }
.chat-head-actions { display: flex; gap: 10px; align-items: center; }
.chat-hint {
  padding: 8px 11px;
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--chat-ink-soft);
  background: var(--chat-surface-raised);
  border-radius: 9px;
}
.chat-thread {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 340px;
  padding: 4px 2px;
  overflow-y: auto;
}
.chat-empty {
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: center;
  padding: 26px 12px;
  font-size: 11.5px;
  color: var(--chat-ink-faint);
  border: 1px dashed var(--chat-line-strong);
  border-radius: 10px;
}
.chat-empty strong { font-size: 12.5px; color: var(--chat-ink-soft); }
.chat-row { display: flex; gap: 8px; align-items: flex-start; }
.chat-row.user { flex-direction: row-reverse; }
.chat-avatar {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  font-weight: 700;
  color: var(--chat-ink-soft);
  background: var(--chat-surface-raised);
  border: 1px solid var(--chat-line);
  border-radius: 7px;
}
.chat-bubble-wrap { display: flex; flex-direction: column; gap: 3px; max-width: min(78%, 680px); }
.chat-row.user .chat-bubble-wrap { align-items: flex-end; }
.chat-meta { display: flex; gap: 7px; align-items: baseline; font-size: 10.5px; color: var(--chat-ink-faint); }
.chat-meta strong { font-size: 11px; color: var(--chat-ink-soft); }
.chat-body {
  padding: 9px 12px;
  font-size: 12.5px;
  line-height: 1.62;
  color: var(--chat-ink);
  word-break: break-word;
  white-space: pre-wrap;
  background: var(--chat-surface-raised);
  border-radius: 12px;
}
.chat-row.user .chat-body { color: var(--chat-user-ink); background: var(--chat-user-bubble); }
.chat-body :deep(p) { margin: 0 0 6px; }
.chat-body :deep(p:last-child) { margin-bottom: 0; }
.chat-body :deep(code) {
  padding: 1px 4px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  background: color-mix(in srgb, var(--chat-ink) 7%, transparent);
  border-radius: 4px;
}
.chat-compose { display: flex; flex-direction: column; gap: 6px; }
.chat-compose textarea {
  width: 100%;
  padding: 9px 11px;
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--chat-ink);
  resize: vertical;
  background: var(--chat-canvas);
  border: 1px solid var(--chat-line-strong);
  border-radius: 10px;
  outline: none;
}
.chat-compose textarea:focus { border-color: var(--chat-ink-faint); }
.chat-compose textarea:disabled { background: var(--chat-surface-raised); }
.chat-compose-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.composer-hint { font-size: 10.5px; color: var(--chat-ink-faint); }
.composer-right { display: flex; gap: 10px; align-items: center; }

/* 频道 */
.chan-list { display: flex; flex-direction: column; gap: 6px; padding: 0; margin: 0; list-style: none; }
.chan-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 9px 11px;
  background: var(--chat-surface-raised);
  border-radius: 10px;
}
.chan-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  font-size: 14px;
  color: var(--chat-ink-soft);
  background: var(--chat-canvas);
  border: 1px solid var(--chat-line);
  border-radius: 8px;
}
.chan-main { display: flex; flex-direction: column; gap: 1px; min-width: 140px; }
.chan-main strong { font-size: 12.5px; color: var(--chat-ink); }
.chan-meta { font-size: 10px; color: var(--chat-ink-faint); }
.chan-charter {
  flex: 1 1 160px;
  min-width: 0;
  overflow: hidden;
  font-size: 11px;
  color: var(--chat-ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 表单 */
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.form-grid .span2 { grid-column: 1 / -1; }
.form-grid label { display: flex; flex-direction: column; gap: 5px; font-size: 11px; color: var(--chat-ink-faint); }
.form-grid input, .form-grid select, .form-grid textarea {
  width: 100%;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--chat-ink);
  background: var(--chat-canvas);
  border: 1px solid var(--chat-line);
  border-radius: 9px;
  outline: none;
  transition: border-color var(--transition-fast);
}
.form-grid input:focus, .form-grid select:focus, .form-grid textarea:focus { border-color: var(--chat-ink-faint); }
.form-grid textarea { resize: vertical; }
.form-actions { display: flex; align-items: flex-end; }
.bind-grid { padding-top: 10px; border-top: 1px solid var(--chat-line); }
.work-grid, .deliv-grid-form { padding-top: 12px; border-top: 1px solid var(--chat-line); }
.check-row { flex-direction: row !important; gap: 7px !important; align-items: center; font-size: 11.5px !important; color: var(--chat-ink-soft) !important; }
.check-row input { width: auto; }
.inline-check { display: inline-flex; gap: 5px; align-items: center; font-size: 11.5px; }
.inline-check input { width: auto; }

/* 双列 */
.two-col { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr); gap: 14px; }
.two-col > * { min-width: 0; }
.session-list { display: flex; flex-direction: column; gap: 5px; padding: 0; margin: 0; list-style: none; }
.session-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 7px 9px;
  font-size: 12px;
  background: var(--chat-surface-raised);
  border-radius: 9px;
}
.session-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 1px; min-width: 0; }
.session-main strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.session-main .muted { overflow: hidden; font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.report-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.report-stat {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px 10px;
  background: var(--chat-surface-raised);
  border-radius: 9px;
}
.report-stat b { font-family: var(--font-mono, monospace); font-size: 15px; color: var(--chat-ink); }
.report-stat span { font-size: 10px; color: var(--chat-ink-faint); }
.tone-warn { color: var(--tone-warning-dot) !important; }
.report-line { margin: 0; font-size: 10.5px; }
.row.actions { display: flex; gap: 8px; align-items: center; }

/* 执行看板 */
.stat-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  padding: 9px 12px;
  font-size: 11.5px;
  color: var(--chat-ink-faint);
  background: var(--chat-surface-raised);
  border-radius: 9px;
}
.stat b { font-family: var(--font-mono, monospace); font-size: 13px; color: var(--chat-ink); }
.live-dot { width: 7px; height: 7px; background: var(--chat-ink-faint); border-radius: 50%; }
.live-dot.on { background: var(--tone-success-dot); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone-success-dot) 16%, transparent); }

.board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
  align-items: start;
}
.board.empty { display: none; }
/* 最后列（完成/验收链）在换行时占满剩余宽度：避免 3+2 布局留下空洞列 */
.board-col:last-child { grid-column: span 2; }
.board-col {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-height: 90px;
  padding: 9px;
  background: var(--chat-surface-raised);
  border-radius: 11px;
  border-top: 2px solid var(--chat-line-strong);
}
.board-col.tone-blue { border-top-color: var(--tone-info-dot); }
.board-col.tone-green { border-top-color: var(--tone-success-dot); }
.board-col.tone-amber { border-top-color: var(--tone-warning-dot); }
.board-col.tone-red { border-top-color: var(--tone-danger-dot); }
.board-col.tone-gray { border-top-color: var(--chat-ink-faint); }
.board-col-head { display: flex; gap: 6px; align-items: center; font-size: 11px; color: var(--chat-ink-soft); }
.board-col-head span[class^='i-tabler'] { font-size: 13px; color: var(--chat-ink-faint); }
.board-col-label { flex: 1 1 auto; font-weight: 600; }
.board-col-count {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--chat-ink-faint);
}
.board-empty { margin: 0; padding: 8px 2px; font-size: 10.5px; color: var(--chat-ink-faint); }

.wc {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 10px;
  cursor: pointer;
  background: var(--chat-canvas);
  border: 1px solid var(--chat-line);
  border-radius: 9px;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.wc:hover { border-color: var(--chat-line-strong); box-shadow: 0 6px 16px rgb(12 10 9 / 6%); }
.wc:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: 1px; }
.wc-top { display: flex; gap: 6px; align-items: flex-start; justify-content: space-between; }
.wc-top strong { font-size: 12px; font-weight: 600; line-height: 1.35; color: var(--chat-ink); }
.wc-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; font-size: 10.5px; color: var(--chat-ink-faint); }
.wc-chan { display: inline-flex; gap: 4px; align-items: center; }
.wc-chan span[class^='i-tabler'] { font-size: 11px; }
.wc-deliv { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-foot { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; font-size: 10px; color: var(--chat-ink-faint); }
.wc-wait {
  padding: 4px 6px;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--tone-warning-dot);
  background: var(--tone-warning-bg);
  border-radius: 6px;
}
.task-session-row { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-size: 10px; }
.wc-actions { display: flex; flex-wrap: wrap; gap: 5px; }

.route-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  padding: 8px 12px;
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  color: var(--chat-ink-faint);
  background: var(--chat-surface-raised);
  border-radius: 9px;
}
.route-strip b { color: var(--chat-ink-soft); }

/* 表格 */
.table { width: 100%; font-size: 12px; border-collapse: collapse; }
.table th {
  padding: 7px 8px;
  font-size: 10px;
  font-weight: 600;
  color: var(--chat-ink-faint);
  text-align: left;
  letter-spacing: .04em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--chat-line);
}
.table td { padding: 8px; color: var(--chat-ink-soft); vertical-align: top; border-bottom: 1px solid var(--chat-line); }
.table tr:last-child td { border-bottom: 0; }
.col-actions { text-align: right; }
.col-actions .btn + .btn { margin-left: 4px; }
.link-strong {
  padding: 0;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--chat-ink);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
}
.link-strong:hover { text-decoration: underline; text-underline-offset: 3px; }

/* 时间线 */
.timeline { display: flex; flex-direction: column; gap: 0; padding: 0; margin: 0; list-style: none; }
.timeline-row {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  padding: 7px 0;
  border-bottom: 1px solid var(--chat-line);
}
.timeline-row:last-child { border-bottom: 0; }
.timeline-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  margin-top: 5px;
  background: var(--chat-ink-faint);
  border-radius: 50%;
}
.timeline-dot.decision { background: var(--tone-info-dot); }
.timeline-dot.event { background: var(--chat-ink-faint); }
.timeline-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 2px; min-width: 0; }
.timeline-line { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; }
.timeline-line b { font-weight: 600; color: var(--chat-ink); }
.timeline-at { margin-left: auto; font-size: 10px; color: var(--chat-ink-faint); }
.timeline-sub { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 10px; color: var(--chat-ink-faint); }
.payload summary, .evidence summary {
  font-size: 10.5px;
  color: var(--chat-ink-faint);
  cursor: pointer;
}
.payload pre, .evidence pre {
  max-height: 220px;
  padding: 8px 10px;
  margin: 4px 0 0;
  overflow: auto;
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--chat-ink-soft);
  background: var(--chat-surface-raised);
  border-radius: 8px;
}

/* 交付物 */
.deliv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
.deliv {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--chat-surface-raised);
  border: 1px solid var(--chat-line);
  border-radius: 11px;
}
.deliv.done { border-color: color-mix(in srgb, var(--tone-success-dot) 30%, var(--chat-line)); }
.deliv-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.deliv-title { display: flex; flex: 1 1 auto; flex-direction: column; gap: 1px; min-width: 0; }
.deliv-title strong { font-size: 12.5px; color: var(--chat-ink); }
.deliv-title span { font-size: 9.5px; color: var(--chat-ink-faint); }
.gates { display: flex; gap: 6px; }
.gate {
  display: inline-flex;
  flex: 1 1 0;
  gap: 4px;
  align-items: center;
  justify-content: center;
  padding: 4px 0;
  font-size: 10px;
  color: var(--chat-ink-faint);
  text-align: center;
  background: var(--chat-canvas);
  border: 1px dashed var(--chat-line-strong);
  border-radius: 6px;
}
.gate span[class^='i-tabler'] { font-size: 10px; }
.gate.on {
  color: var(--tone-success-dot);
  font-weight: 600;
  background: var(--tone-success-bg);
  border: 1px solid transparent;
}
.criteria { display: flex; flex-direction: column; gap: 3px; }
.criteria-item {
  display: flex;
  gap: 5px;
  align-items: flex-start;
  font-size: 11px;
  line-height: 1.45;
  color: var(--chat-ink-soft);
}
.criteria-item span[class^='i-tabler'] { flex: 0 0 auto; margin-top: 2px; font-size: 11px; color: var(--tone-success-dot); }
.deliv-foot { display: flex; gap: 8px; align-items: center; justify-content: space-between; }

/* 成果 */
.group-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px 0 0;
  margin-top: 4px;
  border-top: 1px solid var(--chat-line);
}
.group-head strong { font-size: 12.5px; color: var(--chat-ink); }
.result {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 11px 12px;
  background: var(--chat-surface-raised);
  border-radius: 10px;
}
.result-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.result-head strong { font-size: 12.5px; color: var(--chat-ink); }
.summary { margin: 0; font-size: 12px; line-height: 1.55; color: var(--chat-ink-soft); white-space: pre-wrap; }

/* 审批 */
.approval-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; }
.approval {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--chat-surface-raised);
  border: 1px solid var(--chat-line);
  border-radius: 11px;
}
.approval-head { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
.approval-head .expiry { margin-left: auto; font-size: 10px; }
.approval-payload {
  max-height: 180px;
  padding: 8px 10px;
  margin: 0;
  overflow: auto;
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--chat-ink-soft);
  background: var(--chat-canvas);
  border-radius: 8px;
}

/* 列表 / 等待箱 */
.list { display: flex; flex-direction: column; gap: 5px; padding: 0; margin: 0; list-style: none; }
.list li {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 7px 9px;
  font-size: 12px;
  background: var(--chat-surface-raised);
  border-radius: 8px;
}
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.form-locked {
  padding: 9px 12px;
  margin: 8px 0 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--chat-ink-faint);
  background: var(--chat-surface-raised);
  border: 1px dashed var(--chat-line);
  border-radius: 8px;
}
.ap-payload { flex: 1 1 200px; min-width: 0; }
.ap-time { flex: 0 0 auto; margin-left: auto; }

/* 审批历史:两行卡(类型/状态/时间 + 人话摘要),不再渲染原始 JSON */
.ap-list { display: flex; flex-direction: column; gap: 6px; padding: 0; margin: 0; list-style: none; }
.ap-item {
  padding: 9px 11px;
  background: var(--chat-surface-raised);
  border: 1px solid var(--chat-line);
  border-radius: 9px;
}
.ap-row1 { display: flex; gap: 8px; align-items: center; }
.ap-when { margin-left: auto; font-size: 11px; }
.ap-summary {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--chat-ink);
  overflow-wrap: anywhere;
}
.waiting-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--tone-warning-bg) 55%, transparent);
  border-radius: 10px;
}

/* 计划 */
.plan-details summary {
  font-size: 11px;
  color: var(--chat-ink-faint);
  cursor: pointer;
}
.plan-json {
  max-height: 320px;
  padding: 10px 12px;
  margin: 6px 0 0;
  overflow: auto;
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--chat-ink-soft);
  background: var(--chat-surface-raised);
  border-radius: 9px;
}

/* 骨架 */
.skeleton-wrap { display: flex; flex-direction: column; gap: 14px; }
.sk-hero, .sk-card {
  background: linear-gradient(90deg, var(--chat-surface-raised) 25%, var(--chat-line) 50%, var(--chat-surface-raised) 75%);
  background-size: 200% 100%;
  border-radius: 14px;
  animation: shimmer 1.4s ease-in-out infinite;
}
.sk-hero { height: 110px; }
.sk-card { height: 220px; }
.sk-card.short { height: 140px; }
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* 抽屉 */
.drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  justify-content: flex-end;
  background: rgb(12 10 9 / 24%);
  backdrop-filter: blur(2px);
}
.drawer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(520px, 92vw);
  height: 100%;
  padding: 18px 20px 40px;
  overflow-y: auto;
  background: var(--chat-canvas);
  border-left: 1px solid var(--chat-line);
  box-shadow: var(--chat-shadow);
}
.drawer-head { display: flex; gap: 10px; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--chat-line); }
.drawer-head h2 { margin: 0; font-size: 15px; font-weight: 650; }
.drawer-brief {
  padding: 8px 10px;
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--chat-ink-soft);
  white-space: pre-wrap;
  background: var(--chat-surface-raised);
  border-radius: 8px;
}
.attempt {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 12px;
  margin-bottom: 8px;
  background: var(--chat-surface-raised);
  border-radius: 9px;
}
.attempt code { font-family: var(--font-mono, monospace); font-size: 10.5px; }
.artifact-list { display: flex; flex-direction: column; gap: 3px; padding: 0; margin: 2px 0; list-style: none; }
.artifact-list li { display: flex; gap: 8px; font-size: 11px; }
.artifact-list code { font-family: var(--font-mono, monospace); }
.workers { display: flex; flex-direction: column; gap: 4px; padding-top: 4px; }
.worker {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 5px 8px;
  font-size: 11px;
  background: var(--chat-canvas);
  border-radius: 7px;
}

/* ═══ 右区 ═══ */
.ctx {
  display: flex;
  flex: 0 0 300px;
  flex-direction: column;
  gap: 10px;
  padding: 18px 16px 32px;
  overflow-y: auto;
  background: var(--chat-surface-raised);
  border-left: 1px solid var(--chat-line);
}
.ctx-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: 11px;
}
.ctx-head { display: flex; gap: 8px; align-items: center; font-size: 11.5px; font-weight: 650; color: var(--chat-ink-soft); }
.ctx-head > :last-child { margin-left: auto; }
.ctx-lane-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.ctx-stat { display: flex; flex-direction: column; gap: 1px; }
.ctx-stat b { font-family: var(--font-mono, monospace); font-size: 15px; color: var(--chat-ink); }
.ctx-stat span { font-size: 9.5px; color: var(--chat-ink-faint); }
.ctx-progress { display: flex; flex-direction: column; gap: 4px; }
.ctx-progress-row { display: flex; justify-content: space-between; font-size: 10px; color: var(--chat-ink-faint); }
.ctx-progress-row b { font-family: var(--font-mono, monospace); color: var(--chat-ink-soft); }
.ctx-bar { height: 3px; overflow: hidden; background: var(--chat-line); border-radius: 999px; }
.ctx-bar i { display: block; height: 100%; background: var(--tone-success-dot); border-radius: inherit; }
.ctx-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding-top: 6px;
  font-family: var(--font-mono, monospace);
  font-size: 9.5px;
  color: var(--chat-ink-faint);
  border-top: 1px solid var(--chat-line);
}
.ctx-meta { font-size: 10px; color: var(--chat-ink-faint); }
.ctx-items { display: flex; flex-direction: column; gap: 4px; }
.ctx-item {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: space-between;
  padding: 5px 7px;
  cursor: pointer;
  background: var(--chat-surface-raised);
  border-radius: 7px;
}
.ctx-item:hover { background: var(--chat-canvas); }
.ctx-item-name { overflow: hidden; font-size: 11px; color: var(--chat-ink-soft); text-overflow: ellipsis; white-space: nowrap; }
.ctx-empty { margin: 0; font-size: 10.5px; color: var(--chat-ink-faint); }

.member-row { display: flex; gap: 8px; align-items: center; }
.member-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  font-weight: 700;
  color: var(--chat-canvas);
  background: var(--chat-ink);
  border-radius: 7px;
}
.member-avatar.gray { color: var(--chat-ink-soft); background: var(--chat-surface-raised); border: 1px solid var(--chat-line); }
.member-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 0; }
.member-main strong { font-size: 11px; color: var(--chat-ink-soft); }
.member-main span { font-size: 9.5px; color: var(--chat-ink-faint); }

.health-row { display: flex; gap: 7px; align-items: center; font-size: 11px; color: var(--chat-ink-soft); }
.health-dot { width: 7px; height: 7px; border-radius: 50%; }
.health-dot.ok { background: var(--tone-success-dot); }
.health-dot.bad { background: var(--tone-danger-dot); }
.health-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.health-status { font-size: 9.5px; color: var(--chat-ink-faint); }
.ctx-effects { display: flex; flex-wrap: wrap; gap: 4px; padding-top: 4px; border-top: 1px solid var(--chat-line); }
.effect-chip {
  padding: 2px 7px;
  font-family: var(--font-mono, monospace);
  font-size: 9.5px;
  color: var(--chat-ink-faint);
  background: var(--chat-surface-raised);
  border-radius: 5px;
}

/* ═══ 响应式 ═══ */
@media (max-width: 1280px) {
  .ctx { display: none; }
}

@media (max-width: 1024px) {
  .side { flex-basis: 208px; }
  .board { grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
}

@media (max-width: 900px) {
  .page { flex-direction: column; }
  .side {
    flex: 0 0 auto;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-right: 0;
    border-bottom: 1px solid var(--chat-line);
  }
  .side-head { width: 100%; padding: 0 0 4px; }
  .proj-id { width: 100%; padding: 0; }
  .side-version, .proj-obj, .side-foot, .side-label { display: none; }
  .proj-name { font-size: 13px; }
  .side-nav {
    flex: 1 1 100%;
    flex-direction: row;
    flex-wrap: wrap;
    width: 100%;
  }
  .side-item { flex: 1 1 auto; width: auto; padding: 6px 9px; white-space: nowrap; }
  .side-item-label { flex: 0 0 auto; }
  .side-life { width: 100%; }
  .main-col { padding: 14px 14px 32px; }
  .two-col, .grid2 { grid-template-columns: minmax(0, 1fr); }
  .form-grid { grid-template-columns: 1fr; }
  .hero-stats { gap: 8px 18px; }
  .hero-stat b { font-size: 17px; }
  .report-grid { grid-template-columns: repeat(2, 1fr); }
  .board { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  .board-col:last-child { grid-column: 1 / -1; }
}

@media (max-width: 640px) {
  /* 左导航在手机上 2 列网格:5 个 tab 全部可见,不再出现“两端对齐”的大空洞 */
  .side-nav {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }
  .side-item {
    justify-content: flex-start;
    width: 100%;
    min-height: 40px;
    white-space: normal;
  }
  .main-col { padding: 12px 12px 28px; }
  .ap-row1 { flex-wrap: wrap; }
  .ap-when { margin-left: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .sk-hero, .sk-card, .spin { animation: none; }
}
</style>
