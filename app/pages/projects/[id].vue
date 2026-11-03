<script setup lang="ts">
/**
 * /projects/:id —— 项目详情（V1 最小可用页）。
 * 覆盖：概览、频道、计划/交付物、工作项派发、成果提交/复核/验收、审计。
 */
import { computed, onMounted, reactive, ref } from 'vue'

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
  createdAt: string
  updatedAt: string
}
interface ChannelBindingDto { projectId: string, channelId: string, bindingType: string, charter: string, status: string }
interface DeliverableDto { id: string, name: string, ownerChannelId: string | null, required: number, status: string, acceptanceCriteriaJson: string }
interface WorkItemDto { id: string, deliverableId: string, channelId: string, title: string, state: string, stateReason: string | null, currentAttemptId: string | null, execBudgetMinutes: number }
interface ResultDto { id: string, deliverableId: string, channelId: string, title: string, summary: string, status: string, version: number, evidenceJson: string, reviewedBy: string | null, approvedBy: string | null }
interface ApprovalDto { id: string, kind: string, subjectId: string, status: string, expiresAt: string | null }
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

onMounted(load)
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

    <section class="grid2">
      <div class="card">
        <h2>频道</h2>
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
            <span class="badge">{{ c.bindingType }}</span>
            <span class="muted">{{ c.charter || '无 charter' }}</span>
          </li>
        </ul>
        <div class="form">
          <input
            v-model="bindForm.channelId"
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
      </div>

      <div class="card">
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
      </div>
    </section>

    <section class="card">
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
            </td>
          </tr>
        </tbody>
      </table>
      <div class="form inline">
        <select v-model="workForm.deliverableId">
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
        <select v-model="workForm.channelId">
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
          placeholder="工作项标题"
        >
        <input
          v-model="workForm.brief"
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

    <section class="card">
      <h2>成果</h2>
      <p
        v-if="!currentResults.length"
        class="muted"
      >
        Channel root task COMPLETED 后，点“对账”会自动生成 draft。
      </p>
      <article
        v-for="r in currentResults"
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
    </section>

    <section class="card">
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

    <section class="grid2">
      <div class="card">
        <h2>决策（最近 50）</h2>
        <ul class="list">
          <li
            v-for="d in decisions.slice(-50)"
            :key="d.id"
          >
            <span>#{{ d.seq }} {{ d.decisionType }}</span>
            <span class="badge">{{ d.state }}</span>
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
@media (max-width: 860px) { .grid2 { grid-template-columns: 1fr; } .head { flex-direction: column; } }
</style>
