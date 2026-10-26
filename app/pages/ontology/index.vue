<script setup lang="ts">
/**
 * 本体模型管理台(/ontology)—— 工业本体与语义资产的构建、审核、发布与编译预览。
 *
 * 三块职责:
 *  1) 资产面:实体/关系/约束规则/语义绑定(本体 ↔ 数采/数控/配方参数)的可读可编辑视图;
 *  2) 治理面:规则生命周期推进(proposed→reviewed→validated→approved_for_control)、
 *     第二人批准、版本冻结与退役(发布仅 admin);
 *  3) 解释面:编译预览四类产物 + Rule Trace,回答「这条建议为什么受此限制」。
 *
 * 设计纪律:页面不自己发明约束语义 —— 所有校验/编译/审批判定由服务端裁决,
 * 前端只呈现结果与可行动原因(409/422 原样展示)。
 */
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { apiErrorMessage } from '@/app/utils/api-error'
import { useUserStore } from '@/app/stores/workshop/user'
import OntologyGraph from '@/app/components/ontology/OntologyGraph.vue'
import { ontologyApi } from './api'
import type {
  CompileDto, DraftDetailDto, DraftSummary, IssueDto, OverviewDto,
  SubgraphAroundDto, VersionDiffDto, VersionDto,
} from './types'

const { t } = useI18n()
const userStore = useUserStore()

type TabKey = 'overview' | 'graph' | 'rules' | 'bindings' | 'versions' | 'compile'
const tab = ref<TabKey>('overview')
const tabs: TabKey[] = ['overview', 'graph', 'rules', 'bindings', 'versions', 'compile']

const loading = ref(false)
const busy = ref(false)
const overview = ref<OverviewDto>({ ontologies: [], drafts: [] })
const draftId = ref('')
const detail = ref<DraftDetailDto | null>(null)
const versions = ref<VersionDto[]>([])
const diff = ref<VersionDiffDto | null>(null)
const preview = ref<CompileDto | null>(null)
const diffFrom = ref<number | undefined>(undefined)
const diffTo = ref<number | undefined>(undefined)

const isAdmin = computed(() => userStore.isAdmin)
const doc = computed(() => detail.value?.doc ?? null)
const issues = computed<IssueDto[]>(() => detail.value?.validation.issues ?? [])
const errors = computed(() => issues.value.filter(i => i.severity === 'error'))
const bindingFailures = computed(() => detail.value?.bindings.failures ?? [])
const lastFixes = ref<Array<{ code: string, path: string, message: string }>>([])

// 图/表视图与节点邻接抽屉(图与抽屉都读当前草稿,避免「图画草稿、抽屉查已发布」错位)
type GraphView = 'graph' | 'table'
const graphView = ref<GraphView>('graph')
const selectedKey = ref('')
const hops = ref<1 | 2>(1)
const neighbors = ref<SubgraphAroundDto | null>(null)
const neighborsLoading = ref(false)
const neighborsError = ref('')
let neighborReq = 0

const graphViewOptions = computed(() => [
  { value: 'graph', label: t('ontology.graph.viewGraph') },
  { value: 'table', label: t('ontology.graph.viewTable') },
])
const selectedEntity = computed(() => (doc.value?.entities ?? []).find(e => e.key === selectedKey.value) ?? null)
const selectedBindings = computed(() => (doc.value?.bindings ?? []).filter(b => b.entityKey === selectedKey.value))
const drawerOpen = computed(() => Boolean(selectedEntity.value))
const neighborNodes = computed(() => (neighbors.value?.nodes ?? []).filter(n => n.hop > 0))
const entityOptions = computed(() => (doc.value?.entities ?? []).map(e => ({ value: e.key, label: `${e.key} · ${e.name}` })))
const largeGraph = computed(() => (doc.value?.entities.length ?? 0) > 60)
const draftOptions = computed(() => overview.value.drafts.map(d => ({
  value: d.id,
  label: `${d.ontologyId} · rev ${d.rev}${d.baseVersion ? ` · ${t('ontology.graph.baseline')} v${d.baseVersion}` : ''}`,
})))
const versionOptions = computed(() => versions.value.map(v => ({ value: v.version, label: `v${v.version}(${v.status})` })))

