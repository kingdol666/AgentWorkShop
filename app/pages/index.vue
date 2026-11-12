<script setup lang="ts">
/**
 * 仪表盘(/)—— 产线运营数字大屏。
 * ECharts 可视化:实时工况趋势(量程归一化)/ 产线运行状态 / 数采管线吞吐 /
 * 写控制成功率 / 节点状态分布 + 产线清单卡。
 *
 * 页面只做编排:数据与派生在 ./composables/useDashboardData,图表 option 在
 * ./composables/useDashboardCharts,呈现与样式在 components/dashboard/*;
 * 本文件保留的只有装载时序(WS 首帧 + 5s 兜底轮询)与区块拼装。
 * 数据权威在 server:useDcwStream + useDaqStream(REST 基线 + WS 实时收敛
 * + 5s 低频兜底刷新);趋势缓冲为本页每 5s 一次的量程归一化快照。
 */
import { useDashboardCharts } from './composables/useDashboardCharts'
import { useDashboardData } from './composables/useDashboardData'
import { useVisibleInterval } from '@/app/composables/workshop/useVisibleInterval'
import DashboardFleetPanel from '@/app/components/dashboard/DashboardFleetPanel.vue'
import DashboardGaugeBand from '@/app/components/dashboard/DashboardGaugeBand.vue'
import DashboardHarnessPanel from '@/app/components/dashboard/DashboardHarnessPanel.vue'
import DashboardAlarmQueue from '@/app/components/dashboard/DashboardAlarmQueue.vue'
import DashboardStatusBand from '@/app/components/dashboard/DashboardStatusBand.vue'
import DashboardLineStatePanel from '@/app/components/dashboard/DashboardLineStatePanel.vue'
import DashboardNodeStatePanel from '@/app/components/dashboard/DashboardNodeStatePanel.vue'
import DashboardPipelinePanel from '@/app/components/dashboard/DashboardPipelinePanel.vue'
import DashboardTrendPanel from '@/app/components/dashboard/DashboardTrendPanel.vue'
import DashboardWritePanel from '@/app/components/dashboard/DashboardWritePanel.vue'

const { t } = useI18n()
// 注意:useHead 的函数 title 在 prod SSR 下立即求值,必须在 useI18n 之后注册
useHead({ title: () => t('titles.dashboard') })

// 全页唯一一份数据源 + 由它展开的图表 option(都只在 setup 里创建一次)
const data = useDashboardData()
const { site, daq, dcw, pushTrend, loadHarnesses, linesActive, daqOnline, daqTotal, alarmCount, writeRate, harnesses, harnessOk, harnessError, trendHasData, lineCards, fleetShown, fleetOverflow } = data
const { trendOpt, lineStateOpt, pipelineOpt, writeOpt, nodeStateOpt } = useDashboardCharts(data)

// ---------- 数据装载(WS 实时 + 5s 兜底;可见性调度:后台降频 30s,回前台立即补拍) ----------
onMounted(() => {
  daq.ensureWsFeed()
  dcw.ensureWsFeed()
  void Promise.all([daq.load(), dcw.load()]).then(() => pushTrend())
  void daq.fetchAlarms()
  void loadHarnesses()
  useVisibleInterval(() => {
    void daq.load()
    void dcw.load()
    void loadHarnesses()
    pushTrend()
  }, 5000, { bgMs: 30000 })
})

/** 告警行不带单位:从节点清单取同一份工程单位(只用于展示) */
const alarmUnits = computed<Record<string, string>>(() =>
  Object.fromEntries(daq.nodes.map(n => [n.id, n.unit])),
)

/** 告警确认必须走服务端:ackAlarm 内部会重新拉取未确认列表,界面据此收敛 */
const onAckAlarm = (id: string): void => {
  void daq.ackAlarm(id)
}
</script>

<template>
  <div class="home">
    <!-- 状态带:现在是否正常 + 去哪里处理;读数交给下方量规带 -->
    <DashboardStatusBand
      :mode="site.mode"
      :lines-active="linesActive.length"
      :lines-total="dcw.lines.length"
      :alarm-count="alarmCount"
    />

    <!-- 量规统计带:一块仪表盘,不是一排各自为政的卡(底部量程刻度是签名) -->
    <DashboardGaugeBand
      :lines-active="linesActive.length"
      :lines-total="dcw.lines.length"
      :dcw-online="dcw.controller.nodesOnline"
      :dcw-total="dcw.controller.nodesTotal"
      :daq-online="daqOnline"
      :daq-total="daqTotal"
      :samples-stored="daq.meta.samplesStored ?? 0"
      :write-rate="writeRate"
      :alarm-count="alarmCount"
    />

    <!-- 大屏图阵 -->
    <!-- 执行引擎可用性(Harness CLI 环境探测;未安装不可选,派工前强校验;API 失联显式报错) -->
    <section
      v-if="harnessError"
      class="home-harness-error"
    >
      <div class="aw-bench">
        <header class="aw-bench-hd">
          <h3 class="aw-bench-title">
            {{ $t('home.harness.title') }}
          </h3>
        </header>
        <AwStateBlock
          state="error"
          :retry="loadHarnesses"
        />
      </div>
    </section>
    <DashboardHarnessPanel
      v-else-if="harnesses.length > 0"
      :harnesses="harnesses"
      :ok-count="harnessOk"
    />

    <DashboardAlarmQueue
      :alarms="daq.alarms"
      :units="alarmUnits"
      @ack="onAckAlarm"
    />

    <div class="grid aw-stagger">
      <DashboardTrendPanel
        :option="trendOpt"
        :has-data="trendHasData"
      />
      <DashboardLineStatePanel
        :option="lineStateOpt"
        :lines-active="linesActive.length"
        :lines-total="dcw.lines.length"
      />
      <DashboardPipelinePanel :option="pipelineOpt" />
      <DashboardWritePanel
        :option="writeOpt"
        :writes-total="dcw.controller.writesTotal"
        :writes-failed="dcw.controller.writesFailed"
      />
      <DashboardNodeStatePanel :option="nodeStateOpt" />
    </div>

    <DashboardFleetPanel
      :lines="fleetShown"
      :total="lineCards.length"
      :overflow="fleetOverflow"
    />

    <!-- 插件 UI 注入区:client 面板经 ctx.ui.registerPanel({slot:'dashboard.widgets'}) 注入 -->
    <ClientOnly>
      <workshop-plugin-slot slot-name="dashboard.widgets" />
    </ClientOnly>
  </div>
</template>

<style scoped>
.home { padding: 4px; }

/* ---------- 大屏图阵 ---------- */
.grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--gap-block);
  margin-bottom: var(--gap-block);
}
/* 列宽(.span8 / .span4)与面板专属样式随各自的 <section> 搬进 components/dashboard/*:
   scoped 样式编译成 .x[data-v-<scopeId>],无法外移成公共 css,只能由拥有该元素的组件持有。 */
/* Harness 探测失联:与图阵同框的独立错误条(区别于"没有引擎") */
.home-harness-error { margin-bottom: var(--gap-block); }
</style>
