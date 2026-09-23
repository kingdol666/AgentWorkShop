<script setup lang="ts">
/**
 * AML 自动建模平台 —— 单页五区:概览条 / 数据集快照 / 训练作业 / 实验排行榜 / 模型注册表 + 预测控制台。
 * REST 快照(GET /api/workshop/aml/*)+ WS 实时帧(useAmlStream 经 townBus)双通道;
 * 训练判定以平台门禁为准,页面只做诚实的状态呈现与人工晋升/取消/重试入口。
 *
 * 页面只做编排:数据/动作在 composables/*,区块与弹窗在 components/*,样式在 styles.css。
 * 每个分区状态只创建一次,显式下发给子组件(备注编辑槽为数据集表与模型表共享)。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAmlStream } from '@/app/composables/workshop/useAmlStream'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useVisibleInterval } from '@/app/composables/workshop/useVisibleInterval'
import { isActiveStatus, isTerminalStatus } from './constants'
import { useAmlEnv } from './composables/useAmlEnv'
import { useAmlDatasets } from './composables/useAmlDatasets'
import { useAmlJobs } from './composables/useAmlJobs'
import { useAmlExperiments } from './composables/useAmlExperiments'
import { useAmlModels } from './composables/useAmlModels'
import { useAmlNotes } from './composables/useAmlNotes'
import { useAmlEntities } from './composables/useAmlEntities'
import AmlPageHeader from '~/components/aml/AmlPageHeader.vue'
import AmlInfraBanner from '~/components/aml/AmlInfraBanner.vue'
import AmlOverviewBar from '~/components/aml/AmlOverviewBar.vue'
import AmlEnvPanel from '~/components/aml/AmlEnvPanel.vue'
import AmlDatasetTable from '~/components/aml/AmlDatasetTable.vue'
import AmlJobsTable from '~/components/aml/AmlJobsTable.vue'
import AmlExperimentsTable from '~/components/aml/AmlExperimentsTable.vue'
import AmlModelsTable from '~/components/aml/AmlModelsTable.vue'
import AmlPredictConsole from '~/components/aml/AmlPredictConsole.vue'
import AmlDatasetFormModal from '~/components/aml/AmlDatasetFormModal.vue'

const { t: tt } = useI18n()

definePageMeta({ layout: 'default' })
useHead({ title: () => tt('aml.k1amlx160') })

// ---------- 分区状态(每块一份实例,跨块依赖用回调显式接线) ----------

const {
  overview, overviewError, env, envBusy, inventory,
  pythonText, venvText, uvText, uvSourceText, blockerText, rootSourceLabel,
  loadOverview, loadEnv, loadInventory, startEnvPoll, stopEnvPoll,
  installUv, createVenv, recheckEnv, pruneOrphans,
} = useAmlEnv()

const { datasets, expandedDs, dsDetails, loadDatasets, toggleDs } = useAmlDatasets()
const { jobRows, jobDetails, expandedJob, confirmCancel, cancelling, confirmRetry, retrying, loadJobs, toggleJob, refreshJobLogs, onCancelJob, onRetryJob } = useAmlJobs()
const { expDatasetId, experiments, expError, bestExpId, loadExperiments } = useAmlExperiments()
const { models, confirmPromote, promoting, loadModels, onPromote } = useAmlModels({ reloadOverview: loadOverview })

/** 备注编辑槽:数据集表与模型表共用同一份,同时只允许一个行内编辑框 */
const { noteEditing, noteDraft, startEditNote, cancelEditNote, saveNote } = useAmlNotes({
  reloadDatasets: loadDatasets,
  reloadModels: loadModels,
})

const { removeEntity } = useAmlEntities({
  reloadDatasets: loadDatasets,
  reloadModels: loadModels,
  reloadJobs: loadJobs,
  reloadOverview: loadOverview,
  reloadInventory: loadInventory,
})

/** 新建数据集弹窗开合(列表的「新建」与弹窗自身的关闭都落在这一个 ref 上) */
const dsFormOpen = ref(false)

function reloadAll(): void {
  void loadOverview()
  void loadEnv()
  void loadInventory()
  void loadDatasets()
  void loadJobs()
  void loadModels()
}

// ---------- WS 实时流(aml.job / aml.dataset / aml.model 帧;连接层即注册 scene peer) ----------

const aml = useAmlStream()
const ws = useWorkshopWs()
let unsubFeed: (() => void) | null = null
let logTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  ws.ensureConnected()
  unsubFeed = aml.ensure()
  void loadOverview()
  void loadEnv()
  void loadInventory()
  void loadDatasets()
  void loadJobs()
  void loadModels()
  // 进入页面时若已有环境任务在跑(例如上一次安装刚发起),自动接续进度轮询
  if ((env.value?.task?.status ?? overview.value?.env?.task?.status) === 'running') {
    envBusy.value = true
    startEnvPoll()
  }
  // 低频兜底轮询(WS 直推收敛状态,轮询只兜丢帧):可见性调度,后台自动降频
  useVisibleInterval(() => {
    void loadOverview()
    void loadJobs()
  }, 8000, { bgMs: 30000 })
  // 展开中的活跃作业:日志尾随 5s 轮询
  logTimer = setInterval(() => {
    const id = expandedJob.value
    if (!id || document.hidden) return
    const j = jobRows.value.find(x => x.id === id)
    if (j && isActiveStatus(j.status)) void refreshJobLogs(id)
  }, 5000)
})
onBeforeUnmount(() => {
  unsubFeed?.()
  if (logTimer) clearInterval(logTimer)
  stopEnvPoll()
})

