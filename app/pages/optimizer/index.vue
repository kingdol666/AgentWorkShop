<script setup lang="ts">
/**
 * Optimizer Manager —— 场景/变量/工况 → 数据集 → 训练 → Profile → 绑定 → 求解 → 建议。
 * 与 Agent 工具共用同一 REST/服务层;本页不写设备,只产出建议。
 *
 * 2026-11-06 重建:此前整页自造 GitHub-Dark 主题 + 裸 input/select,亮暗双档均不可读
 * (docs/plan/2026-11-06-ui-optimization-plan.md §6.2)。现收进 Industrial Instrument
 * 设计系统:antd 组件 + a-steps 治理流 + 危险操作确认 + 表格分页 + JSON 行内校验;
 * 样式全令牌。数据层(saveSpec/buildDataset/train/…)与 i18n key 保持不变。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { optimizerApi, processModelApi } from './api'

definePageMeta({ layout: 'default' })
const { t } = useI18n()
useHead({ title: () => t('menu.optimizer') })

type Tab = 'spec' | 'eligibility' | 'profile' | 'binding' | 'runs'
const TABS: Tab[] = ['spec', 'eligibility', 'profile', 'binding', 'runs']
const tab = ref<Tab>('spec')
const error = ref('')
const notice = ref('')
const loaded = ref(false)

/** 逐 tab busy:此前单旗全页互斥,任一提交禁所有按钮 */
const busyOf = reactive<Record<Tab, boolean>>({ spec: false, eligibility: false, profile: false, binding: false, runs: false })

interface SpecRow { id: string, version: number, status: string, lineId: string, recipeId: string, contentHash: string, spec?: Record<string, unknown> }
interface ProfileRow { id: string, version: number, name?: string, description?: string, status: string, modelRef: string, solverRef: string, profile?: Record<string, unknown> }
interface BindingRow { id: string, channelId: string, channelAgentId: string, profileVersion: string, mode: string, revision: number }
interface RunRow { id: string, status: string, profileId: string, problemIrHash: string, startedAt: string, recommendation?: { status: string, statusLabel: string, validUntil: string } | null }

const specs = ref<SpecRow[]>([])
const profiles = ref<ProfileRow[]>([])
const bindings = ref<BindingRow[]>([])
const runs = ref<RunRow[]>([])
const eligibility = ref<Record<string, unknown> | null>(null)

const variable = reactive({ id: 'mv1', nodeId: '', role: 'mv' as 'mv' | 'cv' | 'md' | 'feature', unit: '', scale: 1, offset: 0, delayMs: 0, min: 0, max: 100, maxStep: undefined as number | undefined })
const variables = ref<Array<typeof variable>>([])

const specForm = reactive({
  id: '', version: 1, lineId: '', productId: '', recipeId: '', recipeVersion: 0,
  beatMs: 5000, historySteps: 24, horizonSteps: 10,
  trainerRef: 'linear_arx@1' as 'linear_arx@1' | 'static_response@1',
  arOrder: 2, inputOrder: 1, order: 1 as 1 | 2, ridgeLambda: 0.001,
  runIds: '', conditionId: 'default', purpose: 'mpc_surrogate' as 'mpc_surrogate' | 'quality_predict',
})

const profileForm = reactive({ id: '', version: 1, name: '', description: '', modelId: '', template: 'linear_mpc_quadratic@1', solver: 'osqp_mpc@1', processSpecRef: '', configJson: '{\n  "linear_mpc_quadratic": {\n    "cvWeights": {"cv1": 1},\n    "duWeights": {"mv1": 0.1},\n    "terminalWeight": 2,\n    "targets": {"cv1": 50}\n  }\n}' })
const bindingForm = reactive({ workspaceId: '', channelId: '', agentInstanceId: '', profileId: '', profileVersion: 1, mode: 'recommendation' as 'recommendation' | 'shadow' })
const datasetId = ref('')
const solveAgent = ref('')
const solveBinding = ref('')

const pendingVars = computed(() => variables.value.length === 0)

/** 防撞 id:此前硬编码 pms-demo/optp-demo,第二次创建必然撞 key */
function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

function flash(msg: string) {
  notice.value = msg
  setTimeout(() => {
    notice.value = ''
  }, 4000)
}

function fail(err: unknown) {
  error.value = err instanceof Error ? err.message : String(err)
}

