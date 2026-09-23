<script setup lang="ts">
/**
 * 小镇视图 · 右轨(检查器 / 设备运行状态 / 关键设备 / 实时事件 / 导航)。
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);画布/滚动容器仍由父组件持有并经 setter 回填;
 * 样式为本组件模板专属规则,随模板一并搬移。
 */
import TownDcwNodeInspector from './TownDcwNodeInspector.vue'
import TownDaqNodeInspector from './TownDaqNodeInspector.vue'
import TownDeviceBindings from './TownDeviceBindings.vue'
import TownDcwBindSection from './TownDcwBindSection.vue'
import TownDeviceTransform from './TownDeviceTransform.vue'
import TownAgentInspector from './TownAgentInspector.vue'
import TownHealthBody from './TownHealthBody.vue'
import TownAlarmList from './TownAlarmList.vue'
import TownEventList from './TownEventList.vue'
import TownNavMap from './TownNavMap.vue'
import WorkshopDeviceTwinPanel from '@/app/components/workshop/DeviceTwinPanel.vue'

import type { TownRightRailProps } from '@/app/composables/workshop/town/town-relay-props'

const objNameDraft = defineModel<string>('objNameDraft', { required: true })
const bindPick = defineModel<string>('bindPick', { required: true })
const daqIntervalDraft = defineModel<number | null>('daqIntervalDraft', { required: true })
const dcwWriteDrafts = defineModel<Record<string, number | ''>>('dcwWriteDrafts', { required: true })
const dcwBindPick = defineModel<string>('dcwBindPick', { required: true })
const agentRangeDraft = defineModel<{ radiusX: number, radiusZ: number, shape: 'ellipse' | 'rect' } | null>('agentRangeDraft', { required: true })
const agentBindKind = defineModel<'dcw' | 'daq'>('agentBindKind', { required: true })
const agentBindNodeId = defineModel<string>('agentBindNodeId', { required: true })
const agentBindMode = defineModel<'auto' | 'manual'>('agentBindMode', { required: true })
const approvalComments = defineModel<Record<string, string>>('approvalComments', { required: true })

defineProps<TownRightRailProps>()
</script>

