<script setup lang="ts">
/**
 * /projects/:id —— 项目详情（V1 最小可用页）。
 * 覆盖：概览、频道、计划/交付物、工作项派发、成果提交/复核/验收、审计。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

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
    id: string, attemptNo: number, state: string, channelTaskId: string | null, failureClass: string, retryable: boolean, nextRetryAt: string | null, createdAt: string, closedAt: string | null
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
  obsTimer = setInterval(() => { void loadObservability() }, 5000)
})
onUnmounted(() => {
  if (obsTimer) clearInterval(obsTimer)
  obsTimer = null
})
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <button
          class="link"
          @click="navigateTo('/projects')"
        >
          ← 项目列表
        </button>
        <h1>{{ project?.name ?? '项目' }}</h1>
        <p class="sub">
          {{ project?.objective }}
        </p>
        <p class="sub">
          plan v{{ project?.planVersion ?? 0 }} · 待审批 {{ pendingApprovals.length }} 项 · leader {{ project?.leadAgentId ?? '-' }}
        </p>
      </div>
      <div class="actions">
        <span
          v-if="project"
          class="badge"
          :class="project.status"
        >{{ project.status }}</span>
        <button
          class="btn ghost"
          :disabled="loading"
          @click="lifecycle('reconcile')"
        >
          对账
        </button>
        <button
          v-if="project?.status === 'draft' || project?.status === 'paused'"
          class="btn"
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
          class="btn green"
          :disabled="loading"
          @click="lifecycle('resume')"
        >
          恢复
        </button>
        <button
          v-if="project?.status === 'active'"
          class="btn green"
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
      class="error"
    >
      {{ error }}
    </p>

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
            <span class="muted">{{ lane.channel.inFlight }} 执行 · {{ lane.channel.ready }} 就绪</span>
          </div>
          <p
            v-if="!lane.items.length"
            class="muted"
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
            <span class="row">
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

    <nav
      class="tabs"
      data-testid="project-tabs"
    >
      <button
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        :class="{ active: activeTab === t.key }"
        :data-testid="`tab-${t.key}`"
        @click="activeTab = t.key"
      >
        {{ t.label }}
      </button>
    </nav>

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
                root {{ a.task.state }} · {{ a.task.progress }}% · assignee {{ a.task.assigneeId.slice(0, 8) }}<template v-if="a.task.closeReason"> · {{ a.task.closeReason }}</template>
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
</template>

<style scoped>
.page { max-width: 1180px; margin: 0 auto; padding: 24px; color: #e6e8ee; }
.head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 18px; }
h1 { margin: 6px 0; font-size: 24px; }
h2 { font-size: 15px; margin: 0 0 12px; }
.sub { color: #9aa4b2; margin: 0; }
.link { background: none; border: 0; color: #93c5fd; cursor: pointer; padding: 0; }
.actions, .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.card { background: #161a22; border: 1px solid #2a3140; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.tabs { display: flex; gap: 6px; margin-bottom: 14px; border-bottom: 1px solid #2a3140; padding-bottom: 0; flex-wrap: wrap; }
.tab { background: none; border: 1px solid transparent; border-bottom: 0; color: #9aa4b2; padding: 8px 14px; cursor: pointer; font-size: 13px; border-radius: 8px 8px 0 0; }
.tab.active { color: #e6e8ee; background: #161a22; border-color: #2a3140; }
.group-head { display: flex; gap: 8px; align-items: center; margin: 14px 0 6px; padding-top: 8px; border-top: 1px dashed #2a3140; }
.plan-json { background: #0d1117; border: 1px solid #2a3140; border-radius: 8px; padding: 10px; font-size: 12px; max-height: 320px; overflow: auto; white-space: pre-wrap; }
.badge.protected { border-color: #b45309; color: #fbbf24; }
.list { list-style: none; padding: 0; margin: 0 0 10px; display: flex; flex-direction: column; gap: 8px; }
.list li { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; }
.form { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.form.inline { flex-direction: row; flex-wrap: wrap; }
input, select, textarea { background: #0f131a; border: 1px solid #2a3140; border-radius: 6px; color: #e6e8ee; padding: 7px 9px; }
.btn { background: #3b82f6; color: white; border: 0; border-radius: 6px; padding: 7px 12px; cursor: pointer; }
.btn.small { padding: 4px 9px; font-size: 12px; }
.btn.ghost { background: transparent; border: 1px solid #2a3140; color: #cbd5e1; }
.btn.green { background: #16a34a; }
.btn.danger { background: #b91c1c; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #263042; color: #cbd5e1; }
.badge.active, .badge.approved, .badge.completed { background: #14351f; color: #86efac; }
.badge.paused, .badge.blocked, .badge.draft { background: #3a2c12; color: #fcd34d; }
.badge.failed, .badge.rejected { background: #3b1d1d; color: #fca5a5; }
.badge.archived, .badge.superseded { background: #2a2f3a; color: #9aa4b2; }
.muted { color: #7c8798; font-size: 12px; }
.error { color: #fca5a5; }
.result { border-top: 1px solid #242b38; padding: 12px 0; }
.summary { color: #cbd5e1; font-size: 13px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid #242b38; vertical-align: top; }
code { color: #93c5fd; font-size: 11px; }

/* Router v3 执行工作台 */
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: #334155; display: inline-block; }
.live-dot.on { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
.inline-check { display: inline-flex; gap: 6px; align-items: center; }
.stat-strip { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0; }
.stat { background: #0f131a; border: 1px solid #2a3140; border-radius: 8px; padding: 6px 10px; font-size: 12px; color: #9aa4b2; }
.stat b { color: #e6e8ee; font-size: 15px; margin-right: 4px; }
.lanes { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin: 12px 0; }
.lane { background: #0f131a; border: 1px solid #2a3140; border-radius: 10px; padding: 12px; }
.lane-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.exec-card { width: 100%; text-align: left; background: #171d27; border: 1px solid #2a3140; border-radius: 8px; padding: 10px; margin-bottom: 8px; color: #e6e8ee; cursor: pointer; display: flex; flex-direction: column; gap: 5px; }
.exec-card:hover { border-color: #3b82f6; }
.exec-card strong { font-size: 13px; }
.route-strip { display: flex; gap: 14px; flex-wrap: wrap; border-top: 1px dashed #2a3140; padding-top: 10px; margin-top: 8px; font-size: 12px; color: #9aa4b2; }
.route-strip b { color: #cbd5e1; }
.badge.blue { background: #12283f; color: #93c5fd; }
.badge.amber { background: #3a2c12; color: #fcd34d; }
.badge.red { background: #3b1d1d; color: #fca5a5; }
.badge.green { background: #14351f; color: #86efac; }
.badge.gray { background: #263042; color: #cbd5e1; }
.waiting-box { margin-top: 12px; border-top: 1px dashed #2a3140; padding-top: 10px; }
.drawer-mask { position: fixed; inset: 0; background: rgba(2, 6, 23, .72); z-index: 50; display: flex; justify-content: flex-end; }
.drawer { width: min(720px, 94vw); height: 100%; overflow: auto; background: #11161e; border-left: 1px solid #2a3140; padding: 18px; }
.drawer h3 { font-size: 15px; margin: 4px 0 8px; }
.drawer h4 { font-size: 13px; margin: 18px 0 8px; color: #cbd5e1; }
.attempt { border-top: 1px solid #242b38; padding: 10px 0; }
.artifact-list { list-style: none; padding: 0; margin: 6px 0; display: flex; flex-direction: column; gap: 4px; }
.artifact-list li { display: flex; gap: 8px; align-items: center; font-size: 12px; }
.workers { margin-top: 8px; display: flex; flex-direction: column; gap: 5px; }
.worker { display: flex; gap: 8px; align-items: center; font-size: 12px; background: #0f131a; border-radius: 6px; padding: 5px 8px; }
@media (max-width: 860px) { .grid2 { grid-template-columns: 1fr; } .head { flex-direction: column; } .drawer { width: 100vw; } }
</style>