const entityColumns = [
  { title: 'key', dataIndex: 'key', key: 'key', width: 180 },
  { title: t('ontology.col.kind'), dataIndex: 'kind', key: 'kind', width: 140 },
  { title: t('ontology.col.name'), dataIndex: 'name', key: 'name' },
  { title: t('ontology.col.role'), dataIndex: 'role', key: 'role', width: 110 },
  { title: t('ontology.col.unit'), dataIndex: 'unit', key: 'unit', width: 90 },
]
const relationColumns = [
  { title: 'id', dataIndex: 'id', key: 'id', width: 180 },
  { title: t('ontology.col.predicate'), dataIndex: 'kind', key: 'kind', width: 130 },
  { title: 'src → dst', key: 'edge', width: 300 },
  { title: t('ontology.col.evidenceTier'), key: 'tier', width: 170 },
]
const ruleColumns = [
  { title: 'id', dataIndex: 'id', key: 'id', width: 160 },
  { title: t('ontology.col.ruleKind'), dataIndex: 'kind', key: 'kind', width: 140 },
  { title: t('ontology.col.level'), dataIndex: 'constraintLevel', key: 'level', width: 90 },
  { title: t('ontology.col.status'), dataIndex: 'status', key: 'status', width: 170 },
  { title: t('ontology.col.evidence'), key: 'evidence', width: 200 },
  { title: t('ontology.col.action'), key: 'action', width: 260 },
]
const bindingColumns = [
  { title: 'id', dataIndex: 'id', key: 'id', width: 150 },
  { title: t('ontology.col.entity'), dataIndex: 'entityKey', key: 'entityKey', width: 180 },
  { title: t('ontology.col.target'), key: 'target' },
  { title: t('ontology.col.direction'), dataIndex: 'direction', key: 'direction', width: 110 },
  { title: t('ontology.col.unitPair'), key: 'unitPair', width: 160 },
]
const versionColumns = [
  { title: t('ontology.col.version'), dataIndex: 'version', key: 'version', width: 90 },
  { title: t('ontology.col.status'), dataIndex: 'status', key: 'status', width: 110 },
  { title: 'hash', dataIndex: 'contentHash', key: 'contentHash', width: 220 },
  { title: t('ontology.col.line'), dataIndex: 'lineId', key: 'lineId', width: 140 },
  { title: t('ontology.col.parent'), dataIndex: 'parentVersion', key: 'parentVersion', width: 90 },
  { title: t('ontology.col.createdAt'), dataIndex: 'createdAt', key: 'createdAt' },
]
const traceColumns = [
  { title: 'ruleId', dataIndex: 'ruleId', key: 'ruleId', width: 150 },
  { title: t('ontology.col.decision'), dataIndex: 'decision', key: 'decision', width: 110 },
  { title: t('ontology.col.code'), dataIndex: 'decisionCode', key: 'decisionCode', width: 220 },
  { title: t('ontology.col.evidence'), dataIndex: 'evidenceLevel', key: 'evidenceLevel', width: 160 },
  { title: t('ontology.col.message'), dataIndex: 'message', key: 'message' },
]

function statusColor(status: string): string {
  if (status === 'approved_for_control') return 'green'
  if (status === 'validated') return 'blue'
  if (status === 'reviewed') return 'cyan'
  if (status === 'deprecated') return 'red'
  return 'default'
}

function tierColor(tier: string): string {
  if (tier === 'validated_control') return 'green'
  if (tier === 'observed_correlation') return 'blue'
  return 'default'
}

async function loadOverview(): Promise<void> {
  loading.value = true
  try {
    overview.value = await ontologyApi<OverviewDto>('')
    if (!draftId.value && overview.value.drafts.length > 0) draftId.value = overview.value.drafts[0]!.id
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('ontology.loadFail')))
  }
  finally {
    loading.value = false
  }
}

async function loadDraft(): Promise<void> {
  if (!draftId.value) {
    detail.value = null
    return
  }
  try {
    detail.value = await ontologyApi<DraftDetailDto>(`/drafts/${encodeURIComponent(draftId.value)}`)
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('ontology.loadDraftFail')))
  }
}

async function loadNeighbors(): Promise<void> {
  if (!selectedKey.value || !draftId.value) return
  const req = ++neighborReq
  neighborsLoading.value = true
  neighborsError.value = ''
  try {
    const qs = new URLSearchParams({ entity: selectedKey.value, hops: String(hops.value), limit: '100' })
    const res = await ontologyApi<{ subgraph: SubgraphAroundDto }>(
      `/drafts/${encodeURIComponent(draftId.value)}/subgraph?${qs.toString()}`,
    )
    if (req === neighborReq) neighbors.value = res.subgraph
  }
  catch (e) {
    if (req === neighborReq) {
      neighbors.value = null
      neighborsError.value = apiErrorMessage(e, t('ontology.graph.loadNeighborsFail'))
    }
  }
  finally {
    if (req === neighborReq) neighborsLoading.value = false
  }
}