/** configJson 行内校验:错误定位到字段旁,不再只进顶部 banner */
const configError = computed<string>(() => {
  try {
    JSON.parse(profileForm.configJson)
    return ''
  }
  catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
})
const configOk = computed(() => configError.value === '')

function addVariable() {
  const v = { ...variable }
  if (!v.nodeId.trim()) {
    error.value = t('optimizer.nodeRequired')
    return
  }
  variables.value.push(v)
  variable.nodeId = ''
}

function buildSpec(): Record<string, unknown> {
  const conditions = [{ id: specForm.conditionId || 'default', match: [{ field: 'recipeId', op: 'eq', value: specForm.recipeId }] }]
  const trainer = specForm.trainerRef === 'linear_arx@1'
    ? { ref: 'linear_arx@1', config: { arOrder: specForm.arOrder, inputOrder: specForm.inputOrder, ridgeLambda: specForm.ridgeLambda, standardize: true } }
    : { ref: 'static_response@1', config: { order: specForm.order, ridgeLambda: specForm.ridgeLambda, standardize: true } }
  const modelInterface = specForm.trainerRef === 'linear_arx@1'
    ? { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' }
    : { id: 'static_response', version: 1, inputSemantics: 'setpoint', mode: 'static' }
  return {
    schemaVersion: 2,
    id: specForm.id,
    version: specForm.version,
    lineId: specForm.lineId,
    productId: specForm.productId,
    recipeId: specForm.recipeId,
    recipeVersion: specForm.recipeVersion,
    conditions,
    variables: variables.value.map(v => ({
      id: v.id, nodeId: v.nodeId, role: v.role, field: 'value',
      unit: v.unit, scale: v.scale, offset: v.offset,
      ...(v.role === 'mv' ? { delayMs: v.delayMs, min: v.min, max: v.max, maxStep: v.maxStep } : {}),
    })),
    timing: { beatMs: specForm.beatMs, historySteps: specForm.historySteps, horizonSteps: specForm.horizonSteps, fixedDt: true },
    trainer,
    datasetPolicy: {
      ...(specForm.runIds.trim() ? { runIds: specForm.runIds.split(',').map(s => s.trim()).filter(Boolean) } : {}),
      split: { valRatio: 0.2, testRatio: 0.2, seed: 42 },
      cleaning: { hampelK: 5 },
    },
    gatePolicyRef: 'process-model.gates@1',
    modelInterface,
    effectiveDomain: {
      mv: Object.fromEntries(variables.value.filter(v => v.role === 'mv').map(v => [v.id, { min: v.min, max: v.max, ...(v.maxStep ? { maxStep: v.maxStep } : {}) }])),
      cv: Object.fromEntries(variables.value.filter(v => v.role === 'cv').map(v => [v.id, { min: v.min, max: v.max }])),
    },
    purpose: specForm.purpose,
  }
}

async function saveSpec() {
  busyOf.spec = true

  error.value = ''
  try {
    const body = buildSpec()
    const res = await processModelApi<{ spec: SpecRow }>('/specs', { method: 'POST', body })
    flash(t('optimizer.specSaved', { id: `${res.spec.id}@${res.spec.version}` }))
    specForm.id = genId('pms')
    await loadAll()
  }
  catch (err) { fail(err) }
  finally { busyOf.spec = false }
}

async function buildDataset() {
  busyOf.spec = true

  error.value = ''
  try {
    const res = await processModelApi<{ datasetId: string, rowCount: number }>('/datasets', { method: 'POST', body: buildSpec() })
    datasetId.value = res.datasetId
    flash(t('optimizer.datasetBuilt', { id: res.datasetId, rows: res.rowCount }))
  }
  catch (err) { fail(err) }
  finally { busyOf.spec = false }
}

async function train() {
  busyOf.spec = true

  error.value = ''
  try {
    if (!datasetId.value) throw new Error(t('optimizer.datasetRequired'))
    const res = await processModelApi<{ job: { id: string } }>('/train', {
      method: 'POST', body: { spec: buildSpec(), datasetId: datasetId.value, modelName: `${specForm.id}@${specForm.version}` },
    })
    flash(t('optimizer.jobSubmitted', { id: res.job.id }))
  }
  catch (err) { fail(err) }
  finally { busyOf.spec = false }
}

async function evaluateEligibility() {
  busyOf.eligibility = true

  error.value = ''
  try {
    if (!datasetId.value) throw new Error(t('optimizer.datasetRequired'))
    const res = await processModelApi<{ report: Record<string, unknown> }>('/eligibility', {
      method: 'POST', body: { specId: specForm.id, specVersion: specForm.version, datasetId: datasetId.value, scope: 'simulation' },
    })
    eligibility.value = res.report
    flash(t('optimizer.eligibilityDone'))
  }
  catch (err) { fail(err) }
  finally { busyOf.eligibility = false }
}

async function saveProfile() {
  if (!configOk.value) return
  busyOf.profile = true

  error.value = ''
  try {
    const profile = {
      schemaVersion: 1, id: profileForm.id, version: profileForm.version,
      name: profileForm.name || undefined, description: profileForm.description || undefined,
      modelRef: { modelId: profileForm.modelId, artifactKind: 'linear_state_space@1', artifactHash: '', modelInterface: 'linear_state_space', stage: 'candidate' },
      problemTemplateRef: profileForm.template, problemConfig: JSON.parse(profileForm.configJson),
      solverRef: profileForm.solver, solverVersion: '1', processSpecRef: profileForm.processSpecRef || `${specForm.id}@${specForm.version}`,
      conditionIds: [], status: 'draft',
    }
    await optimizerApi('/optimization/profiles', { method: 'POST', body: profile })
    flash(t('optimizer.profileSaved'))
    profileForm.id = genId('optp')
    await loadAll()
  }
  catch (err) { fail(err) }
  finally { busyOf.profile = false }
}

async function publishProfile(id: string, version: number) {
  busyOf.profile = true

  error.value = ''
  try {
    await optimizerApi(`/optimization/profiles/${encodeURIComponent(id)}/publish?version=${version}`, { method: 'POST' })
    flash(t('optimizer.profilePublished'))
    await loadAll()
  }
  catch (err) { fail(err) }
  finally { busyOf.profile = false }
}

async function createBinding() {
  busyOf.binding = true

  error.value = ''
  try {
    await optimizerApi('/optimization/bindings', { method: 'POST', body: { ...bindingForm } })
    flash(t('optimizer.bindingCreated'))
    await loadAll()
  }
  catch (err) { fail(err) }
  finally { busyOf.binding = false }
}

async function revokeBinding(id: string) {
  busyOf.binding = true

  error.value = ''
  try {
    await optimizerApi(`/optimization/bindings/${encodeURIComponent(id)}`, { method: 'DELETE' })
    flash(t('optimizer.bindingRevoked'))
    await loadAll()
  }
  catch (err) { fail(err) }
  finally { busyOf.binding = false }
}

async function runSolve() {
  busyOf.runs = true

  error.value = ''
  try {
    await optimizerApi('/optimization/solve', {
      method: 'POST', body: { agentInstanceId: solveAgent.value, ...(solveBinding.value ? { bindingId: solveBinding.value } : {}) },
    })
    flash(t('optimizer.solveDone'))
    await loadAll()
  }
  catch (err) { fail(err) }
  finally { busyOf.runs = false }
}

async function loadAll() {
  try {
    const [s, p, b, r] = await Promise.all([
      processModelApi<{ specs: SpecRow[] }>('/specs'),
      optimizerApi<{ profiles: ProfileRow[] }>('/optimization/profiles'),
      optimizerApi<{ bindings: BindingRow[] }>('/optimization/bindings'),
      optimizerApi<{ runs: RunRow[] }>('/optimization/runs'),
    ])
    specs.value = s.specs
    profiles.value = p.profiles
    bindings.value = b.bindings
    runs.value = r.runs
  }
  catch (err) { fail(err) }
  finally { loaded.value = true }
}

onMounted(() => {
  specForm.id = genId('pms')
  profileForm.id = genId('optp')
  void loadAll()
})
</script>

<template>
  <div class="optimizer-page">
    <div class="aw-page-head">
      <p class="aw-kicker">
        {{ t('optimizer.kicker') }}
      </p>
      <h1>{{ t('menu.optimizer') }}</h1>
      <p class="sub">
        {{ t('optimizer.subtitle') }}
      </p>
      <span class="aw-stamp">{{ t('optimizer.recommendationOnly') }}</span>
    </div>

    <!-- 治理流步骤条:spec → dataset/train → eligibility → profile → binding → runs -->
    <a-steps
      :current="TABS.indexOf(tab)"
      size="small"
      class="flow-steps"
      @change="(i: number) => tab = TABS[i]!"
    >
      <a-step
        v-for="item in TABS"
        :key="item"
        :title="t(`optimizer.tab.${item}`)"
      />
    </a-steps>

    <div
      v-if="error"
      class="banner error"
      role="alert"
    >
      {{ error }}
    </div>
    <div
      v-if="notice"
      class="banner ok"
    >
      {{ notice }}
    </div>

    <AwStateBlock
      v-if="!loaded"
      state="loading"
    />

    <template v-else>
      <!-- ── 模型规格 ─────────────────────────────── -->
      <section
        v-if="tab === 'spec'"
        class="aw-tile panel"
      >
        <h2>{{ t('optimizer.spec.title') }}</h2>
        <div class="grid">
          <label>id<a-input
            v-model:value="specForm.id"
            size="small"
          /></label>
          <label>{{ t('optimizer.fields.line') }}<a-input
            v-model:value="specForm.lineId"
            size="small"
            placeholder="ln-..."
          /></label>
          <label>{{ t('optimizer.fields.product') }}<a-input
            v-model:value="specForm.productId"
            size="small"
            placeholder="pd-..."
          /></label>
          <label>{{ t('optimizer.fields.recipe') }}<a-input
            v-model:value="specForm.recipeId"
            size="small"
            placeholder="rc-..."
          /></label>
          <label>{{ t('optimizer.fields.recipeVersion') }}<a-input-number
            v-model:value="specForm.recipeVersion"
            size="small"
            :min="0"
            class="w-full"
          /></label>
          <label>{{ t('optimizer.fields.beat') }}<a-input-number
            v-model:value="specForm.beatMs"
            size="small"
            :min="1000"
            :step="1000"
            class="w-full"
          /></label>
          <label>{{ t('optimizer.fields.history') }}<a-input-number
            v-model:value="specForm.historySteps"
            size="small"
            :min="1"
            class="w-full"
          /></label>
          <label>{{ t('optimizer.fields.horizon') }}<a-input-number
            v-model:value="specForm.horizonSteps"
            size="small"
            :min="1"
            class="w-full"
          /></label>
          <label>{{ t('optimizer.fields.trainer') }}<a-select
            v-model:value="specForm.trainerRef"
            size="small"
            :options="[
              { value: 'linear_arx@1', label: 'linear_arx@1' },
              { value: 'static_response@1', label: 'static_response@1' },
            ]"
          /></label>
          <label
            v-if="specForm.trainerRef === 'linear_arx@1'"
          >{{ t('optimizer.fields.arOrder') }}<a-input-number
            v-model:value="specForm.arOrder"
            size="small"
            :min="1"
            class="w-full"
          /></label>
          <label
            v-if="specForm.trainerRef === 'linear_arx@1'"
          >{{ t('optimizer.fields.inputOrder') }}<a-input-number
            v-model:value="specForm.inputOrder"
            size="small"
            :min="1"
            class="w-full"
          /></label>
          <label v-else>{{ t('optimizer.fields.order') }}<a-select
            v-model:value="specForm.order"
            size="small"
            :options="[{ value: 1, label: '1' }, { value: 2, label: '2' }]"
          /></label>
          <label>{{ t('optimizer.fields.runIds') }}<a-input
            v-model:value="specForm.runIds"
            size="small"
            placeholder="rr-...,rr-..."
          /></label>
        </div>

        <h3>{{ t('optimizer.spec.variables') }}</h3>
        <p class="hint">
          {{ t('optimizer.spec.modelUnitsHint') }}
        </p>
        <div class="grid var-row">
          <label>{{ t('optimizer.fields.varId') }}<a-input
            v-model:value="variable.id"
            size="small"
          /></label>
          <label>{{ t('optimizer.fields.nodeId') }}<a-input
            v-model:value="variable.nodeId"
            size="small"
            placeholder="node-..."
          /></label>
          <label>{{ t('optimizer.fields.role') }}<a-select
            v-model:value="variable.role"
            size="small"
            :options="[
              { value: 'mv', label: 'mv' }, { value: 'cv', label: 'cv' },
              { value: 'md', label: 'md' }, { value: 'feature', label: 'feature' },
            ]"
          /></label>
          <label>{{ t('optimizer.fields.unit') }}<a-input
            v-model:value="variable.unit"
            size="small"
            placeholder="μm / ℃ / bar"
          /></label>
          <label>{{ t('optimizer.fields.scale') }}<a-input-number
            v-model:value="variable.scale"
            size="small"
            :step="0.1"
            class="w-full"
          /></label>
          <label>{{ t('optimizer.fields.offset') }}<a-input-number
            v-model:value="variable.offset"
            size="small"
            :step="0.1"
            class="w-full"
          /></label>
          <label v-if="variable.role === 'mv'">{{ t('optimizer.fields.delayMs') }}<a-input-number
            v-model:value="variable.delayMs"
            size="small"
            :min="0"
            class="w-full"
          /></label>
          <label>{{ t('optimizer.fields.min') }}<a-input-number
            v-model:value="variable.min"
            size="small"
            :step="0.1"
            class="w-full"
          /></label>
          <label>{{ t('optimizer.fields.max') }}<a-input-number
            v-model:value="variable.max"
            size="small"
            :step="0.1"
            class="w-full"
          /></label>
          <label v-if="variable.role === 'mv'">{{ t('optimizer.fields.maxStep') }}<a-input-number
            v-model:value="variable.maxStep"
            size="small"
            :step="0.1"
            class="w-full"
          /></label>
          <a-button
            size="small"
            :disabled="busyOf.spec"
            @click="addVariable"
          >
            {{ t('optimizer.spec.addVariable') }}
          </a-button>
        </div>
        <table class="tbl">
          <thead><tr><th>id</th><th>node</th><th>role</th><th>unit</th><th>delay</th><th>range</th><th /></tr></thead>
          <tbody>
            <tr
              v-for="(v, i) in variables"
              :key="`${v.id}-${i}`"
            >
              <td>{{ v.id }}</td><td class="mono">
                {{ v.nodeId }}
              </td><td>{{ v.role }}</td><td>{{ v.unit }}</td>
              <td>{{ v.role === 'mv' ? `${v.delayMs}ms` : '—' }}</td><td class="mono">
                {{ v.min }} … {{ v.max }}
              </td>
              <td>
                <a-button
                  size="small"
                  danger
                  type="text"
                  @click="variables.splice(i, 1)"
                >
                  {{ t('optimizer.remove') }}
                </a-button>
              </td>
            </tr>
          </tbody>
        </table>
        <p
          v-if="pendingVars"
          class="hint warn-hint"
        >
          {{ t('optimizer.spec.needVariables') }}
        </p>
        <div class="actions">
          <a-button
            type="primary"
            size="small"
            :loading="busyOf.spec"
            @click="saveSpec"
          >
            {{ t('optimizer.spec.save') }}
          </a-button>
          <a-button
            size="small"
            :loading="busyOf.spec"
            @click="buildDataset"
          >
            {{ t('optimizer.spec.buildDataset') }}
          </a-button>
          <a-button
            size="small"
            :loading="busyOf.spec"
            @click="train"
          >
            {{ t('optimizer.spec.train') }}
          </a-button>
        </div>
        <p class="hint">
          {{ t('optimizer.currentDataset') }}: <code>{{ datasetId || '—' }}</code>
        </p>
        <ul class="list">
          <li
            v-for="s in specs.slice(0, 20)"
            :key="`${s.id}@${s.version}`"
          >
            <code>{{ s.id }}@{{ s.version }}</code> · {{ s.status }} · {{ s.lineId }} / {{ s.recipeId }} <span class="mono dim">{{ s.contentHash?.slice(0, 10) }}</span>
          </li>
        </ul>
      </section>

      <!-- ── 资格报告 ─────────────────────────────── -->
      <section
        v-if="tab === 'eligibility'"
        class="aw-tile panel"
      >
        <h2>{{ t('optimizer.eligibility.title') }}</h2>
        <div class="actions">
          <a-button
            type="primary"
            size="small"
            :loading="busyOf.eligibility"
            @click="evaluateEligibility"
          >
            {{ t('optimizer.eligibility.evaluate') }}
          </a-button>
        </div>
        <template v-if="eligibility">
          <p>
            <strong :class="(eligibility.optimizationEligible as boolean) ? 'ok-text' : 'warn-hint'">{{ (eligibility.optimizationEligible as boolean) ? t('optimizer.eligibility.yes') : t('optimizer.eligibility.no') }}</strong>
            · scope={{ eligibility.scope }} · {{ eligibility.evidenceVersion }}
          </p>
          <ul class="list">
            <li
              v-for="(gap, i) in (eligibility.gaps as Array<{ code: string, message: string }>) || []"
              :key="i"
              class="gap"
            >
              <code>{{ gap.code }}</code> {{ gap.message }}
            </li>
          </ul>
          <pre class="json">{{ JSON.stringify(eligibility.metrics, null, 2) }}</pre>
        </template>
        <AwStateBlock
          v-else
          state="empty"
          :title="t('optimizer.eligibility.empty')"
          compact
        />
      </section>

      <!-- ── Profile / Solver ─────────────────────── -->
      <section
        v-if="tab === 'profile'"
        class="aw-tile panel"
      >
        <h2>{{ t('optimizer.profile.title') }}</h2>
        <div class="grid">
          <label>id<a-input
            v-model:value="profileForm.id"
            size="small"
          /></label>
          <label>version<a-input-number
            v-model:value="profileForm.version"
            size="small"
            :min="1"
            class="w-full"
          /></label>
          <label>{{ t('optimizer.fields.name') }}<a-input
            v-model:value="profileForm.name"
            size="small"
            placeholder="膜厚闭环-MPC 配置"
          /></label>
          <label
            class="block"
          >{{ t('optimizer.fields.description') }}<a-input
            v-model:value="profileForm.description"
            size="small"
            placeholder="这个求解配置代表什么工况/目标/约束(用户与 Agent 都看这段)"
          /></label>
          <label>{{ t('optimizer.fields.model') }}<a-input
            v-model:value="profileForm.modelId"
            size="small"
            placeholder="mdl-..."
          /></label>
          <label>{{ t('optimizer.fields.template') }}<a-select
            v-model:value="profileForm.template"
            size="small"
            :options="[
              { value: 'linear_mpc_quadratic@1', label: 'linear_mpc_quadratic@1' },
              { value: 'steady_response@1', label: 'steady_response@1' },
            ]"
          /></label>
          <label>{{ t('optimizer.fields.solver') }}<a-select
            v-model:value="profileForm.solver"
            size="small"
            :options="[
              { value: 'osqp_mpc@1', label: 'osqp_mpc@1' },
              { value: 'scipy_slsqp@1', label: 'scipy_slsqp@1' },
            ]"
          /></label>
          <label>processSpecRef<a-input
            v-model:value="profileForm.processSpecRef"
            size="small"
            placeholder="pms@1"
          /></label>
        </div>
        <label class="block json-label">{{ t('optimizer.profile.config') }}<textarea
          v-model="profileForm.configJson"
          rows="10"
          class="json-input"
          :class="{ invalid: !configOk }"
          spellcheck="false"
        /></label>
        <p
          v-if="!configOk"
          class="field-error"
          role="alert"
        >
          JSON: {{ configError }}
        </p>
        <p class="hint">
          {{ t('optimizer.profile.configHint') }}
        </p>
        <div class="actions">
          <a-button
            type="primary"
            size="small"
            :loading="busyOf.profile"
            :disabled="!configOk"
            @click="saveProfile"
          >
            {{ t('optimizer.profile.save') }}
          </a-button>
        </div>
        <a-table
          size="small"
          :data-source="profiles"
          :row-key="(p: ProfileRow) => `${p.id}@${p.version}`"
          :pagination="{ pageSize: 10, hideOnSinglePage: true }"
          :columns="[
            { title: 'profile', dataIndex: ['id'], key: 'id', width: 170 },
            { title: t('optimizer.fields.name'), key: 'name' },
            { title: t('optimizer.fields.description'), key: 'desc', ellipsis: true },
            { title: 'status', dataIndex: 'status', key: 'status', width: 100 },
            { title: 'solver', dataIndex: 'solverRef', key: 'solver', width: 150 },
            { title: '', key: 'op', width: 90 },
          ]"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'id'">
              {{ (record as ProfileRow).id }}@{{ (record as ProfileRow).version }}
            </template>
            <template v-else-if="column.key === 'name'">
              {{ (record as ProfileRow).profile?.name || (record as ProfileRow).name || '--' }}
            </template>
            <template v-else-if="column.key === 'desc'">
              {{ (record as ProfileRow).profile?.description || (record as ProfileRow).description || '--' }}
            </template>
            <template v-else-if="column.key === 'op'">
              <!-- 发布 = 治理态变更:二次确认(交互宪法 §2-1) -->
              <a-popconfirm
                v-if="(record as ProfileRow).status !== 'published'"
                :title="t('optimizer.publishConfirm')"
                :ok-text="t('optimizer.publish')"
                :cancel-text="t('common.cancel')"
                placement="left"
                @confirm="publishProfile((record as ProfileRow).id, (record as ProfileRow).version)"
              >
                <a-button
                  size="small"
                  type="text"
                  :loading="busyOf.profile"
                >
                  {{ t('optimizer.publish') }}
                </a-button>
              </a-popconfirm>
            </template>
          </template>
        </a-table>
      </section>

      <!-- ── Agent 绑定 ───────────────────────────── -->
      <section
        v-if="tab === 'binding'"
        class="aw-tile panel"
      >
        <h2>{{ t('optimizer.binding.title') }}</h2>
        <div class="grid">
          <label>workspaceId<a-input
            v-model:value="bindingForm.workspaceId"
            size="small"
          /></label>
          <label>channelId<a-input
            v-model:value="bindingForm.channelId"
            size="small"
          /></label>
          <label>{{ t('optimizer.fields.agentInstance') }}<a-input
            v-model:value="bindingForm.agentInstanceId"
            size="small"
            placeholder="channel_agents.id"
          /></label>
          <label>profileId<a-input
            v-model:value="bindingForm.profileId"
            size="small"
          /></label>
          <label>profileVersion<a-input-number
            v-model:value="bindingForm.profileVersion"
            size="small"
            :min="1"
            class="w-full"
          /></label>
          <label>mode<a-select
            v-model:value="bindingForm.mode"
            size="small"
            :options="[{ value: 'recommendation', label: 'recommendation' }, { value: 'shadow', label: 'shadow' }]"
          /></label>
        </div>
        <p class="hint">
          {{ t('optimizer.binding.identityHint') }}
        </p>
        <div class="actions">
          <a-button
            type="primary"
            size="small"
            :loading="busyOf.binding"
            @click="createBinding"
          >
            {{ t('optimizer.binding.create') }}
          </a-button>
        </div>
        <a-table
          size="small"
          :data-source="bindings"
          :row-key="(b: BindingRow) => b.id"
          :pagination="{ pageSize: 10, hideOnSinglePage: true }"
          :columns="[
            { title: 'id', dataIndex: 'id', key: 'id' },
            { title: 'channel', dataIndex: 'channelId', key: 'channel', width: 190 },
            { title: 'agent', dataIndex: 'channelAgentId', key: 'agent', width: 190 },
            { title: 'profile', dataIndex: 'profileVersion', key: 'profile', width: 110 },
            { title: 'mode', dataIndex: 'mode', key: 'mode', width: 130 },
            { title: 'rev', dataIndex: 'revision', key: 'rev', width: 60 },
            { title: '', key: 'op', width: 90 },
          ]"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'op'">
              <!-- 吊销绑定 = Agent 失去优化建议通道:二次确认(交互宪法 §2-1) -->
              <a-popconfirm
                :title="t('optimizer.revokeConfirm')"
                :ok-text="t('optimizer.binding.revoke')"
                :cancel-text="t('common.cancel')"
                :ok-button-props="{ danger: true }"
                placement="left"
                @confirm="revokeBinding((record as BindingRow).id)"
              >
                <a-button
                  size="small"
                  type="text"
                  danger
                  :loading="busyOf.binding"
                >
                  {{ t('optimizer.binding.revoke') }}
                </a-button>
              </a-popconfirm>
            </template>
          </template>
        </a-table>
      </section>

      <!-- ── 运行 / 建议 ──────────────────────────── -->
      <section
        v-if="tab === 'runs'"
        class="aw-tile panel"
      >
        <h2>{{ t('optimizer.runs.title') }}</h2>
        <div class="grid">
          <label>{{ t('optimizer.fields.agentInstance') }}<a-input
            v-model:value="solveAgent"
            size="small"
          /></label>
          <label>bindingId ({{ t('optimizer.optional') }})<a-input
            v-model:value="solveBinding"
            size="small"
          /></label>
        </div>
        <div class="actions">
          <a-button
            type="primary"
            size="small"
            :loading="busyOf.runs"
            @click="runSolve"
          >
            {{ t('optimizer.runs.solve') }}
          </a-button>
        </div>
        <a-table
          size="small"
          :data-source="runs"
          :row-key="(r: RunRow) => r.id"
          :pagination="{ pageSize: 12, hideOnSinglePage: true }"
          :columns="[
            { title: 'run', dataIndex: 'id', key: 'id' },
            { title: 'status', dataIndex: 'status', key: 'status', width: 100 },
            { title: 'profile', dataIndex: 'profileId', key: 'profile', width: 150 },
            { title: 'IR hash', key: 'ir', width: 120 },
            { title: t('optimizer.runs.recommendation'), key: 'rec' },
            { title: 'validUntil', key: 'valid', width: 180 },
          ]"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'ir'">
              <span class="mono">{{ (record as RunRow).problemIrHash?.slice(0, 10) }}</span>
            </template>
            <template v-else-if="column.key === 'rec'">
              <span :class="{ unverified: (record as RunRow).recommendation?.status === 'unverified' }">
                {{ (record as RunRow).recommendation?.statusLabel ?? '—' }}
              </span>
            </template>
            <template v-else-if="column.key === 'valid'">
              {{ (record as RunRow).recommendation?.validUntil ?? '—' }}
            </template>
          </template>
        </a-table>
        <p class="hint">
          {{ t('optimizer.runs.zeroWrite') }}
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* 全令牌样式:此前 GitHub-Dark 硬编码(#0d1117/#e6edf3 等)在亮色下不可读,已全部清除 */
.optimizer-page { padding: 24px 32px 64px; color: var(--ink); }
.sub { color: var(--ink-soft); margin: 4px 0 8px; }
.flow-steps { margin: 18px 0 6px; }
.banner { padding: 10px 14px; border-radius: 8px; margin: 12px 0; font-size: 13px; }
.banner.error { background: var(--tone-danger-bg); border: 1px solid color-mix(in srgb, var(--tone-danger-dot) 40%, transparent); color: var(--tone-danger-dot); }
.banner.ok { background: var(--tone-success-bg); border: 1px solid color-mix(in srgb, var(--tone-success-dot) 40%, transparent); color: var(--tone-success-dot); }
.panel { padding: 18px 20px; margin-bottom: 18px; }
.panel h2 { font-size: 15px; letter-spacing: .04em; margin: 0 0 14px; text-transform: uppercase; color: var(--ink-soft); }
.panel h3 { font-size: 13px; color: var(--ink-soft); margin: 18px 0 10px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px 14px; margin-bottom: 12px; }
.grid label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--ink-soft); }
label.block { margin-top: 10px; }
.w-full { width: 100%; }
.json-label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--ink-soft); margin-top: 10px; }
.json-input {
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  padding: 10px 12px;
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 12.5px;
  resize: vertical;
}
.json-input:focus { outline: none; border-color: var(--accent); }
.json-input.invalid { border-color: var(--tone-danger-dot); }
.field-error { color: var(--tone-danger-dot); font-size: 12px; margin: 6px 0 0; }
.actions { display: flex; gap: 10px; margin: 14px 0; flex-wrap: wrap; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tbl th, .tbl td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); }
.tbl th { color: var(--ink-faint); font-weight: 500; }
.list { list-style: none; padding: 0; margin: 10px 0; display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; }
.list .gap { color: var(--accent-amber); }
.hint { color: var(--ink-faint); font-size: 12.5px; }
.warn-hint { color: var(--accent-amber); }
.ok-text { color: var(--tone-success-dot); }
.dim { color: var(--ink-faint); }
pre.json { background: var(--paper-deep); border: 1px solid var(--line); border-radius: 8px; padding: 12px; font-size: 12px; overflow: auto; color: var(--ink); }
textarea, pre, code, .mono { font-family: var(--font-mono); }
.unverified { color: var(--accent-amber); font-weight: 600; }
/* a-steps 在暗阶下的令牌适配 */
.flow-steps :deep(.ant-steps-item-title) { color: var(--ink-soft) !important; font-size: 13px !important; }
.flow-steps :deep(.ant-steps-item-wait .ant-steps-item-title) { color: var(--ink-faint) !important; }
</style>