<template>
  <aside
    id="town-rail-right"
    class="rail rail-right"
    :class="{ 'sheet-open': sheetOpen === 'right' }"
  >
    <!-- 窄屏抽屉头(桌面档 CSS 隐藏) -->
    <div class="sheet-hd">
      <span
        class="sheet-grip"
        aria-hidden="true"
      />
      <span class="sheet-hd-t">{{ $t('townView.k17dkhgd112') }}</span>
      <button
        type="button"
        class="sheet-x"
        :aria-label="$t('common.close')"
        @click="closeSheet"
      >
        ✕
      </button>
    </div>
    <Transition name="ins">
      <section
        v-if="selected"
        class="panel inspector"
      >
        <div class="panel-hd">
          <h3>{{ selected.kind === 'device' ? (selectedIsDcw ? $t('townView.k1ekqxlt146') : selectedIsDaq ? $t('townView.k1empnnb178') : $t('townView.k1k6wg8j185')) : selectedAgentRoleLabel }}</h3>
          <button
            class="mini-btn"
            :title="$t('townView.k1bsckft013')"
            @click="closeScale"
          >
            ✕
          </button>
        </div>

        <div class="ins-chip-row">
          <span class="ins-chip mono">{{ selected.id.slice(0, 8) }}</span>
          <span
            v-if="selected.kind === 'device' && selectedIsDaq"
            class="ins-chip accent"
          >DAQ</span>
          <span
            v-else-if="selected.kind === 'device' && selectedIsDcw"
            class="ins-chip accent"
          >DCW</span>
        </div>

        <template v-if="selected.kind === 'device'">
          <TownDcwNodeInspector
            v-if="selectedIsDcw"
            v-model:dcw-write-drafts="dcwWriteDrafts"
            v-model:dcw-bind-pick="dcwBindPick"
            :mode="mode"
            :selected="selected"
            :device-twins="deviceTwins"
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
          />
          <TownDaqNodeInspector
            v-else-if="selectedIsDaq"
            v-model:bind-pick="bindPick"
            v-model:daq-interval-draft="daqIntervalDraft"
            :mode="mode"
            :selected="selected"
            :device-twins="deviceTwins"
            :daq="daq"
            :daq-bound-device-name="daqBoundDeviceName"
            :selected-daq-node="selectedDaqNode"
            :selected-daq-sim="selectedDaqSim"
            :fmt-daq="fmtDaq"
            :is-legacy-daq-twin="isLegacyDaqTwin"
            :on-daq-interval-commit="onDaqIntervalCommit"
            :on-daq-threshold-commit="onDaqThresholdCommit"
            :remove-selected-device="removeSelectedDevice"
            :unbind-daq="unbindDaq"
            :bind-daq="bindDaq"
          />
          <template v-else>
            <TownDeviceBindings
              v-model:obj-name-draft="objNameDraft"
              :mode="mode"
              :selected="selected"
              :scene-3d-ref="scene3dRef"
              :device-models="deviceModels"
              :bound-daq-rows="boundDaqRows"
              :daq-templates="daqTemplates"
              :daq-bind-choices="daqBindChoices"
              :daq-bind-choice-count="daqBindChoiceCount"
              :bind-pop-open="bindPopOpen"
              :bind-pop-max-h="bindPopMaxH"
              :toggle-bind-pop="toggleBindPop"
              :bind-daq-choice="bindDaqChoice"
              :unbind-daq="unbindDaq"
              :set-spark-ref="setSparkRef"
              :on-obj-name-commit="onObjNameCommit"
              :bind-device-model="bindDeviceModel"
            />
            <TownDcwBindSection
              v-model:dcw-write-drafts="dcwWriteDrafts"
              :mode="mode"
              :dcw="dcw"
              :bound-dcw-rows="boundDcwRows"
              :dcw-templates="dcwTemplates"
              :dcw-bind-choices="dcwBindChoices"
              :dcw-bind-choice-count="dcwBindChoiceCount"
              :dcw-bind-pop-open="dcwBindPopOpen"
              :bind-pop-max-h="bindPopMaxH"
              :dcw-write-errs="dcwWriteErrs"
              :dcw-mark-pct="dcwMarkPct"
              :do-dcw-write="doDcwWrite"
              :unbind-dcw="unbindDcw"
              :toggle-bind-pop="toggleBindPop"
              :bind-dcw-choice="bindDcwChoice"
            />
            <TownDeviceTransform
              :mode="mode"
              :selected="selected"
              :t-mode="tMode"
              :device-delete-armed="deviceDeleteArmed"
              :set-t-mode="setTMode"
              :on-scale-input="onScaleInput"
              :on-scale-commit="onScaleCommit"
              :remove-selected-device="removeSelectedDevice"
            />
          </template>
        </template>

        <TownAgentInspector
          v-else-if="selected.kind === 'agent'"
          v-model:agent-range-draft="agentRangeDraft"
          v-model:agent-bind-kind="agentBindKind"
          v-model:agent-bind-node-id="agentBindNodeId"
          v-model:agent-bind-mode="agentBindMode"
          v-model:approval-comments="approvalComments"
          :mode="mode"
          :selected="selected"
          :scene-3d-ref="scene3dRef"
          :agent-models="agentModels"
          :agent-role="selectedAgentMeta?.role ?? null"
          :agent-state="selectedAgentMeta?.state ?? null"
          :agent-harness="selectedAgentMeta?.harness ?? null"
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
          :daq="daq"
          :dcw="dcw"
        />
      </section>
    </Transition>

    <section class="panel">
      <div class="panel-hd">
        <h3>{{ $t('townView.k17dkhgd112') }}</h3>
      </div>
      <TownHealthBody
        :health-pct="healthPct"
        :health-tone="healthTone"
        :idle-count="idleCount"
        :alarm-count="alarmCount"
        :offline-count="offlineCount"
        :running-count="runningCount"
        :set-canvas="setDonutCanvas"
      />
    </section>

    <section class="panel">
      <div class="panel-hd">
        <h3>{{ $t('townView.k1q247fn117') }}</h3>
        <span class="panel-tag">{{ deviceTwins.twins.length }}</span>
      </div>
      <WorkshopDeviceTwinPanel
        class="kd-embed"
        :daq-live="daqLive"
        :dcw-live="dcwLive"
        @focus-device="onFocusDevice"
      />
    </section>

    <section class="panel">
      <div class="panel-hd">
        <h3>{{ $t('townView.k1cxf749118') }}</h3>
        <span class="panel-tag">{{ activeAlarmCount }} {{ $t('townView.k4dfq040') }}</span>
        <button
          class="mini-btn"
          :title="$t('townView.k1bkswpz022')"
          @click="clearAlarms"
        >
          ✓
        </button>
      </div>
      <TownAlarmList
        :alarms="alarms"
        :alarm-states="alarmStates"
        :advance-alarm="advanceAlarm"
      />
    </section>

    <section class="panel">
      <div class="panel-hd">
        <h3>{{ $t('townView.k1cxdtq2120') }}</h3>
        <span class="panel-tag">{{ ticker.length }}</span>
      </div>
      <TownEventList
        :ticker="ticker"
        :fmt-time="fmtTime"
      />
    </section>

    <section class="panel">
      <div class="panel-hd">
        <h3>{{ $t('townView.kjug2jq122') }}</h3>
      </div>
      <TownNavMap
        :minimap="minimap"
        :nav-scale="navScale"
        :scene-3d-ref="scene3dRef"
        :set-canvas="setNavCanvas"
        :on-nav-down="onNavDown"
        :on-nav-move="onNavMove"
        :on-nav-up="onNavUp"
        :on-nav-wheel="onNavWheel"
        :on-reset-view="onResetView"
      />
    </section>
  </aside>
