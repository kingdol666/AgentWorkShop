<script setup lang="ts">
/**
 * 数采节点控制台(/daq/[id])—— 单节点专业控制面。
 * 实时值 + live 趋势(WS 流);参数控制(server DaqNode 单点参数:启停/周期/
 * 驱动/量程/预警带);设备绑定;时序库历史查询(降采样桶选择);帧视图(v2 多形态)。
 *
 * 页面只做编排:身份/参数/绑定/历史/帧各一个 composable(状态各归其主),
 * 视图放在 components/daq/ 下的子组件(绝不放进 pages/** —— 那会生成路由),
 * 样式随标记进各组件自己的 scoped 样式块(scoped 的 data-v 不跨组件,共享工具类各自持有一份)。
 * 画布 ref 由 composable 持有、子组件经 defineModel 反写,绘制指令只有一个所有者。
 */
import { useDaqDetailBinding } from './composables/useDaqDetailBinding'
import { useDaqDetailFrames } from './composables/useDaqDetailFrames'
import { useDaqDetailHistory } from './composables/useDaqDetailHistory'
import { useDaqDetailNode } from './composables/useDaqDetailNode'
import { useDaqDetailParams } from './composables/useDaqDetailParams'

definePageMeta({ layout: 'default' })

const { daq, dcw, nodeId, node, tpl, signalKind, isFrameNode, stateLabel, effectiveState, driverPlanned } = useDaqDetailNode()
const { form, driverCatalog, driverCfg, driverFields, testing, testResult, saving, doTest, saveParams } = useDaqDetailParams(nodeId, node)
const { bindDeviceId, boundDeviceName, onBindToggle, availableDevices } = useDaqDetailBinding(nodeId, node)
const { historyPoints, bucketMs, BUCKETS, loadHistory, chartCanvas, liveCanvas, refreshOverrideMs } = useDaqDetailHistory(nodeId, node)
const { frames, loadFrames, vecPath } = useDaqDetailFrames(nodeId, isFrameNode)
</script>

<template>
  <div class="page">
    <p class="aw-kicker">
      <NuxtLink
        to="/daq"
        class="back"
      >{{ $t('daqDetail.k1emg364001') }}</NuxtLink> / NODE {{ nodeId.slice(0, 8).toUpperCase() }}
    </p>
    <div class="aw-page-head">
      <h1>{{ node?.name ?? nodeId }}</h1>
      <span
        class="st-pill"
        :class="[effectiveState()]"
      >{{ stateLabel[effectiveState()] }}</span>
    </div>

    <p
      v-if="!node && daq.error"
      class="err"
    >
      {{ daq.error }}(<NuxtLink to="/workshop">{{ $t('daqDetail.k1bhhheq002') }}</NuxtLink>)
    </p>

    <div
      v-if="node"
      class="grid"
    >
      <!-- 左列:实时状态卡 -->
      <DaqDetailLiveCard
        v-model:canvas-el="liveCanvas"
        :node="node"
        :tpl="tpl"
        :bound-device-name="boundDeviceName"
        :default-interval-ms="daq.controller.defaultIntervalMs"
        :default-publish-ms="daq.controller.defaultPublishIntervalMs"
        :driver-planned="driverPlanned"
      />

      <!-- 中列:参数控制 -->
      <DaqDetailParamForm
        v-model:form="form"
        v-model:driver-cfg="driverCfg"
        v-model:bind-device-id="bindDeviceId"
        :lines="dcw.lines"
        :driver-catalog="driverCatalog"
        :driver-fields="driverFields"
        :saving="saving"
        :testing="testing"
        :test-result="testResult"
        :bound-device-name="boundDeviceName"
        :available-devices="availableDevices"
        @save="saveParams"
        @test="doTest"
        @bind-toggle="onBindToggle"
      />

      <!-- 右列:时序库历史 -->
      <DaqDetailHistoryCard
        v-model:bucket-ms="bucketMs"
        v-model:refresh-override-ms="refreshOverrideMs"
        v-model:canvas-el="chartCanvas"
        :tsdb="daq.meta.tsdb"
        :buckets="BUCKETS"
        :history-points="historyPoints"
        :decimals="node.decimals"
        :min-query-ms="daq.controller.minQueryDisplayIntervalMs ?? 500"
        :default-query-ms="daq.controller.queryDisplayIntervalMs ?? 5000"
        @reload="loadHistory"
      />
    </div>

    <!-- 帧视图(v2 多形态信号:向量轮廓 / 图像画廊;scalar 节点不渲染) -->
    <DaqDetailFramesTile
      v-if="isFrameNode"
      :signal-kind="signalKind"
      :frames="frames"
      :vec-path="vecPath"
      @reload="loadFrames"
    />
  </div>
</template>

<style scoped>
.page { padding: 4px; }
.back { color: var(--ink-faint); text-decoration: none; }
.back:hover { color: var(--accent); }
.aw-page-head h1 { margin: 2px 0 4px; font-size: 26px; font-weight: 400; letter-spacing: -0.01em; }
.err { margin-top: 14px; font-size: 13px; color: var(--tone-danger-dot); }
.grid {
  display: grid;
  gap: 14px;
  align-items: start;
  grid-template-columns: minmax(260px, 340px) minmax(320px, 1fr) minmax(280px, 380px);
}
@media (max-width: 1100px) {
  .grid { grid-template-columns: 1fr; }
}
.st-pill {
  display: inline-block;
  padding: 3px 11px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  border-radius: var(--radius-pill);
}
.st-pill.ok { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.st-pill.warn { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.st-pill.alarm { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.st-pill.offline { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); }
</style>