function openNode(key: string): void {
  selectedKey.value = key
  hops.value = 1
  neighbors.value = null
  void loadNeighbors()
}

function setHops(next: 1 | 2): void {
  hops.value = next
  void loadNeighbors()
}

function closeDrawer(): void {
  neighborReq += 1
  selectedKey.value = ''
  neighbors.value = null
  neighborsError.value = ''
  neighborsLoading.value = false
}

function switchTab(key: TabKey): void {
  tab.value = key
  if (key !== 'graph') closeDrawer()
}

async function loadVersions(ontologyId: string): Promise<void> {
  if (!ontologyId) {
    versions.value = []
    return
  }
  try {
    const res = await ontologyApi<{ versions: VersionDto[] }>(`/versions/${encodeURIComponent(ontologyId)}`)
    versions.value = res.versions
    if (versions.value.length >= 2) {
      diffTo.value = versions.value[0]!.version
      diffFrom.value = versions.value[1]!.version
    }
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('ontology.loadVersionsFail')))
  }
}

async function createDraft(): Promise<void> {
  const ontologyId = window.prompt(t('ontology.prompt.ontologyId'))
  if (!ontologyId) return
  const lineId = window.prompt(t('ontology.prompt.lineId')) ?? ''
  busy.value = true
  try {
    const res = await ontologyApi<{ draft: DraftSummary }>('', { method: 'POST', body: { ontologyId, lineId } })
    message.success(t('ontology.draftCreated', { id: res.draft.id }))
    draftId.value = res.draft.id
    await loadOverview()
    await loadDraft()
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('ontology.draftCreateFail')))
  }
  finally {
    busy.value = false
  }
}

async function runValidate(): Promise<void> {
  if (!draftId.value) return
  busy.value = true
  try {
    const res = await ontologyApi<{ ok: boolean }>(`/drafts/${encodeURIComponent(draftId.value)}/validate`, { method: 'POST', body: {} })
    message[res.ok ? 'success' : 'warning'](res.ok ? t('ontology.validateOk') : t('ontology.validateFail'))
    await loadDraft()
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('ontology.validateFail')))
  }
  finally {
    busy.value = false
  }
}

/** 自动修复:补描述/量纲跟随单位/作用域回填/悬空与重复确定性修复(证据不伪造) */
async function runAutofix(): Promise<void> {
  if (!draftId.value) return
  busy.value = true
  try {
    const res = await ontologyApi<{ fixedCount: number, fixes: Array<{ code: string, path: string, message: string }>, validation: { ok: boolean }, bindings: { ok: boolean } }>(
      `/drafts/${encodeURIComponent(draftId.value)}/autofix`, { method: 'POST', body: {} },
    )
    lastFixes.value = res.fixes ?? []
    if (res.fixedCount > 0) {
      message.success(t('ontology.autofixDone', { n: res.fixedCount }))
    }
    else {
      message.info(t('ontology.autofixNothing'))
    }
    if (!res.validation.ok || !res.bindings.ok) {
      message.warning(t('ontology.autofixPartial'))
    }
    await loadDraft()
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('ontology.autofixFail')))
  }
  finally {
    busy.value = false
  }
}

async function runCompile(): Promise<void> {
  if (!draftId.value) return
  busy.value = true
  try {
    preview.value = await ontologyApi<CompileDto>(`/drafts/${encodeURIComponent(draftId.value)}/compile`, { method: 'POST', body: {} })
    tab.value = 'compile'
    message.success(t('ontology.compileOk', { status: preview.value.status }))
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('ontology.compileFail')))
  }
  finally {
    busy.value = false
  }
}

async function runPublish(): Promise<void> {
  if (!draftId.value) return
  busy.value = true
  try {
    const res = await ontologyApi<{ version: { version: number }, packHash: string }>(`/drafts/${encodeURIComponent(draftId.value)}/publish`, { method: 'POST', body: {} })
    message.success(t('ontology.publishOk', { version: res.version.version }))
    if (doc.value) await loadVersions(doc.value.name ? (overview.value.drafts.find(d => d.id === draftId.value)?.ontologyId ?? '') : '')
    await loadDraft()
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('ontology.publishFail')))
  }
  finally {
    busy.value = false
  }
}

async function transitionRule(ruleId: string, to: string): Promise<void> {
  if (!draftId.value) return
  busy.value = true
  try {
    await ontologyApi(`/drafts/${encodeURIComponent(draftId.value)}/rules/${encodeURIComponent(ruleId)}/transition`, {
      method: 'POST', body: { to },
    })
    message.success(t('ontology.ruleTransitionOk', { rule: ruleId, to }))
    await loadDraft()
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('ontology.ruleTransitionFail')))
  }
  finally {
    busy.value = false
  }
}