</template>

<style scoped>
.rail {
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* 轨道微渐变:与场景天穹同族的纵深(左轨亮→右轨暗,视线向舞台聚焦) */
  background: linear-gradient(180deg, #0a101c 0%, #080d16 100%);
}
.rail-right { border-left: 1px solid var(--hud-line-soft); }
.rail::-webkit-scrollbar { width: 8px; }
.rail::-webkit-scrollbar-thumb { background: #1c2942; border-radius: 4px; border: 2px solid #080d16; }
.rail::-webkit-scrollbar-track { background: transparent; }
/* Inspector 入场(occasional;空间一致性 = 面板属于右轨,自右缘滑入;
 * 退场对称快出;reduced-motion 全局收敛) */
.ins-enter-active {
  transition:
    opacity 200ms var(--hud-ease),
    transform 200ms var(--hud-ease);
}
.ins-leave-active { transition: opacity 120ms ease; }
.ins-enter-from { opacity: 0; transform: translateX(12px); }
.ins-leave-to { opacity: 0; }
.panel {
  position: relative;
  background: linear-gradient(180deg, #101827 0%, #0d1420 100%);
  border: 1px solid var(--hud-line);  border-radius: var(--hud-r-lg);
  padding: 12px;
  flex: none;
  /* 玻璃光泽:顶部内高光(面板上缘受光)+ 深色外投影(悬浮层次) */
  box-shadow:
    inset 0 1px 0 rgba(143, 176, 220, 0.07),
    0 10px 28px rgba(3, 7, 14, 0.45);
}
/* 面板顶部光泽扫光:与 topnav 呼吸光同 motif,让面板像仪表台玻璃 */
.panel::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 44px;
  border-radius: var(--hud-r-lg) var(--hud-r-lg) 0 0;
  background: linear-gradient(180deg, rgba(120, 165, 220, 0.055), transparent);
  pointer-events: none;
}
.panel-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.panel-hd h3 {
  position: relative;
  margin: 0;
  padding-left: 11px;
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  flex: 1;
}
/* 左缘数据条:与 3D 场景名牌(makeLabel)同一 motif,双端一致 */
.panel-hd h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 3px;
  height: 12px;
  transform: translateY(-50%);
  background: var(--hud-accent);
  border-radius: 2px;
  box-shadow: 0 0 8px color-mix(in srgb, var(--hud-accent) 45%, transparent);
}
.panel-tag {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--hud-cyan);
  background: rgba(65, 200, 244, 0.1);
  border: 1px solid rgba(65, 200, 244, 0.25);
  padding: 0 6px;
  border-radius: 6px;
  line-height: 15px;
}

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
/* ===== 右轨 ===== */
.inspector { animation: rise 0.18s var(--hud-ease); }
@keyframes rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}

