<script setup lang="ts">
/**
 * 小镇视图 · 舞台列(3D 舞台 + 覆盖层 + 底部坞)。
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者);
 * 舞台/宿主的 DOM 引用由父组件经 setStageRef/setHostRef 回填,父组件的
 * stageRef/hostRef 语义不变;加载遮罩改为复用 TownLoadingMask(形态一致)。
 */
import TownStageTop from './TownStageTop.vue'
import TownCalloutLayer from './TownCalloutLayer.vue'
import TownKpiStrip from './TownKpiStrip.vue'
import TownBoundaryPanel from './TownBoundaryPanel.vue'
import TownControlDock from './TownControlDock.vue'
import TownTrendDock from './TownTrendDock.vue'
import TownLoadingMask from './TownLoadingMask.vue'
import type { ChannelLayout } from '@/app/components/workshop/town/TownScene3D'

import type { TownStageProps } from '@/app/composables/workshop/town/town-relay-props'

const showCallouts = defineModel<boolean>('showCallouts', { required: true })
const boundaryDraft = defineModel<ChannelLayout | null>('boundaryDraft', { required: true })
const dockOpen = defineModel<boolean>('dockOpen', { required: true })
const threshPct = defineModel<number>('threshPct', { required: true })
const calloutNearDist = defineModel<number>('calloutNearDist', { required: true })
const trendExpanded = defineModel<boolean>('trendExpanded', { required: true })

defineProps<TownStageProps>()
</script>

<template>
  <main class="stage-col">
    <div
      :ref="setStageRef"
      class="stage"
    >
      <div
        id="town-host"
        :ref="setHostRef"
        class="town-host"
      />
      <div class="stage-vignette" />

      <TownStageTop
        v-model:show-callouts="showCallouts"
        :active-channel-name="activeChannelName"
        :view-preset="viewPreset"
        :orbit-on="orbitOn"
        :locate-selected="locateSelected"
        :toggle-orbit="toggleOrbit"
        :fullscreen-stage="fullscreenStage"
        :on-view-preset="onViewPreset"
      />

      <TownCalloutLayer
        :show-callouts="showCallouts"
        :callouts="callouts"
        :select-device-from-callout="selectDeviceFromCallout"
      />

      <TownKpiStrip
        :device-count="deviceCount"
        :running-count="runningCount"
        :active-alarm-count="activeAlarmCount"
        :channel-count="daqTwins.length"
        :health-pct="healthPct"
      />

      <div
        v-if="sceneEmpty"
        class="empty-hint"
      >
        <b>{{ $t('townView.k3rwxjc044') }}</b>
        <span>{{ $t('townView.k1sa1eaj045') }}</span>
      </div>

      <TownBoundaryPanel
        v-if="selectedChannel && boundaryDraft"
        v-model:boundary-draft="boundaryDraft"
        :selected-channel="selectedChannel"
        :channel-name="entities.channels[selectedChannel]?.name"
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
      />

      <!-- 反馈芯片 -->
      <div
        v-if="lastDropText"
        class="drop-chip"
      >
        {{ lastDropText }}
      </div>
      <div
        v-if="errorText"
        class="error-chip"
      >
        {{ errorText }}
      </div>

      <!-- 加载遮罩 -->

      <TownLoadingMask :ready="ready" />
    </div>

    <!-- 底部坞:场景控制(渲染/环境/操作 三组仪表分区) + 趋势分析 -->
    <div
      class="dock"
      :class="{ 'dock-open': dockOpen }"
    >
      <TownControlDock
        v-model:dock-open="dockOpen"
        v-model:thresh-pct="threshPct"
        v-model:callout-near-dist="calloutNearDist"
        :mode="mode"
        :quality-mode="qualityMode"
        :fps-cap="fpsCap"
        :quality-options="qualityOptions"
        :fps-options="fpsOptions"
        :exposure="exposure"
        :tint-opacity="tintOpacity"
        :snap="snap"
        :estop="estop"
        :slider-pct="sliderPct"
        :set-quality-mode="setQualityMode"
        :set-fps-cap="setFpsCap"
        :on-exposure-input="onExposureInput"
        :on-tint-input="onTintInput"
        :toggle-snap="toggleSnap"
        :on-reset-view="onResetView"
        :save-layout="saveLayout"
        :toggle-estop="toggleEstop"
      />

      <TownTrendDock
        v-model:trend-expanded="trendExpanded"
        :channel-count="daqTwins.length"
        :trend-chips="trendChips"
        :trend-overflow="trendOverflow"
        :trend-on="trendOn"
        :trend-color="trendColor"
        :toggle-trend="toggleTrend"
        :set-canvas="setTrendCanvas"
      />
    </div>
  </main>