async function requestApproval(ruleId: string): Promise<void> {
  if (!draftId.value) return
  busy.value = true
  try {
    const res = await ontologyApi<{ approvalId: string }>(`/drafts/${encodeURIComponent(draftId.value)}/rules/${encodeURIComponent(ruleId)}/approval`, { method: 'POST', body: {} })
    message.success(t('ontology.approvalRequested', { id: res.approvalId }))
    const approvalId = window.prompt(t('ontology.prompt.approvalId'), res.approvalId)
    if (approvalId) {
      await ontologyApi(`/drafts/${encodeURIComponent(draftId.value)}/rules/${encodeURIComponent(ruleId)}/approval-decision`, {
        method: 'POST', body: { approvalId, approved: true },
      })
      message.success(t('ontology.approvalDecided'))
      await loadDraft()
    }
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('ontology.approvalFail')))
  }
  finally {
    busy.value = false
  }
}

async function runCompare(): Promise<void> {
  const ontologyId = overview.value.drafts.find(d => d.id === draftId.value)?.ontologyId ?? overview.value.ontologies[0]?.id ?? ''
  if (!ontologyId || diffFrom.value === undefined || diffTo.value === undefined) return
  try {
    diff.value = await ontologyApi<VersionDiffDto>(`/versions/${encodeURIComponent(ontologyId)}/compare?from=${diffFrom.value}&to=${diffTo.value}`)
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('ontology.compareFail')))
  }
}

async function retire(version: number): Promise<void> {
  const ontologyId = overview.value.drafts.find(d => d.id === draftId.value)?.ontologyId ?? overview.value.ontologies[0]?.id ?? ''
  if (!ontologyId) return
  busy.value = true
  try {
    await ontologyApi(`/versions/${encodeURIComponent(ontologyId)}`, { method: 'POST', body: { version } })
    message.success(t('ontology.retireOk', { version }))
    await loadVersions(ontologyId)
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('ontology.retireFail')))
  }
  finally {
    busy.value = false
  }
}

function currentOntologyId(): string {
  return overview.value.drafts.find(d => d.id === draftId.value)?.ontologyId ?? overview.value.ontologies[0]?.id ?? ''
}

onMounted(async () => {
  await loadOverview()
  await loadDraft()
  await loadVersions(currentOntologyId())
})

function onDraftChange(): void {
  closeDrawer()
  void loadDraft()
  void loadVersions(currentOntologyId())
}

function issueColor(severity: string): string {
  return severity === 'error' ? 'red' : 'orange'
}

function diffLabel(part: { added: string[], removed: string[], changed: string[] }): string {
  return `+${part.added.length} / −${part.removed.length} / ±${part.changed.length}`
}
</script>