/* ============================================================
 * 微交互抛光(丝滑:统一曲线 + 按压反馈 + 键盘焦点环 + 降级动画)
 * ============================================================ */
/* 按压态:轻微下沉,松手回弹(所有可点元件统一手感) */
.btn:active, .vp-tool:active, .mini-btn:active, .snap-toggle:active,
.lg-chip:active, .bind-add:active, .bind-x:active, .al-state:active,
.bp-btn:active, .obj-mini:active {
  transform: scale(0.96);
}
.btn, .vp-tool, .mini-btn, .snap-toggle, .lg-chip, .bind-add, .al-state, .bp-btn, .obj-mini {
  transition-property: filter, background, border-color, color, transform, opacity;
  transition-duration: 0.15s;
  transition-timing-function: var(--hud-ease);
}

/* 键盘可达:焦点环(设计稿 --focus-ring;补回 scoped 属性选择器降低的一档特异性,与 .town-view 规则同效) */
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--hud-bg), 0 0 0 4px rgba(65, 200, 244, 0.45);
  border-radius: 6px;
}

/* 视口标题明确亮色(避免继承发灰) */
/* E-STOP armed 呼吸(设计稿 estop keyframes) */
/* 减少动态偏好:关停入场/呼吸动画 */
@media (prefers-reduced-motion: reduce) {
  .inspector, .callout { animation: none; }
}

/* ============================================================
 * 窄屏形态零件(≥1024 桌面一律不出现:形态由下面的媒体查询切换)
 * ============================================================ */
.sheet-btn,
.dock-toggle,
.sheet-hd { display: none; }

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
  /* ── 左右轨 → 底部抽屉页(sheet) ── */
  .rail {
    position: fixed;
    left: 0;
    right: 0;
    top: auto;
    bottom: 0;
    z-index: 70;
    width: auto;
    max-height: min(76dvh, 640px);
    padding: 0 10px 12px;
    gap: 8px;
    overflow-y: auto;
    overscroll-behavior: contain;
    border: 0;
    border-top: 1px solid var(--hud-line-hi);
    border-radius: 16px 16px 0 0;
    background: linear-gradient(180deg, #0c1420 0%, #080d16 46%);
    box-shadow: 0 -18px 46px rgba(0, 0, 0, 0.6);
    transform: translateY(103%);
    visibility: hidden;
    /* 关门:位移走完再隐藏(离散属性用延时);开门:立即可见 */
    transition: transform 0.26s var(--hud-ease), visibility 0s linear 0.26s;
  }
  .rail.sheet-open {
    transform: none;
    visibility: visible;
    transition: transform 0.26s var(--hud-ease), visibility 0s;
  }
  .rail-left,
  .rail-right { border-right: 0; border-left: 0; }
  .rail .panel { flex: none; }
  .sheet-hd {
    display: flex;
    align-items: center;
    gap: 8px;
    position: sticky;
    top: 0;
    z-index: 2;
    margin: 0 -10px 2px;
    padding: 13px 12px 9px;
    background: linear-gradient(180deg, #0e1725, #0c1420);
    border-bottom: 1px solid var(--hud-line-soft);
  }
  .sheet-grip {
    position: absolute;
    left: 50%;
    top: 6px;
    width: 40px;
    height: 3px;
    margin-left: -20px;
    border-radius: 2px;
    background: #2c4568;
  }
  .sheet-hd-t { font-size: 13px; font-weight: 700; color: var(--hud-text); letter-spacing: 0.04em; }
  .sheet-x {
    margin-left: auto;
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: 8px;
    border: 1px solid var(--hud-line);
    background: #101a2b;
    color: var(--hud-dim);
    font-size: 15px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rail { transition: none; }
}

/* ── 触摸目标:窄屏所有可点元件 ≥40px 高(与 .town-view button 同效) ── */
@media (max-width: 1023px) {
  button { min-height: 40px; }
}
</style>
