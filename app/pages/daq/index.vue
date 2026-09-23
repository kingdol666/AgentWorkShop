<script setup lang="ts">
/**
 * 数采中心(DAQ Console)—— server 驱动数采的总控面。
 * 后端能力自描述(tsdb/queue/驱动族 + 管线指标)、控制器全局启停/周期、
 * 节点清单(状态/实时值/周期/绑定/驱动),点进 /daq/[id] 进入单节点专业控制台。
 *
 * 页面只做编排:数据/动作在 composables,视图在 components,
 * 样式在 daq-page.css(与原 <style scoped> 逐字一致的全局层)。
 */
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'
import { useOpsLog } from '@/app/composables/workshop/useOpsLog'
import { useVisibleInterval } from '@/app/composables/workshop/useVisibleInterval'
import { useDaqAddNode } from './composables/useDaqAddNode'
import { useDaqDriverCatalog, useDaqControllerForm, useDaqFilters } from './composables/useDaqFilters'
import { useDaqNodeWindow } from './composables/useDaqNodeWindow'
import { useDaqOptimizations } from './composables/useDaqOptimizations'
import { useDaqTemplateIconLabels, useDaqTemplates } from './composables/useDaqTemplates'
import './daq-page.css'

const { t: tt } = useI18n()

definePageMeta({ layout: 'default' })
useHead({ title: () => tt('titles.daq') })

const daq = useDaqStream()
const dcw = useDcwStream()
/** WS 会话:连接层即注册 scene peer —— daq.reading 实时帧直达本页(不再等 5s 轮询) */
const ws = useWorkshopWs()

/** 是否存在任意运行中的产线(横幅判定) */
const anyLineActive = computed(() => dcw.lines.some(l => dcw.lineStateOf(l.id).active))

// ---------- 运维日志(全操作统一记录):实时事件轨渲染摘要,详情在 /logs 日志管理 ----------
const opsLog = useOpsLog()

function opsKindLabel(kind: string): string {
  const m: Record<string, string> = { write: tt('logs.kind.write'), manual: tt('logs.kind.manual'), alarm: tt('logs.kind.alarm'), line: tt('logs.kind.line'), recipe: tt('logs.kind.recipe'), rollback: tt('logs.kind.rollback'), daq: tt('logs.kind.daq'), system: tt('logs.kind.system') }
  return m[kind] ?? (kind || tt('logs.kind.system'))
}

function opsTime(at: string): string {
  const d = new Date(at)
  return Number.isFinite(d.getTime())
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    : ''
}