<template>
  <div class="ontology-page">
    <header class="aw-page-head">
      <div>
        <p class="aw-kicker">
          {{ t('ontology.kicker') }}
        </p>
        <h1>{{ t('ontology.title') }}</h1>
        <p class="sub">
          {{ t('ontology.subtitle') }}
        </p>
        <p
          v-if="doc?.description"
          class="model-desc"
        >
          <span class="model-desc-tag">{{ doc.name }}</span>
          {{ doc.description }}
        </p>
      </div>
      <div class="head-actions">
        <a-button
          :loading="loading"
          @click="loadOverview"
        >
          {{ t('ontology.refresh') }}
        </a-button>
        <a-button
          type="primary"
          :loading="busy"
          @click="createDraft"
        >
          {{ t('ontology.newDraft') }}
        </a-button>
      </div>
    </header>

    <section class="toolbar">
      <a-select
        :value="draftId"
        style="min-width: 320px"
        :options="draftOptions"
        :placeholder="t('ontology.pickDraft')"
        show-search
        @change="(v: unknown) => { draftId = String(v ?? ''); onDraftChange() }"
      />
      <a-button
        :disabled="!draftId"
        :loading="busy"
        @click="runValidate"
      >
        {{ t('ontology.validate') }}
      </a-button>
      <a-button
        :disabled="!draftId || (issues.length === 0 && bindingFailures.length === 0)"
        :loading="busy"
        @click="runAutofix"
      >
        {{ t('ontology.autofix') }}
      </a-button>
      <a-button
        :disabled="!draftId"
        :loading="busy"
        @click="runCompile"
      >
        {{ t('ontology.compile') }}
      </a-button>
      <a-button
        v-if="isAdmin"
        :disabled="!draftId || errors.length > 0 || bindingFailures.length > 0"
        type="primary"
        :loading="busy"
        @click="runPublish"
      >
        {{ t('ontology.publish') }}
      </a-button>
      <span class="hint">{{ t('ontology.publishHint') }}</span>
    </section>

    <div class="tabs">
      <button
        v-for="key in tabs"
        :key="key"
        class="pill-btn"
        :class="{ active: tab === key }"
        @click="switchTab(key)"
      >
        {{ t(`ontology.tab.${key}`) }}
      </button>
    </div>

    <!-- 总览 -->
    <section
      v-if="tab === 'overview'"
      class="panel"
    >
      <div class="stats">
        <div class="stat">
          <span>{{ t('ontology.stat.ontologies') }}</span>
          <strong>{{ overview.ontologies.length }}</strong>
        </div>
        <div class="stat">
          <span>{{ t('ontology.stat.drafts') }}</span>
          <strong>{{ overview.drafts.length }}</strong>
        </div>
        <div class="stat">
          <span>{{ t('ontology.stat.entities') }}</span>
          <strong>{{ doc?.entities.length ?? 0 }}</strong>
        </div>
        <div class="stat">
          <span>{{ t('ontology.stat.rules') }}</span>
          <strong>{{ doc?.rules.length ?? 0 }}</strong>
        </div>
        <div class="stat">
          <span>{{ t('ontology.stat.bindings') }}</span>
          <strong>{{ doc?.bindings.length ?? 0 }}</strong>
        </div>
      </div>
      <div class="two-col">
        <div>
          <h2>{{ t('ontology.section.ontologies') }}</h2>
          <ul class="plain">
            <li
              v-for="o in overview.ontologies"
              :key="o.id"
            >
              <strong>{{ o.id }}</strong>
              <span>{{ o.lineId || t('ontology.global') }} · v{{ o.latest }} · {{ o.status }}</span>
            </li>
            <li
              v-if="overview.ontologies.length === 0"
              class="muted"
            >
              {{ t('ontology.empty.ontologies') }}
            </li>
          </ul>
        </div>
        <div>
          <h2>{{ t('ontology.section.issues') }}</h2>
          <ul class="plain">
            <li
              v-for="(issue, index) in issues.slice(0, 20)"
              :key="`${issue.code}-${index}`"
            >
              <a-tag :color="issueColor(issue.severity)">
                {{ issue.severity }}
              </a-tag>
              <strong>{{ issue.code }}</strong>
              <span>{{ issue.message }}</span>
              <em v-if="issue.hint">{{ issue.hint }}</em>
            </li>
            <li
              v-if="issues.length === 0"
              class="muted"
            >
              {{ t('ontology.empty.issues') }}
            </li>
          </ul>
          <div
            v-if="lastFixes.length"
            class="autofix-log"
          >
            <h3>{{ t('ontology.autofixLog', { n: lastFixes.length }) }}</h3>
            <ul class="plain">
              <li
                v-for="(f, i) in lastFixes"
                :key="`${f.code}-${i}`"
              >
                <a-tag color="green">
                  {{ f.code }}
                </a-tag>
                <span>{{ f.message }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- 实体与关系 -->
    <section
      v-else-if="tab === 'graph'"
      class="panel"
    >
      <div class="graph-toolbar">
        <a-segmented
          v-model:value="graphView"
          size="small"
          :options="graphViewOptions"
        />
        <span class="hint">{{ t('ontology.graph.hint') }}</span>
        <a-select
          :value="selectedKey || undefined"
          :options="entityOptions"
          show-search
          allow-clear
          :placeholder="t('ontology.graph.searchEntity')"
          class="node-search"
          @change="(v: unknown) => { const key = String(v ?? ''); if (key) openNode(key); else closeDrawer() }"
        />
      </div>

      <template v-if="graphView === 'graph'">
        <p
          v-if="largeGraph"
          class="muted"
        >
          {{ t('ontology.graph.largeGraph', { n: doc?.entities.length ?? 0 }) }}
        </p>
        <OntologyGraph
          v-else
          :entities="doc?.entities ?? []"
          :relations="doc?.relations ?? []"
          :selected-key="selectedKey"
          @select="openNode"
        />
      </template>

      <template v-else>
        <h2>{{ t('ontology.section.entities') }}</h2>
        <a-table
          data-testid="entity-table"
          :columns="entityColumns"
          :data-source="doc?.entities ?? []"
          row-key="key"
          size="small"
          :pagination="{ pageSize: 12 }"
        />
        <h2>{{ t('ontology.section.relations') }}</h2>
        <a-table
          data-testid="relation-table"
          :columns="relationColumns"
          :data-source="doc?.relations ?? []"
          row-key="id"
          size="small"
          :pagination="{ pageSize: 12 }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'edge'">
              <code>{{ record.srcKey }}</code> → <code>{{ record.dstKey }}</code>
            </template>
            <template v-else-if="column.key === 'tier'">
              <a-tag :color="tierColor(record.properties?.evidenceTier)">
                {{ record.properties?.evidenceTier }}
              </a-tag>
              <span
                v-if="record.properties?.lagMs !== undefined"
                class="muted"
              >lag {{ record.properties.lagMs }}ms</span>
            </template>
          </template>
        </a-table>
      </template>

      <a-drawer
        :open="drawerOpen"
        width="560"
        :title="selectedEntity ? `${selectedEntity.name} · ${selectedEntity.key}` : ''"
        @close="closeDrawer"
      >
        <template v-if="selectedEntity">
          <div data-testid="node-drawer">
            <dl class="node-detail">
              <dt>kind</dt><dd>{{ selectedEntity.kind }}</dd>
              <dt>role</dt><dd>{{ selectedEntity.role || '—' }}</dd>
              <dt>unit</dt><dd>{{ selectedEntity.unit || '—' }}</dd>
              <dt>description</dt><dd>{{ selectedEntity.description || '—' }}</dd>
            </dl>

            <h4>{{ t('ontology.drawer.bindings') }}</h4>
            <p
              v-if="selectedBindings.length === 0"
              class="muted"
            >
              {{ t('ontology.drawer.noBindings') }}
            </p>
            <ul
              v-else
              class="plain"
            >
              <li
                v-for="b in selectedBindings"
                :key="b.id"
              >
                <code>{{ b.platformKind }}:{{ b.platformId }}{{ b.targetSub ? `#${b.targetSub}` : '' }}</code>
                <span>{{ b.direction }} · {{ b.unitDeclared || '—' }} → {{ b.unitTarget || '—' }}</span>
              </li>
            </ul>

            <h4>{{ t('ontology.graph.neighbors') }}</h4>
            <a-segmented
              :value="hops"
              size="small"
              :options="[
                { value: 1, label: t('ontology.graph.direct') },
                { value: 2, label: t('ontology.graph.indirect') },
              ]"
              @change="(v: unknown) => setHops(Number(v) === 2 ? 2 : 1)"
            />

            <p
              v-if="neighborsLoading"
              class="muted"
            >
              {{ t('ontology.graph.loading') }}
            </p>
            <p
              v-else-if="neighborsError"
              class="muted"
            >
              {{ neighborsError }}
            </p>
            <template v-else-if="neighbors">
              <p
                v-if="neighbors.truncated"
                class="muted"
              >
                {{ t('ontology.graph.truncated') }}
              </p>
              <p
                v-if="neighborNodes.length === 0"
                class="muted"
              >
                {{ t('ontology.graph.noNeighbors') }}
              </p>
              <ul
                v-else
                class="plain"
              >
                <li
                  v-for="n in neighborNodes"
                  :key="n.key"
                  :data-neighbor-key="n.key"
                  :data-hop="n.hop"
                >
                  <strong>{{ n.key }}</strong>
                  <span>{{ n.kind }} · {{ n.role || '—' }} · hop {{ n.hop }}</span>
                </li>
              </ul>
              <ul
                v-if="neighbors.edges.length"
                class="plain edges"
              >
                <li
                  v-for="e in neighbors.edges"
                  :key="e.id"
                  :data-edge-id="e.id"
                >
                  <code>{{ e.srcKey }} -{{ e.kind }}-> {{ e.dstKey }}</code>
                  <span>hop {{ e.hop }} · {{ e.direction }} · {{ e.evidenceTier }}</span>
                </li>
              </ul>
            </template>
          </div>
        </template>
      </a-drawer>
    </section>

    <!-- 约束规则 -->
    <section
      v-else-if="tab === 'rules'"
      class="panel"
    >
      <a-table
        :columns="ruleColumns"
        :data-source="doc?.rules ?? []"
        row-key="id"
        size="small"
        :pagination="{ pageSize: 10 }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'status'">
            <a-tag :color="statusColor(record.status)">
              {{ record.status }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'evidence'">
            <span
              v-for="(e, i) in record.evidence"
              :key="i"
            >
              <a-tag :color="tierColor(e.level)">{{ e.level }}</a-tag>
            </span>
            <span
              v-if="record.evidence.length === 0"
              class="muted"
            >{{ t('ontology.noEvidence') }}</span>
          </template>
          <template v-else-if="column.key === 'action'">
            <a-button
              v-if="record.status === 'proposed'"
              size="small"
              :loading="busy"
              @click="transitionRule(record.id, 'reviewed')"
            >
              {{ t('ontology.action.review') }}
            </a-button>
            <a-button
              v-if="record.status === 'reviewed'"
              size="small"
              :loading="busy"
              @click="transitionRule(record.id, 'validated')"
            >
              {{ t('ontology.action.validate') }}
            </a-button>
            <a-button
              v-if="record.status === 'validated'"
              size="small"
              type="primary"
              :loading="busy"
              @click="requestApproval(record.id)"
            >
              {{ t('ontology.action.approve') }}
            </a-button>
          </template>
        </template>
      </a-table>
    </section>

    <!-- 语义绑定 -->
    <section
      v-else-if="tab === 'bindings'"
      class="panel"
    >
      <a-table
        :columns="bindingColumns"
        :data-source="doc?.bindings ?? []"
        row-key="id"
        size="small"
        :pagination="{ pageSize: 12 }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'target'">
            <code>{{ record.platformKind }}:{{ record.platformId }}{{ record.targetSub ? `#${record.targetSub}` : '' }}</code>
          </template>
          <template v-else-if="column.key === 'unitPair'">
            <span>{{ record.unitDeclared || '—' }} → {{ record.unitTarget || '—' }}</span>
          </template>
        </template>
      </a-table>
      <div
        v-if="bindingFailures.length"
        class="failures"
      >
        <h3>{{ t('ontology.section.bindingFailures') }}</h3>
        <p
          v-for="f in bindingFailures"
          :key="f.bindingId"
        >
          <a-tag color="red">
            {{ f.code }}
          </a-tag>{{ f.message }}
        </p>
      </div>
    </section>

    <!-- 版本与发布 -->
    <section
      v-else-if="tab === 'versions'"
      class="panel"
    >
      <a-table
        :columns="versionColumns"
        :data-source="versions"
        row-key="version"
        size="small"
        :pagination="{ pageSize: 10 }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'status'">
            <a-tag :color="record.status === 'published' ? 'green' : (record.status === 'retired' ? 'red' : 'default')">
              {{ record.status }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'contentHash'">
            <code>{{ String(record.contentHash).slice(0, 16) }}…</code>
          </template>
          <template v-else-if="column.key === 'createdAt'">
            <span>{{ record.createdAt }}</span>
            <a-button
              v-if="isAdmin && record.status === 'published'"
              size="small"
              danger
              class="retire"
              :loading="busy"
              @click="retire(record.version)"
            >
              {{ t('ontology.action.retire') }}
            </a-button>
          </template>
        </template>
      </a-table>
      <div class="compare">
        <a-select
          v-model:value="diffFrom"
          :options="versionOptions"
          style="width: 140px"
          :placeholder="t('ontology.from')"
        />
        <span>→</span>
        <a-select
          v-model:value="diffTo"
          :options="versionOptions"
          style="width: 140px"
          :placeholder="t('ontology.to')"
        />
        <a-button
          :loading="busy"
          @click="runCompare"
        >
          {{ t('ontology.compare') }}
        </a-button>
      </div>
      <div
        v-if="diff"
        class="diff"
      >
        <p><strong>v{{ diff.from }} → v{{ diff.to }}</strong></p>
        <p>{{ t('ontology.diff.entities') }}: {{ diffLabel(diff.entities) }}</p>
        <p>{{ t('ontology.diff.relations') }}: {{ diffLabel(diff.relations) }}</p>
        <p>{{ t('ontology.diff.rules') }}: {{ diffLabel(diff.rules) }}</p>
        <p>{{ t('ontology.diff.bindings') }}: {{ diffLabel(diff.bindings) }}</p>
        <p v-if="diff.rules.changed.length">
          <strong>{{ t('ontology.diff.rulesChanged') }}:</strong>
          <code
            v-for="id in diff.rules.changed"
            :key="id"
            class="chip"
          >{{ id }}</code>
        </p>
      </div>
    </section>

    <!-- 编译预览 -->
    <section
      v-else
      class="panel"
    >
      <div
        v-if="!preview"
        class="muted"
      >
        {{ t('ontology.compileEmpty') }}
      </div>
      <template v-else>
        <div class="stats">
          <div class="stat">
            <span>{{ t('ontology.col.status') }}</span><strong>{{ preview.status }}</strong>
          </div>
          <div class="stat">
            <span>compiled</span><strong>{{ preview.counts.compiled }}</strong>
          </div>
          <div class="stat">
            <span>guard</span><strong>{{ preview.counts.guard }}</strong>
          </div>
          <div class="stat">
            <span>explained</span><strong>{{ preview.counts.explained }}</strong>
          </div>
          <div class="stat">
            <span>rejected</span><strong>{{ preview.counts.rejected }}</strong>
          </div>
        </div>
        <p class="muted">
          packHash <code>{{ preview.packHash.slice(0, 24) }}…</code>
        </p>
        <h2>{{ t('ontology.section.artifacts') }}</h2>
        <div class="artifacts">
          <div>
            <h3>problem_ir</h3>
            <pre>{{ JSON.stringify({ mvBounds: preview.artifacts.problemIr.mvBounds, cvBounds: preview.artifacts.problemIr.cvBounds }, null, 2) }}</pre>
          </div>
          <div>
            <h3>control_guard</h3>
            <pre>{{ JSON.stringify(preview.artifacts.controlGuard, null, 2) }}</pre>
          </div>
          <div>
            <h3>process_model</h3>
            <pre>{{ JSON.stringify({ featureCandidates: preview.artifacts.processModel.featureCandidates.length, delayPriors: preview.artifacts.processModel.delayPriors.length }, null, 2) }}</pre>
          </div>
          <div>
            <h3>scene_contract</h3>
            <pre>{{ JSON.stringify({ variables: preview.artifacts.sceneContract.variables.length, constraints: preview.artifacts.sceneContract.constraints.length, relations: preview.artifacts.sceneContract.inferredRelations.length }, null, 2) }}</pre>
          </div>
        </div>
        <h2>{{ t('ontology.section.ruleTrace') }}</h2>
        <a-table
          :columns="traceColumns"
          :data-source="preview.traces"
          row-key="ruleId"
          size="small"
          :pagination="{ pageSize: 10 }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'decision'">
              <a-tag :color="record.decision === 'compiled' ? 'green' : (record.decision === 'guard' ? 'blue' : (record.decision === 'rejected' ? 'red' : 'default'))">
                {{ record.decision }}
              </a-tag>
            </template>
          </template>
        </a-table>
      </template>
    </section>
  </div>
</template>

<style scoped>
.ontology-page { padding: 20px 24px 48px; display: flex; flex-direction: column; gap: 16px; }
.aw-page-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.aw-page-head h1 { margin: 2px 0 6px; font-size: 22px; }
.sub { margin: 0; color: var(--ink-soft); max-width: 72ch; }
.model-desc { margin: 8px 0 0; color: var(--ink-soft); max-width: 84ch; font-size: 13px; display: flex; gap: 8px; align-items: baseline; }
.model-desc-tag { flex: none; border: 1px solid var(--line, #2a3542); border-radius: 999px; padding: 1px 8px; font-size: 11px; color: var(--ink-faint); }
.autofix-log { margin-top: 14px; border-top: 1px dashed var(--line, #2a3542); padding-top: 10px; }
.autofix-log h3 { margin: 0 0 6px; font-size: 13px; color: var(--ink-soft); }
.head-actions { display: flex; gap: 8px; }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.hint { color: var(--ink-faint); font-size: 12px; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.panel { display: flex; flex-direction: column; gap: 14px; }
.panel h2 { font-size: 14px; margin: 8px 0 0; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .04em; }
.stats { display: flex; gap: 10px; flex-wrap: wrap; }
.stat { border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; min-width: 120px; display: flex; flex-direction: column; gap: 4px; }
.stat span { font-size: 12px; color: var(--ink-faint); }
.stat strong { font-size: 20px; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.plain li { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; }
.plain li span { color: var(--ink-soft); font-size: 12px; }
.plain li em { color: var(--ink-faint); font-size: 12px; font-style: normal; }
.muted { color: var(--ink-faint); }
.failures { border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
.artifacts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.artifacts h3 { margin: 0 0 6px; font-size: 12px; color: var(--ink-faint); }
.artifacts pre { margin: 0; background: var(--surface-2, rgba(255,255,255,.03)); border: 1px solid var(--line); border-radius: 8px; padding: 10px; font-size: 11px; max-height: 260px; overflow: auto; }
.compare { display: flex; gap: 8px; align-items: center; }
.diff { border: 1px solid var(--line); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 4px; }
.chip { margin-right: 6px; }
.retire { margin-left: 8px; }
.graph-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.node-search { min-width: 300px; }
.node-detail { display: grid; grid-template-columns: 96px 1fr; gap: 6px 12px; margin: 0 0 14px; }
.node-detail dt { color: var(--ink-faint); font-size: 12px; }
.node-detail dd { margin: 0; font-size: 13px; }
.panel h4 { margin: 16px 0 8px; font-size: 13px; color: var(--ink-soft); }
.plain.edges li { border-color: var(--line); background: transparent; }
</style>
