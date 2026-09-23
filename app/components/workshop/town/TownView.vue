<script setup lang="ts">
/**
 * 小镇视图(AgentTeam RPG 可视化)— Vue 壳。
 *
 * 职责:装配共享状态(store / 实时流单例 / 具名 ref),把场景、HUD 与左右轨各域
 * 委派给 composables/workshop/town 下的组合式函数与 components/workshop/town 下的壳组件。
 * 本文件只保留:公开 props/类型、共享状态持有、组合式函数依赖装配、三栏壳、遮罩。
 */
import type Phaser from 'phaser'
import type { ComponentPublicInstance } from 'vue'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useUserStore } from '@/app/stores/workshop/user'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useTownBus } from '@/app/composables/workshop/useTownBus'
import { useCharacterAssets } from '@/app/composables/workshop/useCharacterAssets'
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'
import { useSceneLayouts } from '@/app/composables/workshop/useSceneLayouts'
import { useHttp } from '@/app/composables/useHttp'
import { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import { useTownSheets } from '@/app/composables/workshop/town/useTownSheets'
import { useTownChannels } from '@/app/composables/workshop/town/useTownChannels'
import { useTownLayout } from '@/app/composables/workshop/town/useTownLayout'
import { useTownAgentChat } from '@/app/composables/workshop/town/useTownAgentChat'
import { useTownAgentBindings } from '@/app/composables/workshop/town/useTownAgentBindings'
import { useTownAlarms } from '@/app/composables/workshop/town/useTownAlarms'
import { useTownSceneControl } from '@/app/composables/workshop/town/useTownSceneControl'
import { useTownHealth } from '@/app/composables/workshop/town/useTownHealth'
import { useTownRailData } from '@/app/composables/workshop/town/useTownRailData'
import { useTownNodeBindings } from '@/app/composables/workshop/town/useTownNodeBindings'
import { useTownSceneInput } from '@/app/composables/workshop/town/useTownSceneInput'
import { useTownSceneRuntime } from '@/app/composables/workshop/town/useTownSceneRuntime'
import { useTownCallouts } from '@/app/composables/workshop/town/useTownCallouts'
import { useTownTrends } from '@/app/composables/workshop/town/useTownTrends'
import { useTownNavMap } from '@/app/composables/workshop/town/useTownNavMap'
import { useTownHudTickers } from '@/app/composables/workshop/town/useTownHudTickers'
// 子组件(模板分块,见 components/):顶部导航 / 左轨 / 舞台列 / 右轨 / 状态栏 / 加载遮罩
import TownTopNav from './components/TownTopNav.vue'
import TownLeftRail from './components/TownLeftRail.vue'
import TownStage from './components/TownStage.vue'
import TownRightRail from './components/TownRightRail.vue'
import TownStatusBar from './components/TownStatusBar.vue'
import TownLoadingMask from './components/TownLoadingMask.vue'
import type { TownScene } from './TownScene'
import type { TownScene3D } from './TownScene3D'

const { t } = useI18n()

/**
 * 两种渲染器(Phaser 2D / Three.js 3D)共享的最小公开接口。
 * TownView 无感切换:事件订阅/HUD/跑马灯/迷你地图/拖放换装只用这里的方法。
 */
export type TownViewScene
  = | TownScene
    | TownScene3D

/**
 * 两种渲染器在 wireCommon 里共用的最小接口(不含 on;on 的事件签名两场景不同,
 * wireCommon 内部用场景实例类型收紧)。
 */
export type CommonTownScene = TownScene | TownScene3D

const props = defineProps<{
  channelId: string
  /** 独立页 /town:是否汇聚全部挂载频道到同一小镇(默认 false=仅当前频道) */
  allChannels?: boolean
}>()
const entities = useEntitiesStore()
const wsStore = useWorkspacesStore()
const { conn } = useWorkshopWs()
const townBus = useTownBus()
const characterAssets = useCharacterAssets()
const deviceTwins = useDeviceTwins()
const sceneLayouts = useSceneLayouts()
const http = useHttp()
/* 数采/智控流单例:父组件创建一次,经参数注入组合式函数(单例不重复调用) */
const daq = useDaqStream()
const dcw = useDcwStream()
const userStore = useUserStore()

/* 窄屏抽屉 / 底部坞开合状态(自本文件抽出,细节见 composables/workshop/town/useTownSheets.ts) */
const { sheetOpen, dockOpen, toggleSheet, closeSheet } = useTownSheets()

/* ---------- 共享状态(唯一持有者):渲染器实例 / HUD / 选中 / 保存态 ---------- */
const hostRef = ref<HTMLDivElement | null>(null)
/** 当前渲染器(TownScene / TownScene3D 之一) */
const sceneRef = shallowRef<TownViewScene | null>(null)
const gameRef = shallowRef<Phaser.Game | null>(null)
/** 3D 场景实例(dispose 用) */
const scene3dRef = shallowRef<TownScene3D | null>(null)
/** 渲染模式:默认 3D,?render=2d 回退 Phaser */
const render3d = typeof window !== 'undefined' ? new URLSearchParams(location.search).get('render') !== '2d' : true
const ready = ref(false)
const fps = ref(0)
const agentCount = ref(0)
const blockCount = ref(0)
const activity = ref<{ channelId: string, agentName: string, text: string } | null>(null)
const selected = ref<{ kind: 'agent' | 'device', id: string, scale: number, rotation: number } | null>(null)
const errorText = ref('')
const syncing = computed(() => conn.state === 'connecting')
const activeChannelName = computed(() => entities.channels[props.channelId]?.name ?? '')
const saveState = ref<{ state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error', at: number } | null>(null)
const saveStateLabel = computed(() => {
  switch (saveState.value?.state) {
    case 'dirty': return t('townView.k3oo50k155')
    case 'saving': return t('townView.k1b38d59156')
    case 'saved': return t('townView.k3n51yk157')
    case 'error': return t('townView.k1b3ayhc158')
    default: return ''
  }
})

/** 舞台 / 宿主 DOM 回填(舞台壳随 components/TownStage.vue 搬移,父组件仍持有引用) */
function setStageRef(el: Element | ComponentPublicInstance | null): void {
  stageRef.value = (el as HTMLElement | null)
}
function setHostRef(el: Element | ComponentPublicInstance | null): void {
  hostRef.value = (el as HTMLDivElement | null)
}

/* ============================================================
 * 各域组合式函数装配(依赖顺序):频道 → 布局 → 会话/绑定/告警 → 控制 → 健康 →
 * 左轨数据 → 节点绑定 → 场景输入 → 场景运行时 → 标注 → 趋势 → 导航 → 事件节拍
 * ============================================================ */
const {
  selectedChannel, boundaryDraft, onSelectChannel, saveChannelLayout, removeChannelFromScene, applyBoundaryDraft,
  dockHint, onDockCardClick, dropChannelAt, channelPanelTab, channelMembers, bindMemberModel, openChannelTab,
  dockRev, dockChannels, hashColor, onChannelDragStart, buildTownInput,
} = useTownChannels({ props, entities, wsStore, sceneLayouts, characterAssets, scene3dRef, errorText, saveState })
const {
  mode, snap, tMode, setTMode, toggleMode, toggleSnap, updateAgentHome, updateAgentRange, saveLayout,
  runHint, onScaleInput, onScaleCommit, closeScale, agentModels, deviceModels, objNameDraft, agentRangeDraft,
  agentDrawingRange, agentRangeStatusText, onToggleRangeDraw, applyAgentRangeDraft, onAgentRangeCommit,
  onClearAgentRange, onObjNameCommit, bindAgentModel, bindDeviceModel, deviceDeleteArmed, removeSelectedDevice,
  panelPos, onPanelGripDown, stageRef, viewPreset, onViewPreset, fullscreenStage,
} = useTownLayout({ props, entities, http, characterAssets, deviceTwins, scene3dRef, selected, errorText, saveState, onSelectChannel })
const {
  agentChatRows, agentChatTitle, selectedAgentMeta, selectedAgentRoleLabel, selectedAgentRoleTag,
  agentChatStateLabel, agentHistory, historyLoading, appendLiveChat, onRefreshHistory, agentChatColor,
  chatKindLabel, fmtTime, setChatScroll,
} = useTownAgentChat({ selected, entities, scene3dRef })
const {
  approvalRemainingSec, agentBindings, agentBindKind, agentBindNodeId, agentBindMode, pendingApprovals,
  approvalComments, bindAgentNode, unbindAgentNode, setBindingMode, decideApproval, bindingNodeName,
} = useTownAgentBindings({ selected, daq, dcw })
const { alarms, ALARM_STATES, raiseAlarm, activeAlarmCount, advanceAlarm, clearAlarms } = useTownAlarms()
const {
  threshPct, fpsCap, FPS_OPTIONS, setFpsCap, qualityMode, QUALITY_OPTIONS, setQualityMode, alarmRange, estop,
  toggleEstop, exposure, tintOpacity, sliderPct, onExposureInput, onTintInput, onResetView,
} = useTownSceneControl({ scene3dRef, raiseAlarm })
const {
  deviceCount, runningCount, idleCount, alarmCount, offlineCount, healthPct, healthTone, setDonutCanvas,
} = useTownHealth({ deviceTwins })
const {
  sceneTwinPool, sceneTwinById, sceneEmpty, syncSceneDevices, daqTemplates, dcwTemplates, treeOpen,
  toggleTreeGroup, daqNodesByTpl, dcwNodesByTpl, createDaqFromTemplate, createDcwFromTemplate,
  onDaqNodeDragStart, onDcwNodeDragStart, daqLeafState, dcwLeafState, daqTplById, daqTplOf, isLegacyDaqTwin,
  daqTwins, daqSim, fmtDaq, trendColor, rtcHist, RTC_HIST_CAP, setSparkRef, drawBindSparks,
} = useTownRailData({ daq, dcw, deviceTwins, townBus, sceneRef, scene3dRef, errorText, ready, blockCount, raiseAlarm })
const {
  boundDeviceOf, bindDaq, unbindDaq, nearestDeviceTwin, bindPopOpen, dcwBindPopOpen, bindPopMaxH, toggleBindPop,
  daqBindChoices, daqBindChoiceCount, bindDaqChoice, selectedIsDaq, selectedDaqSim, bindPick, boundDaqRows,
  daqBoundDeviceName, selectedIsDcw, selectedDcwNode, selectedDcwWindow, selectedDcwDeviceName, dcwBindPick,
  boundDcwRows, bindSelectedDcw, unbindSelectedDcw, doWriteSelectedDcw, dcwWinLabel, dcwWinInputPh,
  dcwWriteDrafts, dcwWriteErrs,
  doDcwWrite, dcwBindChoices, dcwBindChoiceCount, dcwMarkPct, bindDcwChoice, unbindDcw, selectedDaqNode,
  daqIntervalDraft, onDaqIntervalCommit, onDaqThresholdCommit, dcwWindowOf,
} = useTownNodeBindings({ selected, daq, dcw, deviceTwins, daqSim, daqTplById, daqTplOf, isLegacyDaqTwin, fmtDaq, sceneTwinById, dcwTemplates, trendColor, errorText })
const { bindSceneInput, lastDropText } = useTownSceneInput({
  mode, runHint, dockChannels, dropChannelAt, daq, dcw, nearestDeviceTwin, bindDaq, syncSceneDevices, sceneRef, errorText,
})
const { onFocusDevice } = useTownSceneRuntime({
  props, entities, sceneLayouts, characterAssets, deviceTwins, townBus, daq, sceneRef, scene3dRef, gameRef, hostRef,
  render3d, ready, fps, agentCount, blockCount, activity, selected, errorText, saveState, fpsCap, qualityMode,
  selectedChannel, boundaryDraft, agentRangeDraft, onSelectChannel, buildTownInput, updateAgentHome, updateAgentRange,
  sceneTwinPool, sceneTwinById, syncSceneDevices, appendLiveChat, bindSceneInput, dockRev,
})
const {
  showCallouts, selectDeviceFromCallout, orbitOn, toggleOrbit, locateSelected, calloutPos, calloutNearDist,
  daqLive, dcwLive, camPose, callouts,
} = useTownCallouts({ selected, objNameDraft, scene3dRef, stageRef, dcw, daqTwins, daqSim, boundDeviceOf, sceneTwinById, dcwWindowOf, fmtDaq, alarmRange, errorText })
const { toggleTrend, setTrendCanvas, trendOn, trendExpanded, trendOverflow, trendChips, drawTrend } = useTownTrends({
  daqTwins, daqSim, rtcHist, RTC_HIST_CAP, trendColor,
})
const { minimap, navScale, setNavCanvas, onNavWheel, onNavDown, onNavMove, onNavUp } = useTownNavMap({
  sceneRef, scene3dRef, stageRef, camPose, calloutPos, showCallouts, daq, daqTwins, boundDeviceOf,
})
const { ticker } = useTownHudTickers({ sceneRef, daq, drawTrend, drawBindSparks })
</script>

<template>
  <div class="town-view">
    <TownTopNav
      :mode="mode"
      :fps="fps"
      :active-alarm-count="activeAlarmCount"
      :user-name="userStore.user?.name ?? 'OP'"
      :save-state="saveState"
      :save-state-label="saveStateLabel"
      :sheet-open="sheetOpen"
      @toggle-mode="toggleMode"
      @save-layout="saveLayout"
      @toggle-sheet="toggleSheet"
    />

    <!-- ================= 三栏应用区 ================= -->
    <div class="app">
      <!-- 左轨:设备资源 / 数采节点 / 场景管理 -->
      <TownLeftRail
        :sheet-open="sheetOpen"
        :close-sheet="closeSheet"
        :mode="mode"
        :tree-open="treeOpen"
        :device-models="deviceModels"
        :daq-twins="daqTwins"
        :device-twins="deviceTwins"
        :daq="daq"
        :daq-templates="daqTemplates"
        :daq-nodes-by-tpl="daqNodesByTpl"
        :daq-leaf-state="daqLeafState"
        :toggle-tree-group="toggleTreeGroup"
        :create-daq-from-template="createDaqFromTemplate"
        :on-daq-node-drag-start="onDaqNodeDragStart"
        :dcw="dcw"
        :dcw-templates="dcwTemplates"
        :dcw-nodes-by-tpl="dcwNodesByTpl"
        :dcw-leaf-state="dcwLeafState"
        :create-dcw-from-template="createDcwFromTemplate"
        :on-dcw-node-drag-start="onDcwNodeDragStart"
        :dock-channels="dockChannels"
        :dock-hint="dockHint"
        :on-channel-drag-start="onChannelDragStart"
        :on-dock-card-click="onDockCardClick"
        :on-focus-device="onFocusDevice"
      />

      <!-- 中栏:舞台 + 底部坞 -->
      <TownStage
        v-model:show-callouts="showCallouts"
        v-model:boundary-draft="boundaryDraft"
        v-model:dock-open="dockOpen"
        v-model:thresh-pct="threshPct"
        v-model:callout-near-dist="calloutNearDist"
        v-model:trend-expanded="trendExpanded"
        :set-stage-ref="setStageRef"
        :set-host-ref="setHostRef"
        :mode="mode"
        :ready="ready"
        :error-text="errorText"
        :last-drop-text="lastDropText"
        :active-channel-name="activeChannelName"
        :view-preset="viewPreset"
        :orbit-on="orbitOn"
        :locate-selected="locateSelected"
        :toggle-orbit="toggleOrbit"
        :fullscreen-stage="fullscreenStage"
        :on-view-preset="onViewPreset"
        :callouts="callouts"
        :select-device-from-callout="selectDeviceFromCallout"
        :device-count="deviceCount"
        :running-count="runningCount"
        :active-alarm-count="activeAlarmCount"
        :daq-twins="daqTwins"
        :health-pct="healthPct"
        :scene-empty="sceneEmpty"
        :selected-channel="selectedChannel"
        :channel-panel-tab="channelPanelTab"
        :channel-members="channelMembers"
        :agent-models="agentModels"
        :panel-pos="panelPos"
        :slider-pct="sliderPct"
        :hash-color="hashColor"
        :on-panel-grip-down="onPanelGripDown"
        :open-channel-tab="openChannelTab"
        :apply-boundary-draft="applyBoundaryDraft"
        :bind-member-model="bindMemberModel"
        :save-channel-layout="saveChannelLayout"
        :remove-channel-from-scene="removeChannelFromScene"
        :on-select-channel="onSelectChannel"
        :entities="entities"
        :quality-mode="qualityMode"
        :fps-cap="fpsCap"
        :quality-options="QUALITY_OPTIONS"
        :fps-options="FPS_OPTIONS"
        :exposure="exposure"
        :tint-opacity="tintOpacity"
        :snap="snap"
        :estop="estop"
        :set-quality-mode="setQualityMode"
        :set-fps-cap="setFpsCap"
        :on-exposure-input="onExposureInput"
        :on-tint-input="onTintInput"
        :toggle-snap="toggleSnap"
        :on-reset-view="onResetView"
        :save-layout="saveLayout"
        :toggle-estop="toggleEstop"
        :trend-chips="trendChips"
        :trend-overflow="trendOverflow"
        :trend-on="trendOn"
        :trend-color="trendColor"
        :toggle-trend="toggleTrend"
        :set-trend-canvas="setTrendCanvas"
      />

      <!-- 右轨:Inspector / 设备运行状态 / 关键设备 / 实时事件 / 导航 -->
      <TownRightRail
        v-model:obj-name-draft="objNameDraft"
        v-model:bind-pick="bindPick"
        v-model:daq-interval-draft="daqIntervalDraft"
        v-model:dcw-write-drafts="dcwWriteDrafts"
        v-model:dcw-bind-pick="dcwBindPick"
        v-model:agent-range-draft="agentRangeDraft"
        v-model:agent-bind-kind="agentBindKind"
        v-model:agent-bind-node-id="agentBindNodeId"
        v-model:agent-bind-mode="agentBindMode"
        v-model:approval-comments="approvalComments"
        :sheet-open="sheetOpen"
        :close-sheet="closeSheet"
        :mode="mode"
        :selected="selected"
        :selected-is-daq="selectedIsDaq"
        :selected-is-dcw="selectedIsDcw"
        :selected-agent-role-label="selectedAgentRoleLabel"
        :selected-agent-meta="selectedAgentMeta"
        :close-scale="closeScale"
        :device-twins="deviceTwins"
        :device-models="deviceModels"
        :daq="daq"
        :dcw="dcw"
        :selected-dcw-node="selectedDcwNode"
        :selected-dcw-window="selectedDcwWindow"
        :selected-dcw-device-name="selectedDcwDeviceName"
        :dcw-write-errs="dcwWriteErrs"
        :dcw-win-label="dcwWinLabel"
        :dcw-win-input-ph="dcwWinInputPh"
        :is-legacy-daq-twin="isLegacyDaqTwin"
        :do-write-selected-dcw="doWriteSelectedDcw"
        :bind-selected-dcw="bindSelectedDcw"
        :unbind-selected-dcw="unbindSelectedDcw"
        :daq-bound-device-name="daqBoundDeviceName"
        :selected-daq-node="selectedDaqNode"
        :selected-daq-sim="selectedDaqSim"
        :fmt-daq="fmtDaq"
        :on-daq-interval-commit="onDaqIntervalCommit"
        :on-daq-threshold-commit="onDaqThresholdCommit"
        :remove-selected-device="removeSelectedDevice"
        :unbind-daq="unbindDaq"
        :bind-daq="bindDaq"
        :daq-templates="daqTemplates"
        :daq-bind-choices="daqBindChoices"
        :daq-bind-choice-count="daqBindChoiceCount"
        :bind-pop-open="bindPopOpen"
        :bind-pop-max-h="bindPopMaxH"
        :toggle-bind-pop="toggleBindPop"
        :bind-daq-choice="bindDaqChoice"
        :set-spark-ref="setSparkRef"
        :on-obj-name-commit="onObjNameCommit"
        :bind-device-model="bindDeviceModel"
        :bound-daq-rows="boundDaqRows"
        :bound-dcw-rows="boundDcwRows"
        :dcw-templates="dcwTemplates"
        :dcw-bind-choices="dcwBindChoices"
        :dcw-bind-choice-count="dcwBindChoiceCount"
        :dcw-bind-pop-open="dcwBindPopOpen"
        :dcw-mark-pct="dcwMarkPct"
        :do-dcw-write="doDcwWrite"
        :unbind-dcw="unbindDcw"
        :bind-dcw-choice="bindDcwChoice"
        :t-mode="tMode"
        :device-delete-armed="deviceDeleteArmed"
        :set-t-mode="setTMode"
        :on-scale-input="onScaleInput"
        :on-scale-commit="onScaleCommit"
        :agent-models="agentModels"
        :agent-chat-title="agentChatTitle"
        :agent-chat-color="agentChatColor"
        :agent-chat-state-label="agentChatStateLabel"
        :selected-agent-role-tag="selectedAgentRoleTag"
        :agent-drawing-range="agentDrawingRange"
        :agent-range-status-text="agentRangeStatusText"
        :agent-history="agentHistory"
        :agent-chat-rows="agentChatRows"
        :history-loading="historyLoading"
        :fmt-time="fmtTime"
        :chat-kind-label="chatKindLabel"
        :on-refresh-history="onRefreshHistory"
        :on-toggle-range-draw="onToggleRangeDraw"
        :apply-agent-range-draft="applyAgentRangeDraft"
        :on-agent-range-commit="onAgentRangeCommit"
        :on-clear-agent-range="onClearAgentRange"
        :bind-agent-model="bindAgentModel"
        :set-chat-scroll="setChatScroll"
        :agent-bindings="agentBindings"
        :pending-approvals="pendingApprovals"
        :approval-remaining-sec="approvalRemainingSec"
        :binding-node-name="bindingNodeName"
        :set-binding-mode="setBindingMode"
        :unbind-agent-node="unbindAgentNode"
        :bind-agent-node="bindAgentNode"
        :decide-approval="decideApproval"
        :health-pct="healthPct"
        :health-tone="healthTone"
        :idle-count="idleCount"
        :alarm-count="alarmCount"
        :offline-count="offlineCount"
        :running-count="runningCount"
        :set-donut-canvas="setDonutCanvas"
        :daq-live="daqLive"
        :dcw-live="dcwLive"
        :on-focus-device="onFocusDevice"
        :alarms="alarms"
        :alarm-states="ALARM_STATES"
        :advance-alarm="advanceAlarm"
        :active-alarm-count="activeAlarmCount"
        :clear-alarms="clearAlarms"
        :ticker="ticker"
        :minimap="minimap"
        :nav-scale="navScale"
        :scene3d-ref="scene3dRef"
        :set-nav-canvas="setNavCanvas"
        :on-nav-down="onNavDown"
        :on-nav-move="onNavMove"
        :on-nav-up="onNavUp"
        :on-nav-wheel="onNavWheel"
        :on-reset-view="onResetView"
      />
    </div>

    <TownStatusBar
      :conn-state="conn.state"
      :syncing="syncing"
      :block-count="blockCount"
      :agent-count="agentCount"
      :device-count="deviceCount"
      :fps="fps"
    />

    <!-- 窄屏抽屉遮罩:点击空白关闭(与 AppSidebar 同一套抽屉协议) -->
    <div
      v-if="sheetOpen"
      class="sheet-mask"
      @click="closeSheet"
    />

    <!-- 加载遮罩(全页) -->
    <TownLoadingMask :ready="ready" />
  </div>
</template>

<style scoped>
/* ============================================================
 * DIGITAL TWIN · 控制室设计令牌(--hud-*)+ 根壳
 * topnav 50 / 三栏网格(250 · 1fr · 342) / dock / statusbar 30
 *
 * 令牌必须定义在真正带本组件 scope id 的根元素上:scoped 会把选择器编译为
 * .town-view[data-v-<TownView>],只有本文件的根 div 同时具备该 class 与 scope id;
 * 放在子组件(TownTopNav)里的同名规则永远匹配不到,会让全视图 var(--hud-*) 失效。
 * 令牌经 CSS 自定义属性继承覆盖整个视图,子组件照常消费。
 * ============================================================ */
.town-view {
  --hud-bg: #070b13;
  --hud-panel: #0d1420;
  --hud-panel-2: #111a2b;
  --hud-panel-raised: #152034;
  --hud-panel-hover: #16233a;
  --hud-line: #1d2a42;
  --hud-line-soft: #16202f;
  --hud-line-hi: #2c4568;
  --hud-input: #0a111d;
  --hud-text: #e8eef8;
  --hud-dim: #8fa0b5;
  --hud-faint: #5f6e84;
  --hud-accent: #35e0a0;
  --hud-accent-dim: #1f9e6e;
  --hud-cyan: #41c8f4;
  --hud-amber: #f6c453;
  --hud-ok: #35e0a0;
  --hud-danger: #ff6b6b;
  --hud-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
  --hud-ease: cubic-bezier(0.22, 0.68, 0.36, 1);
  --hud-r-sm: 8px;
  --hud-r-md: 10px;
  --hud-r-lg: 12px;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--hud-bg);
  color: var(--hud-text);
  font-family: var(--font-body);
  font-size: 13px;
}
/* ── 孪生 HUD 字号地板(桌面档) ────────────────────────────────────────────
 * 9px 徽标字在暗底上不可读;桌面档统一抬到 ≥10px,窄屏再抬一档(见媒体查询)。
 * 例外:仅纯装饰性小字保留 9px。 */
.town-view small {
  font-size: 10px;
}
/* ===== 三栏应用区 ===== */
.app {
  flex: 1;
  min-height: 0;
  display: grid;
  /* 轨道随视口收缩(clamp):1440 下仍是 250 / 342(外观不变),
   * 1024–1131 区间不再因 minmax(540px) 把右轨挤出视口 */
  grid-template-columns: clamp(212px, 19vw, 250px) minmax(0, 1fr) clamp(284px, 26vw, 342px);
}
/* ===== 状态栏(已抽为 components/TownStatusBar.vue)===== */
/* 滚动条 */
.town-view ::-webkit-scrollbar { width: 8px; height: 8px; }
.town-view ::-webkit-scrollbar-track { background: transparent; }
.town-view ::-webkit-scrollbar-thumb { background: #1c2942; border-radius: 4px; border: 2px solid #080d16; }
.town-view ::-webkit-scrollbar-thumb:hover { background: #2c4568; }
.sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 69;
  background: rgba(3, 6, 12, 0.62);
  backdrop-filter: blur(1.5px);
}

/* ═══════════════════════════════════════════════════════════════
 * 窄屏(≤1023)= 手持巡检终端,而不是"缩小的控制室":
 *   · 3D 舞台占满视口宽度,纵向吃满顶栏/状态栏之间的全部高度;
 *   · 左右轨从固定侧栏改为底部抽屉页(sheet),顶栏两个按钮开合
 *     (遮罩 / Esc / 点空白关闭,协议与 AppSidebar 抽屉一致);
 *   · 底部坞折成可收起的横条,默认收起,不再压舞台;
 *   · 刻度字号地板:标签 ≥11.5px、正文 ≥13px;可点目标 ≥40px。
 * 断点与 useResponsive(≥1024 桌面)同源;形态全部由 CSS 决定。
 * ═══════════════════════════════════════════════════════════════ */
@media (max-width: 1023px) {
  /* 窄屏对比度地板:--hud-faint(#5f6e84)在深面板上只有 3.6:1,
   * 窄屏(强光/手持)抬到 ≥7:1;桌面配色不动 */
  .town-view { --hud-faint: #8b9bb0; }
  /* ── 三栏 → 单栏:舞台全宽、吃满高度 ── */
  .app { grid-template-columns: minmax(0, 1fr); }
  /* ── 刻度字号地板:标签 ≥11.5px(窄屏不允许 8.5–10px 徽标字) ── */
  .town-view :where(
    .panel-tag, .daq-code, .daq-count, .daq-caret, .node-val, .node-dev, .daq-empty-hint,
    .scene-meta, .scene-cur, .scene-add, .scene-hint, .co-label, .co-range, .lg-chip, .lg-more,
    .ins-chip, .sect-hd, .obj-label, .range-status, .obj-mini, .bp-val, .seg-btn, .scale-min,
    .scale-max, .scale-val, .ins-empty, .donut-center span, .ev-time, .ev-name, .ev-text,
    .event-empty, .rail-empty, .al-src, .al-state, .mm-meta, .chat-state, .chat-role,
    .chat-harness, .chat-count, .rpg-divider, .rpg-time, .rpg-kind, .ty-label, .rpg-note,
    .bp-sub, .bp-tab, .bp-label, .bp-hint, .bp-btn, .member-ava, .member-role, .member-select,
    .bind-label, .bind-val, .bp-tpl, .bp-cur, .bp-empty, .dcw-name, .dcw-tag, .dcw-win-num,
    .dcw-send, .dcw-err, .bind-select, .bind-add-btn, .daq-ctl-cycle, .daq-num, .daq-th-inputs,
    .approval-ttl, .approval-detail, .dcw-write input::placeholder
  ) { font-size: 11.5px; }
  /* ── 正文 ≥13px ── */
  .town-view :where(
    .daq-name, .scene-name, .al-txt, .ev-text, .chat-name, .co-val, .rpg-text, .daq-info-row,
    .daq-ctl-btn, .rail-empty, .rpg-note, .member-name, .bind-label, .dcw-cur
  ) { font-size: 13px; }
}
</style>