/** 未确认报警确认(失败 toast 后端可读原因;成功后 fetchAlarms 已由 store 内部刷新) */
async function ackOne(id: string): Promise<void> {
  try {
    await daq.ackAlarm(id)
    message.success(tt('daq.k1acked144'))
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

let unsub: (() => void) | null = null
onMounted(() => {
  // WS 会话建连(连接层即注册 scene peer):daq.reading 实时帧直达,不再等 5s 轮询
  ws.ensureConnected()
  unsub = daq.ensureWsFeed()
  // 运维日志实时事件轨(ops.log 帧;越限告警亦入轨 —— server 权威,详情在 /logs)
  opsLog.ensureLive()
  void daq.load()
  // 未确认报警首轮拉取(S5;WS daq.alarm 直推 + 此后随低频刷新拍轮询兜底)
  void daq.fetchAlarms()
  // 产线门控状态(无活动配方不采集;状态仅展示,控制在产线运营页)
  void dcw.load()
  // 设备注册表(绑定设备列:显示名 + 可编辑换绑;与数字孪生同源 bind REST)
  void deviceTwins.load()
  // Agent 优化记录首屏预取(面板展开即有数据;展开时仍会重拉一次保新鲜)
  void dcw.loadOptimizations()
  // meta 指标随读数帧落库节奏低频刷新(诚实可见的管线运行数据);
  // 产线运行态(横幅/产线列注记)同拍刷新 —— 开跑/停线后本页 ≤5s 收敛;
  // dcw 全量快照(95+ 线/配方/历史)是重载荷且行控状态已有 WS 帧收敛,降至 15s 兜底;
  // 轮询走可见性调度:后台自动降频(5s→30s / 15s→60s),回前台立即补拍,主线程不被占满
  useVisibleInterval(() => {
    void daq.load()
    void daq.fetchAlarms()
  }, 5000, { bgMs: 30000 })
  useVisibleInterval(() => {
    void dcw.load()
  }, 15000, { bgMs: 60000 })
})
onBeforeUnmount(() => {
  unsub?.()
})

// ---------- 节点筛选 + 行级展示状态(模板/驱动选项、绑定设备、窗口前全量过滤) ----------
const { filters, hasFilters, clearFilters, templateOptions, driverOptions, boundDevices, filteredNodes, filteredLine, filteredLineState } = useDaqFilters()
const deviceTwins = useDeviceTwins()
const { driverCatalog, driverReady } = useDaqDriverCatalog()
const { reconnecting, doReconnect } = useDaqControllerForm()

/** 控制器周期下发(两个输入复用同一入口,参数与拆分前逐字一致) */
function onControllerConfig(intervalMs: number, publishIntervalMs: number): void {
  void daq.controllerAction('config', intervalMs, publishIntervalMs)
}

// ---------- 节点表窗口化渲染(滚动窗口 + 计数变化重算) ----------
const { nodesTableRef, visibleNodes, padTopPx, padBottomPx, resetToTop } = useDaqNodeWindow(filteredNodes)
// 筛选/搜索改变行数后窗口必须重算(否则会停在旧的切片上,看起来"表空了")
watch(() => filteredNodes.value.length, () => {
  resetToTop()
})

// ---------- 添加节点向导(目录与缺省字段由页面注入) ----------
const addNode = useDaqAddNode(driverCatalog, tt)

// ---------- 自定义信号模板管理 ----------
const tpl = useDaqTemplates(tt)
const iconLabels = useDaqTemplateIconLabels(tt)

// ---------- Agent 优化记录面板 ----------
const opt = useDaqOptimizations()
</script>

<template>
  <div class="page">
    <div class="aw-page-head">
      <div>
        <p class="aw-kicker">
          AGENTWORKSHOP / DAQ CONSOLE
        </p>
        <h1>{{ $t('daq.k1emg364011') }}</h1>
        <p class="sub">
          {{ $t('daq.k1wmg2bz012') }}
        </p>
      </div>
      <div class="badges mono">
        <span
          class="badge"
          :title="$t('daq.k1tsdbtip133')"
        >TSDB · {{ daq.meta.tsdb }}</span>
        <span
          class="badge"
          :title="$t('daq.k1queuet134')"
        >QUEUE · {{ daq.meta.queue }}</span>
      </div>
    </div>

    <DaqLineBanner
      :loaded="daq.loaded"
      :filtered-line="filteredLine"
      :filtered-line-state="filteredLineState"
      :any-line-active="anyLineActive"
    />

    <DaqInfraBanner
      :infra="daq.meta.infra"
      :reconnecting="reconnecting"
      @reconnect="doReconnect"
    />

    <DaqAlarmBar
      :alarms="daq.alarms"
      @ack="ackOne"
    />

    <DaqControlCard
      v-model:controller="daq.controller"
      :meta="daq.meta"
      :lines="dcw.lines"
      :line-state-of="(id: string) => dcw.lineStateOf(id)"
      @action="(a: 'start' | 'stop' | 'pause' | 'resume') => daq.controllerAction(a)"
      @config="onControllerConfig"
      @open-add="addNode.open.value = true"
      @open-templates="tpl.tplOpen.value = true; tpl.resetTplForm()"
    />

    <DaqAddNodeModal
      v-model:open="addNode.open.value"
      v-model:form="addNode.form"
      :templates="daq.templates"
      :driver-catalog="driverCatalog"
      :driver-ready="driverReady"
      @test="addNode.doTestConnection"
      @submit="addNode.doAddNode"
      @close="addNode.open.value = false"
    />

    <DaqTemplateModal
      v-model:open="tpl.tplOpen.value"
      v-model:form="tpl.tplForm.value"
      :custom-tpls="tpl.customTpls.value"
      :builtin-tpls="tpl.builtinTpls.value"
      :icon-choices="tpl.iconChoices"
      :icon-labels="iconLabels"
      :editing="tpl.tplEditing.value"
      :saving="tpl.tplSaving.value"
      :error="tpl.tplError.value"
      :confirming-del="tpl.confirmingDel.value"
      @edit="tpl.editTpl"
      @copy="tpl.copyTpl"
      @remove="tpl.askDelTpl"
      @reset="tpl.resetTplForm"
      @save="tpl.saveTpl"
    />

    <DaqOptPanel
      :optimizations="dcw.optimizations"
      :lines="dcw.lines"
      :open="opt.optOpen.value"
      :mounted="opt.optMounted.value"
      :filter-line="opt.optFilterLine.value"
      :filter-recipe="opt.optFilterRecipe.value"
      :recipe-options="opt.optRecipeOptions.value"
      :series-of="opt.optSeriesOf.value"
      :series-loading="opt.optSeriesLoading.value"
      :status-key="opt.optStatusKey"
      :series-path="opt.seriesPath"
      :fmt-point="opt.fmtPoint"
      @toggle="opt.toggleOptPanel"
      @select-line="(v: string) => opt.optFilterLine.value = v"
      @select-recipe="(v: string) => opt.optFilterRecipe.value = v"
      @line-change="opt.onOptLineChange"
      @filter="opt.filterOpts"
      @series="opt.showOptSeries"
      @rollback="opt.rollbackRecord"
    />

    <DaqNodePanel
      v-model:table-el="nodesTableRef"
      v-model:filters="filters"
      :has-filters="hasFilters"
      :lines="dcw.lines"
      :bound-devices="boundDevices"
      :template-options="templateOptions"
      :driver-options="driverOptions"
      :filtered-count="filteredNodes.length"
      :total-count="daq.nodes.length"
      :ops-recent="opsLog.recent"
      :ops-kind-label="opsKindLabel"
      :ops-time="opsTime"
      :alarms="daq.alarms"
      :visible-nodes="visibleNodes"
      :pad-top-px="padTopPx"
      :pad-bottom-px="padBottomPx"
      :loading="!daq.loaded && !daq.error"
      :loaded="daq.loaded"
      :error="daq.error"
      @clear-filters="clearFilters"
      @ack="ackOne"
    />

    <p
      v-if="daq.error"
      class="err"
    >
      {{ daq.error }}(<NuxtLink to="/workshop">{{ $t('daq.k1bhhheq077') }}</NuxtLink>)
    </p>
  </div>
</template>
