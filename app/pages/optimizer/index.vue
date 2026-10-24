<script setup lang="ts">
/* eslint-disable @stylistic/max-statements-per-line */
/**
 * Optimizer Manager —— 场景/变量/工况 → 数据集 → 训练 → Profile → 绑定 → 求解 → 建议。
 * 与 Agent 工具共用同一 REST/服务层;本页不写设备,只产出建议。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { optimizerApi, processModelApi } from './api'

definePageMeta({ layout: 'default' })
const { t } = useI18n()
useHead({ title: () => t('menu.optimizer') })

type Tab = 'spec' | 'eligibility' | 'profile' | 'binding' | 'runs'
const tab = ref<Tab>('spec')
const error = ref('')
const notice = ref('')
const busy = ref(false)

interface SpecRow { id: string, version: number, status: string, lineId: string, recipeId: string, contentHash: string, spec?: Record<string, unknown> }
interface ProfileRow { id: string, version: number, status: string, modelRef: string, solverRef: string, profile?: Record<string, unknown> }
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
  id: 'pms-demo', version: 1, lineId: '', productId: '', recipeId: '', recipeVersion: 0,
  beatMs: 5000, historySteps: 24, horizonSteps: 10,
  trainerRef: 'linear_arx@1' as 'linear_arx@1' | 'static_response@1',
  arOrder: 2, inputOrder: 1, order: 1 as 1 | 2, ridgeLambda: 0.001,
  runIds: '', conditionId: 'default', purpose: 'mpc_surrogate' as 'mpc_surrogate' | 'quality_predict',
})

const profileForm = reactive({ id: 'optp-demo', version: 1, modelId: '', template: 'linear_mpc_quadratic@1', solver: 'osqp_mpc@1', processSpecRef: '', configJson: '{\n  "linear_mpc_quadratic": {\n    "cvWeights": {"cv1": 1},\n    "duWeights": {"mv1": 0.1},\n    "terminalWeight": 2,\n    "targets": {"cv1": 50}\n  }\n}' })
const bindingForm = reactive({ workspaceId: '', channelId: '', agentInstanceId: '', profileId: '', profileVersion: 1, mode: 'recommendation' as 'recommendation' | 'shadow' })
const datasetId = ref('')
const solveAgent = ref('')
const solveBinding = ref('')

const pendingVars = computed(() => variables.value.length === 0)

function flash(message: string) { notice.value = message; setTimeout(() => { notice.value = '' }, 4000) }
function fail(err: unknown) { error.value = err instanceof Error ? err.message : String(err) }

function addVariable() {
  const v = { ...variable }
  if (!v.nodeId.trim()) { error.value = t('optimizer.nodeRequired'); return }
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
  busy.value = true; error.value = ''
  try {
    const body = buildSpec()
    const res = await processModelApi<{ spec: SpecRow }>('/specs', { method: 'POST', body })
    flash(t('optimizer.specSaved', { id: `${res.spec.id}@${res.spec.version}` }))
    await loadAll()
  }
  catch (err) { fail(err) }
  finally { busy.value = false }
}

async function buildDataset() {
  busy.value = true; error.value = ''
  try {
    const res = await processModelApi<{ datasetId: string, rowCount: number }>('/datasets', { method: 'POST', body: buildSpec() })
    datasetId.value = res.datasetId
    flash(t('optimizer.datasetBuilt', { id: res.datasetId, rows: res.rowCount }))
  }
  catch (err) { fail(err) }
  finally { busy.value = false }
}

async function train() {
  busy.value = true; error.value = ''
  try {
    if (!datasetId.value) throw new Error(t('optimizer.datasetRequired'))
    const res = await processModelApi<{ job: { id: string } }>('/train', {
      method: 'POST', body: { spec: buildSpec(), datasetId: datasetId.value, modelName: `${specForm.id}@${specForm.version}` },
    })
    flash(t('optimizer.jobSubmitted', { id: res.job.id }))
  }
  catch (err) { fail(err) }
  finally { busy.value = false }
}

async function evaluateEligibility() {
  busy.value = true; error.value = ''
  try {
    if (!datasetId.value) throw new Error(t('optimizer.datasetRequired'))
    const res = await processModelApi<{ report: Record<string, unknown> }>('/eligibility', {
      method: 'POST', body: { specId: specForm.id, specVersion: specForm.version, datasetId: datasetId.value, scope: 'simulation' },
    })
    eligibility.value = res.report
    flash(t('optimizer.eligibilityDone'))
  }
  catch (err) { fail(err) }
  finally { busy.value = false }
}

async function saveProfile() {
  busy.value = true; error.value = ''
  try {
    const profile = {
      schemaVersion: 1, id: profileForm.id, version: profileForm.version,
      modelRef: { modelId: profileForm.modelId, artifactKind: 'linear_state_space@1', artifactHash: '', modelInterface: 'linear_state_space', stage: 'candidate' },
      problemTemplateRef: profileForm.template, problemConfig: JSON.parse(profileForm.configJson),
      solverRef: profileForm.solver, solverVersion: '1', processSpecRef: profileForm.processSpecRef || `${specForm.id}@${specForm.version}`,
      conditionIds: [], status: 'draft',
    }
    await optimizerApi('/optimization/profiles', { method: 'POST', body: profile })
    flash(t('optimizer.profileSaved'))
    await loadAll()
  }
  catch (err) { fail(err) }
  finally { busy.value = false }
}

async function publishProfile(id: string, version: number) {
  busy.value = true; error.value = ''
  try {
    await optimizerApi(`/optimization/profiles/${encodeURIComponent(id)}/publish?version=${version}`, { method: 'POST' })
    flash(t('optimizer.profilePublished'))
    await loadAll()
  }
  catch (err) { fail(err) }
  finally { busy.value = false }
}

async function createBinding() {
  busy.value = true; error.value = ''
  try {
    await optimizerApi('/optimization/bindings', { method: 'POST', body: { ...bindingForm } })
    flash(t('optimizer.bindingCreated'))
    await loadAll()
  }
  catch (err) { fail(err) }
  finally { busy.value = false }
}

async function revokeBinding(id: string) {
  busy.value = true; error.value = ''
  try {
    await optimizerApi(`/optimization/bindings/${encodeURIComponent(id)}`, { method: 'DELETE' })
    flash(t('optimizer.bindingRevoked'))
    await loadAll()
  }
  catch (err) { fail(err) }
  finally { busy.value = false }
}

async function runSolve() {
  busy.value = true; error.value = ''
  try {
    await optimizerApi('/optimization/solve', {
      method: 'POST', body: { agentInstanceId: solveAgent.value, ...(solveBinding.value ? { bindingId: solveBinding.value } : {}) },
    })
    flash(t('optimizer.solveDone'))
    await loadAll()
  }
  catch (err) { fail(err) }
  finally { busy.value = false }
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
}

onMounted(loadAll)
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

    <div
      v-if="error"
      class="banner error"
    >
      {{ error }}
    </div>
    <div
      v-if="notice"
      class="banner ok"
    >
      {{ notice }}
    </div>

    <nav class="tabs">
      <button
        v-for="item in ['spec', 'eligibility', 'profile', 'binding', 'runs']"
        :key="item"
        class="pill-btn"
        :class="{ active: tab === item }"
        @click="tab = item as Tab"
      >
        {{ t(`optimizer.tab.${item}`) }}
      </button>
    </nav>

    <section
      v-if="tab === 'spec'"
      class="panel"
    >
      <h2>{{ t('optimizer.spec.title') }}</h2>
      <div class="grid">
        <label>{{ t('optimizer.fields.line') }}<input
          v-model="specForm.lineId"
          placeholder="ln-..."
        ></label>
        <label>{{ t('optimizer.fields.product') }}<input
          v-model="specForm.productId"
          placeholder="pd-..."
        ></label>
        <label>{{ t('optimizer.fields.recipe') }}<input
          v-model="specForm.recipeId"
          placeholder="rc-..."
        ></label>
        <label>{{ t('optimizer.fields.recipeVersion') }}<input
          v-model.number="specForm.recipeVersion"
          type="number"
          min="0"
        ></label>
        <label>{{ t('optimizer.fields.beat') }}<input
          v-model.number="specForm.beatMs"
          type="number"
          min="1000"
          step="1000"
        ></label>
        <label>{{ t('optimizer.fields.history') }}<input
          v-model.number="specForm.historySteps"
          type="number"
          min="1"
        ></label>
        <label>{{ t('optimizer.fields.horizon') }}<input
          v-model.number="specForm.horizonSteps"
          type="number"
          min="1"
        ></label>
        <label>{{ t('optimizer.fields.trainer') }}
          <select v-model="specForm.trainerRef">
            <option value="linear_arx@1">linear_arx@1</option>
            <option value="static_response@1">static_response@1</option>
          </select>
        </label>
        <label v-if="specForm.trainerRef === 'linear_arx@1'">{{ t('optimizer.fields.arOrder') }}<input
          v-model.number="specForm.arOrder"
          type="number"
          min="1"
        ></label>
        <label v-if="specForm.trainerRef === 'linear_arx@1'">{{ t('optimizer.fields.inputOrder') }}<input
          v-model.number="specForm.inputOrder"
          type="number"
          min="1"
        ></label>
        <label v-else>{{ t('optimizer.fields.order') }}<select v-model.number="specForm.order"><option :value="1">1</option><option :value="2">2</option></select></label>
        <label>{{ t('optimizer.fields.runIds') }}<input
          v-model="specForm.runIds"
          placeholder="rr-...,rr-..."
        ></label>
      </div>

      <h3>{{ t('optimizer.spec.variables') }}</h3>
      <p class="hint">
        {{ t('optimizer.spec.modelUnitsHint') }}
      </p>
      <div class="grid var-row">
        <label>{{ t('optimizer.fields.varId') }}<input v-model="variable.id"></label>
        <label>{{ t('optimizer.fields.nodeId') }}<input
          v-model="variable.nodeId"
          placeholder="node-..."
        ></label>
        <label>{{ t('optimizer.fields.role') }}<select v-model="variable.role"><option value="mv">mv</option><option value="cv">cv</option><option value="md">md</option><option value="feature">feature</option></select></label>
        <label>{{ t('optimizer.fields.unit') }}<input
          v-model="variable.unit"
          placeholder="μm / ℃ / bar"
        ></label>
        <label>{{ t('optimizer.fields.scale') }}<input
          v-model.number="variable.scale"
          type="number"
          step="any"
        ></label>
        <label>{{ t('optimizer.fields.offset') }}<input
          v-model.number="variable.offset"
          type="number"
          step="any"
        ></label>
        <label v-if="variable.role === 'mv'">{{ t('optimizer.fields.delayMs') }}<input
          v-model.number="variable.delayMs"
          type="number"
          min="0"
        ></label>
        <label>{{ t('optimizer.fields.min') }}<input
          v-model.number="variable.min"
          type="number"
          step="any"
        ></label>
        <label>{{ t('optimizer.fields.max') }}<input
          v-model.number="variable.max"
          type="number"
          step="any"
        ></label>
        <label v-if="variable.role === 'mv'">{{ t('optimizer.fields.maxStep') }}<input
          v-model.number="variable.maxStep"
          type="number"
          step="any"
        ></label>
        <button
          class="ghost-btn"
          @click="addVariable"
        >
          {{ t('optimizer.spec.addVariable') }}
        </button>
      </div>
      <table class="tbl">
        <thead><tr><th>id</th><th>node</th><th>role</th><th>unit</th><th>delay</th><th>range</th><th /></tr></thead>
        <tbody>
          <tr
            v-for="(v, i) in variables"
            :key="`${v.id}-${i}`"
          >
            <td>{{ v.id }}</td><td>{{ v.nodeId }}</td><td>{{ v.role }}</td><td>{{ v.unit }}</td>
            <td>{{ v.role === 'mv' ? `${v.delayMs}ms` : '—' }}</td><td>{{ v.min }} … {{ v.max }}</td>
            <td>
              <button
                class="mini-btn"
                @click="variables.splice(i, 1)"
              >
                {{ t('optimizer.remove') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p
        v-if="pendingVars"
        class="hint"
      >
        {{ t('optimizer.spec.needVariables') }}
      </p>
      <div class="actions">
        <button
          class="pill-btn"
          :disabled="busy"
          @click="saveSpec"
        >
          {{ t('optimizer.spec.save') }}
        </button>
        <button
          class="pill-btn"
          :disabled="busy"
          @click="buildDataset"
        >
          {{ t('optimizer.spec.buildDataset') }}
        </button>
        <button
          class="pill-btn"
          :disabled="busy"
          @click="train"
        >
          {{ t('optimizer.spec.train') }}
        </button>
      </div>
      <p class="hint">
        {{ t('optimizer.currentDataset') }}: {{ datasetId || '—' }}
      </p>
      <ul class="list">
        <li
          v-for="s in specs"
          :key="`${s.id}@${s.version}`"
        >
          <code>{{ s.id }}@{{ s.version }}</code> · {{ s.status }} · {{ s.lineId }} / {{ s.recipeId }} <span class="mono">{{ s.contentHash?.slice(0, 10) }}</span>
        </li>
      </ul>
    </section>

    <section
      v-if="tab === 'eligibility'"
      class="panel"
    >
      <h2>{{ t('optimizer.eligibility.title') }}</h2>
      <div class="actions">
        <button
          class="pill-btn"
          :disabled="busy"
          @click="evaluateEligibility"
        >
          {{ t('optimizer.eligibility.evaluate') }}
        </button>
      </div>
      <template v-if="eligibility">
        <p>
          <strong>{{ (eligibility.optimizationEligible as boolean) ? t('optimizer.eligibility.yes') : t('optimizer.eligibility.no') }}</strong>
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
      <p
        v-else
        class="hint"
      >
        {{ t('optimizer.eligibility.empty') }}
      </p>
    </section>

    <section
      v-if="tab === 'profile'"
      class="panel"
    >
      <h2>{{ t('optimizer.profile.title') }}</h2>
      <div class="grid">
        <label>id<input v-model="profileForm.id"></label>
        <label>version<input
          v-model.number="profileForm.version"
          type="number"
          min="1"
        ></label>
        <label>{{ t('optimizer.fields.model') }}<input
          v-model="profileForm.modelId"
          placeholder="mdl-..."
        ></label>
        <label>{{ t('optimizer.fields.template') }}<select v-model="profileForm.template"><option value="linear_mpc_quadratic@1">linear_mpc_quadratic@1</option><option value="steady_response@1">steady_response@1</option></select></label>
        <label>{{ t('optimizer.fields.solver') }}<select v-model="profileForm.solver"><option value="osqp_mpc@1">osqp_mpc@1</option><option value="scipy_slsqp@1">scipy_slsqp@1</option></select></label>
        <label>processSpecRef<input
          v-model="profileForm.processSpecRef"
          placeholder="pms@1"
        ></label>
      </div>
      <label class="block">{{ t('optimizer.profile.config') }}<textarea
        v-model="profileForm.configJson"
        rows="10"
      /></label>
      <p class="hint">
        {{ t('optimizer.profile.configHint') }}
      </p>
      <div class="actions">
        <button
          class="pill-btn"
          :disabled="busy"
          @click="saveProfile"
        >
          {{ t('optimizer.profile.save') }}
        </button>
      </div>
      <table class="tbl">
        <thead><tr><th>profile</th><th>status</th><th>model</th><th>solver</th><th /></tr></thead>
        <tbody>
          <tr
            v-for="p in profiles"
            :key="`${p.id}@${p.version}`"
          >
            <td>{{ p.id }}@{{ p.version }}</td><td>{{ p.status }}</td><td>{{ p.modelRef }}</td><td>{{ p.solverRef }}</td>
            <td>
              <button
                v-if="p.status !== 'published'"
                class="mini-btn"
                @click="publishProfile(p.id, p.version)"
              >
                {{ t('optimizer.publish') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section
      v-if="tab === 'binding'"
      class="panel"
    >
      <h2>{{ t('optimizer.binding.title') }}</h2>
      <div class="grid">
        <label>workspaceId<input v-model="bindingForm.workspaceId"></label>
        <label>channelId<input v-model="bindingForm.channelId"></label>
        <label>{{ t('optimizer.fields.agentInstance') }}<input
          v-model="bindingForm.agentInstanceId"
          placeholder="channel_agents.id"
        ></label>
        <label>profileId<input v-model="bindingForm.profileId"></label>
        <label>profileVersion<input
          v-model.number="bindingForm.profileVersion"
          type="number"
          min="1"
        ></label>
        <label>mode<select v-model="bindingForm.mode"><option value="recommendation">recommendation</option><option value="shadow">shadow</option></select></label>
      </div>
      <p class="hint">
        {{ t('optimizer.binding.identityHint') }}
      </p>
      <div class="actions">
        <button
          class="pill-btn"
          :disabled="busy"
          @click="createBinding"
        >
          {{ t('optimizer.binding.create') }}
        </button>
      </div>
      <table class="tbl">
        <thead><tr><th>id</th><th>channel</th><th>agent</th><th>profile</th><th>mode</th><th>rev</th><th /></tr></thead>
        <tbody>
          <tr
            v-for="b in bindings"
            :key="b.id"
          >
            <td class="mono">
              {{ b.id }}
            </td><td>{{ b.channelId }}</td><td>{{ b.channelAgentId }}</td><td>{{ b.profileVersion }}</td><td>{{ b.mode }}</td><td>{{ b.revision }}</td>
            <td>
              <button
                class="mini-btn"
                @click="revokeBinding(b.id)"
              >
                {{ t('optimizer.binding.revoke') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section
      v-if="tab === 'runs'"
      class="panel"
    >
      <h2>{{ t('optimizer.runs.title') }}</h2>
      <div class="grid">
        <label>{{ t('optimizer.fields.agentInstance') }}<input v-model="solveAgent"></label>
        <label>bindingId ({{ t('optimizer.optional') }})<input v-model="solveBinding"></label>
      </div>
      <div class="actions">
        <button
          class="pill-btn"
          :disabled="busy"
          @click="runSolve"
        >
          {{ t('optimizer.runs.solve') }}
        </button>
      </div>
      <table class="tbl">
        <thead><tr><th>run</th><th>status</th><th>profile</th><th>IR hash</th><th>{{ t('optimizer.runs.recommendation') }}</th><th>validUntil</th></tr></thead>
        <tbody>
          <tr
            v-for="r in runs"
            :key="r.id"
          >
            <td class="mono">
              {{ r.id }}
            </td><td>{{ r.status }}</td><td>{{ r.profileId }}</td><td class="mono">
              {{ r.problemIrHash?.slice(0, 10) }}
            </td>
            <td :class="{ unverified: r.recommendation?.status === 'unverified' }">
              {{ r.recommendation?.statusLabel ?? '—' }}
            </td>
            <td>{{ r.recommendation?.validUntil ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">
        {{ t('optimizer.runs.zeroWrite') }}
      </p>
    </section>
  </div>
</template>

<style scoped>
.optimizer-page { padding: 24px 32px 64px; color: var(--aw-fg, #e6edf3); }
.sub { color: var(--aw-muted, #8b98a5); margin: 4px 0 8px; }
.banner { padding: 10px 14px; border-radius: 8px; margin: 12px 0; font-size: 13px; }
.banner.error { background: rgba(255, 92, 92, 0.12); border: 1px solid rgba(255, 92, 92, 0.4); color: #ff9b9b; }
.banner.ok { background: rgba(53, 224, 160, 0.1); border: 1px solid rgba(53, 224, 160, 0.35); color: #35e0a0; }
.tabs { display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap; }
.tabs .pill-btn.active { background: rgba(53, 224, 160, 0.16); border-color: #35e0a0; color: #35e0a0; }
.panel { border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 18px 20px; margin-bottom: 18px; background: rgba(255,255,255,0.015); }
.panel h2 { font-size: 15px; letter-spacing: .04em; margin: 0 0 14px; text-transform: uppercase; color: #b8c6d1; }
.panel h3 { font-size: 13px; color: #b8c6d1; margin: 18px 0 10px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px 14px; margin-bottom: 12px; }
label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: #8b98a5; }
label.block { margin-top: 10px; }
input, select, textarea { background: #0d1117; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 7px 9px; color: #e6edf3; font-size: 13px; font-family: inherit; }
textarea, pre, code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre.json { background: #0d1117; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 12px; font-size: 12px; overflow: auto; }
.actions { display: flex; gap: 10px; margin: 14px 0; flex-wrap: wrap; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tbl th, .tbl td { text-align: left; padding: 7px 8px; border-bottom: 1px solid rgba(255,255,255,0.06); }
.tbl th { color: #8b98a5; font-weight: 500; }
.list { list-style: none; padding: 0; margin: 10px 0; display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; }
.list .gap { color: #ffb86b; }
.hint { color: #8b98a5; font-size: 12.5px; }
.unverified { color: #ffb86b; font-weight: 600; }
</style>