</template>

<style scoped>
/* ===== 舞台 ===== */
.stage-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.stage { flex: 1; position: relative; min-height: 320px; background: #060a11; overflow: hidden; }
.stage:fullscreen { border-radius: 0; }
.town-host { position: absolute; inset: 0; }
.town-host canvas { display: block; image-rendering: auto; }
.stage-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 3;
  background:
    radial-gradient(120% 90% at 50% 38%, transparent 52%, rgba(2, 4, 9, 0.5) 100%),
    linear-gradient(180deg, rgba(8, 13, 24, 0.32), transparent 18%),
    repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.012) 0 1px, transparent 1px 3px);
}
.empty-hint {
  position: absolute;
  left: 50%;
  top: 44%;
  transform: translate(-50%, -50%);
  z-index: 4;
  text-align: center;
  color: var(--hud-dim);
  pointer-events: none;
}
.empty-hint b { color: var(--hud-text); font-size: 14px; display: block; margin-bottom: 4px; }
.empty-hint span { font-size: 12px; }

/* ── HUD 上电进场(夜航仪 Boot 序列):左轨 → 右轨 → 底部坞 依次浮现,
 *    一次编排好的 page load,而非散落微交互;reduced-motion 全收敛。── */
@media (prefers-reduced-motion: no-preference) {
  .rail-left,
  .rail-right,
  .dock {
    animation: hud-boot 0.52s cubic-bezier(0.22, 0.68, 0.36, 1) backwards;
  }
  .rail-left { animation-delay: 0.04s; }
  .rail-right { animation-delay: 0.15s; }
  .dock { animation-delay: 0.26s; }
}

@keyframes hud-boot {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* ===== 底部坞 ===== */
.dock {
  flex: none;
  display: grid;
  grid-template-columns: 308px 1fr;
  gap: 10px;
  padding: 10px;
  background: #080d16;
  border-top: 1px solid var(--hud-line-soft);
}
.dock-card {
  background: linear-gradient(180deg, #101827 0%, #0d1420 100%);
  border: 1px solid var(--hud-line);
  border-radius: var(--hud-r-lg);
  padding: 12px 14px;
  min-height: 178px;
  display: flex;
  flex-direction: column;
}
/* 芯片(Toast 风) */
.drop-chip, .error-chip {
  position: absolute;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 14px;
  font-size: 11.5px;
  background: rgba(14, 22, 38, 0.96);
  border: 1px solid #2a3d63;
  border-radius: var(--hud-r-md);
  box-shadow: var(--hud-shadow);
  backdrop-filter: blur(8px);
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drop-chip { color: var(--hud-accent); }
.error-chip { color: var(--hud-danger); border-color: rgba(255, 107, 107, 0.4); }

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
  .stage-col { min-height: 0; }
  .stage { min-height: 0; }
  /* ── 底部坞:可收起横条(默认收起,舞台优先) ── */
  .dock { display: block; padding: 0; }
  .dock .dock-card { display: none; }
  .dock.dock-open { padding: 8px; max-height: 52dvh; overflow-y: auto; overscroll-behavior: contain; }
  .dock.dock-open .dock-card { display: flex; min-height: 0; margin-bottom: 8px; }
  .dock.dock-open .dock-card:last-child { margin-bottom: 0; }
  .dock-card { padding: 12px; }
}

/* ── <640 单列档:进一步让位给舞台(品牌文字收成徽记,名字收进头像) ── */
@media (max-width: 639px) {
  .dock.dock-open { max-height: 58dvh; }
}
</style>