// 作业终态帧 → 立即收敛列表(不等轮询拍);模型晋升帧 → 注册表即时刷新
watch(() => aml.lastJob.value, (f) => {
  if (f && isTerminalStatus(f.status)) void loadJobs()
})
watch(() => aml.lastModel.value, () => {
  void loadModels()
})
watch(() => aml.lastDataset.value, () => {
  void loadDatasets()
})
</script>

<template>
  <div class="page">
    <!-- 页头:标题 + 运行时徽标(PYTHON / VENV / UV) -->
    <AmlPageHeader
      :overview="overview"
      :env="env"
      :python-text="pythonText"
      :venv-text="venvText"
      :uv-text="uvText"
    />

    <!-- 1. 概览条:Python 运行时 / 依赖环境 / 队列 / 计数;不 ok 给醒目提示条 -->
    <AmlInfraBanner :overview="overview" />

    <AmlOverviewBar
      :overview="overview"
      :overview-error="overviewError"
      :python-text="pythonText"
      :venv-text="venvText"
      @reload="reloadAll"
    />

    <!-- 1b. 运行环境:uv 检测 / 一键安装 / ./aml/.venv 供给 / 元数据↔实体对账 -->
    <AmlEnvPanel
      v-if="env"
      :env="env"
      :inventory="inventory"
      :env-busy="envBusy"
      :uv-text="uvText"
      :uv-source-text="uvSourceText"
      :blocker-text="blockerText"
      :root-source-label="rootSourceLabel"
      @recheck="recheckEnv"
      @install-uv="installUv"
      @create-venv="createVenv"
      @prune="pruneOrphans"
    />

    <!-- 2. 数据集快照:注册表 + 行内展开(清洗报告/滞后估计/run 概览)+ 新建 -->
    <AmlDatasetTable
      v-model:note-draft="noteDraft"
      :datasets="datasets"
      :expanded-ds="expandedDs"
      :ds-details="dsDetails"
      :note-editing="noteEditing"
      @toggle="toggleDs"
      @reload="loadDatasets"
      @create="dsFormOpen = true"
      @edit-note="startEditNote"
      @save-note="id => saveNote('datasets', id)"
      @cancel-note="cancelEditNote"
      @remove="(id, confirmText) => removeEntity('datasets', id, confirmText)"
    />

    <!-- 3. 训练作业:REST 快照 + WS 实时进度;展开 = 门禁逐项 + 日志尾随(活跃 5s 轮询) -->
    <AmlJobsTable
      :job-rows="jobRows"
      :expanded-job="expandedJob"
      :job-details="jobDetails"
      :confirm-cancel="confirmCancel"
      :cancelling="cancelling"
      :confirm-retry="confirmRetry"
      :retrying="retrying"
      @toggle="toggleJob"
      @reload="loadJobs"
      @cancel="onCancelJob"
      @retry="onRetryJob"
      @remove="(id, confirmText) => removeEntity('jobs', id, confirmText)"
    />

    <!-- 4. 实验排行榜:选数据集 → 谱系表(变更说明/父实验/G1/G2/门禁态),最优行高亮 -->
    <AmlExperimentsTable
      v-model:exp-dataset-id="expDatasetId"
      :datasets="datasets"
      :experiments="experiments"
      :best-exp-id="bestExpId"
      :exp-error="expError"
      @reload="loadExperiments"
    />

    <!-- 5. 模型注册表:阶段徽标 + 指标 + 两段确认晋升 -->
    <AmlModelsTable
      v-model:note-draft="noteDraft"
      :models="models"
      :note-editing="noteEditing"
      :confirm-promote="confirmPromote"
      :promoting="promoting"
      @reload="loadModels"
      @edit-note="startEditNote"
      @save-note="id => saveNote('models', id)"
      @cancel-note="cancelEditNote"
      @promote="onPromote"
      @remove="(id, confirmText) => removeEntity('models', id, confirmText)"
    />

    <!-- 5b. 预测控制台:production 模型 → ioSpec → history JSON → forecast 表 -->
    <AmlPredictConsole :models="models" />

    <!-- 新建数据集快照(spec 与 server zod 模式对齐) -->
    <AmlDatasetFormModal
      v-model:open="dsFormOpen"
      @created="loadDatasets"
    />
  </div>
</template>

<style scoped src="./styles.css"></style>
