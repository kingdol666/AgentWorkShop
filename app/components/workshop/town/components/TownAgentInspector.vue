<script setup lang="ts">
/**
 * 小镇视图 · 右轨检查器 · 角色分支(身份牌 / 模型 / 活动范围 / 会话记录)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
import type { TownScene3D } from '../TownScene3D'
import type { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import type { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import type { AgentNodeBindingRow, ChatEntry, ToolApprovalRow, TownModelRow } from '@/app/composables/workshop/town/town-view-types'
// 子组件(同目录,必须显式引入:Nuxt 自动引入按路径前缀命名,不产出裸组件名)
import TownAgentBindings from './TownAgentBindings.vue'

const agentRangeDraft = defineModel<{ radiusX: number, radiusZ: number, shape: 'ellipse' | 'rect' } | null>('agentRangeDraft', { required: true })
const agentBindKind = defineModel<'dcw' | 'daq'>('agentBindKind', { required: true })
const agentBindNodeId = defineModel<string>('agentBindNodeId', { required: true })
const agentBindMode = defineModel<'auto' | 'manual'>('agentBindMode', { required: true })
const approvalComments = defineModel<Record<string, string>>('approvalComments', { required: true })

defineProps<{
  mode: 'browse' | 'edit'
  selected: { kind: 'agent' | 'device', id: string, scale: number, rotation: number }
  scene3dRef: TownScene3D | null
  agentModels: TownModelRow[]
  agentRole: string | null
  agentState: string | null
  agentHarness: string | null
  agentChatTitle: string
  agentChatColor: string
  agentChatStateLabel: string
  selectedAgentRoleTag: string
  agentDrawingRange: boolean
  agentRangeStatusText: string
  agentHistory: ChatEntry[]
  agentChatRows: ChatEntry[]
  historyLoading: boolean
  fmtTime: (at?: number) => string
  chatKindLabel: (kind: string) => string
  onRefreshHistory: () => void
  onToggleRangeDraw: () => void
  applyAgentRangeDraft: () => void
  onAgentRangeCommit: () => void
  onClearAgentRange: () => void
  bindAgentModel: (modelRef: string) => void
  setChatScroll: (el: Element | ComponentPublicInstance | null) => void
  agentBindings: AgentNodeBindingRow[]
  pendingApprovals: ToolApprovalRow[]
  approvalRemainingSec: (ap: ToolApprovalRow) => number
  bindingNodeName: (b: AgentNodeBindingRow) => string
  setBindingMode: (id: string, mode: 'auto' | 'manual') => void
  unbindAgentNode: (id: string) => void
  bindAgentNode: () => void
  decideApproval: (id: string, approved: boolean) => void
  daq: ReturnType<typeof useDaqStream>
  dcw: ReturnType<typeof useDcwStream>
}>()
</script>

<template>
  <div class="chat-id-row">
    <span
      class="chat-badge"
      :style="{ '--p-acc': agentChatColor }"
    >{{ agentChatTitle.slice(0, 1).toUpperCase() }}</span>
    <div class="chat-nameplate">
      <span class="chat-name">{{ agentChatTitle }}</span>
      <span class="chat-meta">
        <span
          class="chat-role"
          :class="agentRole === 'lead' ? 'r-lead' : 'r-worker'"
        >{{ selectedAgentRoleTag }}</span>
        <span
          class="chat-state"
          :class="`s-${agentState ?? 'idle'}`"
        >{{ agentChatStateLabel }}</span>
        <span
          v-if="agentHarness"
          class="chat-harness"
        >{{ agentHarness.toUpperCase() }}</span>
        <span class="chat-count">{{ agentHistory.length + agentChatRows.length }} {{ $t('townView.k4dfq040') }}</span>
      </span>
    </div>
  </div>
  <div class="obj-row">
    <span class="obj-label">{{ $t('townView.k41amp083') }}</span>
    <select
      class="obj-select"
      :value="(scene3dRef?.getAgentModel?.(selected.id) ?? '') || 'hero-3d'"
      :disabled="mode !== 'edit'"
      @change="bindAgentModel(($event.target as HTMLSelectElement).value)"
    >
      <option
        v-for="m in agentModels"
        :key="m.id"
        :value="m.id"
      >
        {{ m.name }}
      </option>
    </select>
  </div>
  <div class="obj-sep" />
  <div class="obj-row">
    <span class="obj-label">{{ $t('townView.k1fix3hb093') }}</span>
    <span class="range-status">{{ agentRangeStatusText }}</span>
    <button
      v-if="mode === 'edit'"
      class="obj-mini"
      :class="{ on: agentDrawingRange }"
      :title="$t('townView.k13enoy3018')"
      @click="onToggleRangeDraw"
    >
      {{ agentDrawingRange ? $t('townView.k3slzhc153') : $t('townView.k1f1xmci183') }}
    </button>
  </div>
  <TownAgentBindings
    v-model:agent-bind-kind="agentBindKind"
    v-model:agent-bind-node-id="agentBindNodeId"
    v-model:agent-bind-mode="agentBindMode"
    v-model:approval-comments="approvalComments"
    :mode="mode"
    :agent-bindings="agentBindings"
    :pending-approvals="pendingApprovals"
    :approval-remaining-sec="approvalRemainingSec"
    :daq="daq"
    :dcw="dcw"
    :binding-node-name="bindingNodeName"
    :set-binding-mode="setBindingMode"
    :unbind-agent-node="unbindAgentNode"
    :bind-agent-node="bindAgentNode"
    :decide-approval="decideApproval"
  />
  <template v-if="agentRangeDraft && mode === 'edit'">
    <div class="obj-row">
      <span class="obj-label">{{ $t('townView.k3zhy5048') }}</span>
      <div class="bp-seg">
        <button
          class="seg-btn"
          :class="{ on: agentRangeDraft.shape === 'ellipse' }"
          @click="agentRangeDraft.shape = 'ellipse'; applyAgentRangeDraft()"
        >
          {{ $t('townView.k414bc049') }}
        </button>
        <button
          class="seg-btn"
          :class="{ on: agentRangeDraft.shape === 'rect' }"
          @click="agentRangeDraft.shape = 'rect'; applyAgentRangeDraft()"
        >
          {{ $t('townView.k43u0g050') }}
        </button>
      </div>
    </div>
    <div class="obj-row">
      <span class="obj-label">{{ $t('townView.k41lwj105') }}</span>
      <input
        v-model.number="agentRangeDraft.radiusX"
        class="obj-range"
        type="range"
        min="40"
        max="4000"
        step="8"
        @input="applyAgentRangeDraft"
        @change="onAgentRangeCommit"
      >
      <span class="bp-val">{{ Math.round(agentRangeDraft.radiusX) }}</span>
    </div>
    <div class="obj-row">
      <span class="obj-label">{{ $t('townView.k45bta106') }}</span>
      <input
        v-model.number="agentRangeDraft.radiusZ"
        class="obj-range"
        type="range"
        min="40"
        max="4000"
        step="8"
        @input="applyAgentRangeDraft"
        @change="onAgentRangeCommit"
      >
      <span class="bp-val">{{ Math.round(agentRangeDraft.radiusZ) }}</span>
    </div>
    <button
      class="obj-mini danger"
      @click="onClearAgentRange"
    >
      {{ $t('townView.k1w45mzc107') }}
    </button>
  </template>
  <div
    v-else
    class="ins-empty"
  >
    {{ $t('townView.k14s8urm108') }}
  </div>

  <!-- 会话记录(侧边信息;历史 + 实时,不再悬浮于场景) -->
  <div class="obj-sep" />
  <div class="sect-hd chat-sect">
    {{ $t('townView.k1ghjbfc133') }} {{ agentChatTitle }}
    <button
      class="mini-btn chat-refresh"
      :title="$t('townView.k15avt7g021')"
      @click="onRefreshHistory"
    >
      {{ historyLoading ? '…' : '↻' }}
    </button>
  </div>
  <div
    :ref="setChatScroll"
    class="rpg-lines chat-embed"
  >
    <div
      v-if="historyLoading"
      class="rpg-note"
    >
      {{ $t('townView.kkhlx5h109') }}
    </div>
    <template v-if="agentHistory.length">
      <div class="rpg-divider">
        {{ $t('townView.k768cnt134') }} {{ agentHistory.length }}
      </div>
      <div
        v-for="r in agentHistory"
        :key="r.id"
        class="rpg-line hist"
      >
        <span class="rpg-time">{{ fmtTime(r.at) }}</span>
        <div class="rpg-bubble">
          <span
            v-if="chatKindLabel(r.kind)"
            class="rpg-kind"
            :class="`k-${r.kind}`"
          >{{ chatKindLabel(r.kind) }}</span>
          <span class="rpg-text">{{ r.text }}</span>
        </div>
      </div>
    </template>
    <div
      v-if="agentChatRows.length"
      class="rpg-divider live"
    >
      {{ $t('townView.k1cwz73k135') }} {{ agentChatRows.length }}
    </div>
    <div
      v-for="r in agentChatRows"
      :key="r.id"
      class="rpg-line live"
    >
      <span class="rpg-time">{{ fmtTime(r.at) }}</span>
      <div class="rpg-bubble">
        <span class="rpg-text">{{ r.text }}</span>
      </div>
    </div>
    <div
      v-if="agentState === 'busy'"
      class="rpg-typing"
    >
      <span class="ty-dot" /><span class="ty-dot" /><span class="ty-dot" />
      <span class="ty-label">{{ $t('townView.k3o5tz9110') }}</span>
    </div>
    <div
      v-if="!historyLoading && !agentHistory.length && !agentChatRows.length"
      class="rpg-note"
    >
      {{ $t('townView.k1qkqld7111') }}
    </div>
  </div>
</template>

<style scoped>
.sect-hd {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--hud-faint);
  letter-spacing: 0.16em;
  font-weight: 700;
  margin: 10px 0 7px;
}
/* 分区头刻度线:与面板左缘数据条同 motif,建立分区节奏 */
.sect-hd::before {
  content: '';
  width: 3px;
  height: 9px;
  background: var(--hud-accent);
  border-radius: 1px;
  opacity: 0.55;
}
.obj-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.obj-label { flex: none; width: 52px; font-size: 10.5px; color: var(--hud-dim); }
.obj-input, .obj-select {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--hud-text);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 7px;
  padding: 5px 8px;
  transition: border-color 0.15s var(--hud-ease);
}
.obj-input:focus, .obj-select:focus { outline: none; border-color: var(--hud-accent); }
.obj-sep { height: 1px; background: var(--hud-line-soft); margin: 8px 0; }
.range-status { flex: 1; min-width: 0; font-size: 10px; color: var(--hud-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.obj-mini {
  flex: none;
  padding: 4px 10px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--hud-dim);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 7px;
  cursor: pointer;
}
.obj-mini.on { color: #04120c; background: var(--hud-accent); border-color: var(--hud-accent); }
.obj-mini.danger { color: var(--hud-danger); margin-top: 4px; width: 100%; }
.obj-range { flex: 1; accent-color: var(--hud-accent); }
.bp-val {
  flex: none;
  width: 40px;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--hud-text);
  font-variant-numeric: tabular-nums;
}
.bp-seg { display: flex; gap: 4px; }
.seg-btn {
  padding: 4px 12px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--hud-dim);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 7px;
  cursor: pointer;
  transition: border-color 0.14s var(--hud-ease), color 0.14s var(--hud-ease), background 0.14s var(--hud-ease);
}
.seg-btn:hover { border-color: var(--hud-line-hi); color: var(--hud-text); }
.seg-btn.on { color: #04120c; background: var(--hud-accent); border-color: var(--hud-accent); }
.ins-empty { color: var(--hud-faint); font-size: 11px; text-align: center; padding: 8px 0 6px; }
/* ===== 浮动:员工会话台 / 频道边界 / 芯片 ===== */
/* 会话记录侧边嵌入态:静态入轨,高度受限滚动(悬浮壳已废) */
.rpg-lines.chat-embed {
  max-height: 268px;
  padding: 2px 0 4px;
  background: rgba(15, 23, 38, 0.5);
  border: 1px solid var(--hud-line-soft);
  border-radius: var(--hud-r-md);
}
.chat-sect {
  display: flex;
  align-items: center;
  gap: 8px;
}
.chat-sect .chat-refresh { margin-left: auto; }
.chat-id-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}
.chat-badge {
  --p-acc: var(--hud-accent);
  flex: none;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 700;
  color: var(--p-acc);
  background: color-mix(in srgb, var(--p-acc) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--p-acc) 45%, transparent);
  border-radius: var(--hud-r-sm);
}
.chat-nameplate { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.chat-name { font-size: 13px; font-weight: 650; color: var(--hud-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-meta { display: flex; gap: 6px; align-items: center; }
.chat-state {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--hud-dim);
  padding: 1px 6px;
  border: 1px solid var(--hud-line);
  border-radius: 6px;
}
/* 职务章:Leader(琥珀=指挥)/ Worker(青=执行),与 KPI 语义色同源 */
.chat-role {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  padding: 1px 7px;
  border-radius: 6px;
}
.chat-role.r-lead { color: var(--hud-amber); background: rgba(246, 196, 83, 0.1); border: 1px solid rgba(246, 196, 83, 0.45); }
.chat-role.r-worker { color: var(--hud-cyan); background: rgba(65, 200, 244, 0.1); border: 1px solid rgba(65, 200, 244, 0.4); }
.chat-state.s-busy { color: var(--hud-amber); border-color: rgba(246, 196, 83, 0.5); }
.chat-state.s-stopped { color: var(--hud-danger); border-color: rgba(255, 107, 107, 0.5); }
.chat-harness { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; color: var(--hud-faint); }
.chat-count { font-family: var(--font-mono); font-size: 10px; color: var(--hud-faint); }
.chat-refresh {
  flex: none;
  width: 22px;
  height: 22px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--hud-dim);
  background: transparent;
  border: 1px solid var(--hud-line);
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 0.14s var(--hud-ease), color 0.14s var(--hud-ease), transform 0.32s var(--hud-ease);
}
.chat-refresh:hover { border-color: var(--hud-accent); color: var(--hud-accent); }
.chat-refresh:active { transform: rotate(180deg); }
.rpg-lines {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px 12px;
  overflow: hidden auto;
}
.rpg-divider { margin: 4px 0 2px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.2em; color: var(--hud-faint); }
.rpg-divider.live { color: var(--hud-amber); }
.rpg-line { display: flex; gap: 8px; align-items: flex-start; }
.rpg-time {
  flex: none;
  width: 52px;
  text-align: right;
  margin-top: 5px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--hud-faint);
}
.rpg-bubble {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 11px;
  background: var(--hud-panel-2);
  border: 1px solid var(--hud-line);
  border-radius: var(--hud-r-md);
}
.rpg-line.hist { opacity: 0.62; }
.rpg-line.live .rpg-bubble {
  animation: rise 0.26s var(--hud-ease) both;
  background: #14213a;
  border-color: var(--hud-line-hi);
}
.rpg-kind { align-self: flex-start; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.14em; color: var(--hud-faint); }
.rpg-kind.k-artifact { color: var(--hud-accent); }
.rpg-kind.k-error { color: var(--hud-danger); }
.rpg-text { font-size: 13px; line-height: 1.6; color: var(--hud-text); word-break: break-word; text-wrap: pretty; }
.rpg-line.live .rpg-text { color: #edf4fa; }
.rpg-typing { display: flex; gap: 4px; align-items: center; padding: 5px 2px; }
.ty-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--hud-amber);
  animation: ty-bounce 1.15s var(--hud-ease) infinite;
}
.ty-dot:nth-child(2) { animation-delay: 0.15s; }
.ty-dot:nth-child(3) { animation-delay: 0.3s; }
.ty-label { margin-left: 5px; font-family: var(--font-mono); font-size: 10px; color: var(--hud-faint); }
.rpg-note { font-family: var(--font-mono); font-size: 10px; color: var(--hud-dim); text-align: center; padding: 14px 0; }
/* ===== 滑块全自绘:细轨 + 白芯绿环 thumb(场景控制/变换缩放等) ===== */
.obj-range, .scale-range {
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  background: #1a2740;
  border-radius: 999px;
  outline: none;
  cursor: pointer;
}
.obj-range::-webkit-slider-thumb, .scale-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 13px;
  height: 13px;
  background: #e8f6ef;
  border: 2px solid var(--hud-accent);
  border-radius: 50%;
  box-shadow: 0 0 0 3px rgba(53, 224, 160, 0.15), 0 2px 6px rgba(3, 7, 14, 0.5);
  transition: transform 0.15s var(--hud-ease), box-shadow 0.15s var(--hud-ease);
}
.obj-range::-webkit-slider-thumb:hover, .scale-range::-webkit-slider-thumb:hover {
  transform: scale(1.18);
  box-shadow: 0 0 0 5px rgba(53, 224, 160, 0.2), 0 2px 8px rgba(3, 7, 14, 0.55);
}
.obj-range::-moz-range-thumb, .scale-range::-moz-range-thumb {
  width: 13px;
  height: 13px;
  background: #e8f6ef;
  border: 2px solid var(--hud-accent);
  border-radius: 50%;
  box-shadow: 0 0 0 3px rgba(53, 224, 160, 0.15);
}
.obj-range::-moz-range-track, .scale-range::-moz-range-track {
  height: 4px;
  background: #1a2740;
  border-radius: 999px;
}
@keyframes ty-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-3px); opacity: 1; }
}
/* 按压态:轻微下沉,松手回弹(自 TownView.vue 同源规则搬移) */
.mini-btn:active, .obj-mini:active {
  transform: scale(0.96);
}
mini-btn, obj-mini {
  transition-property: filter, background, border-color, color, transform, opacity;
  transition-duration: 0.15s;
  transition-timing-function: var(--hud-ease);
}
/* 键盘可达:焦点环(设计稿 --focus-ring;补回 scoped 属性选择器降低的一档特异性,与 .town-view 规则同效) */
.obj-select:focus-visible,
.obj-mini:focus-visible,
.obj-range:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--hud-bg), 0 0 0 4px rgba(65, 200, 244, 0.45);
  border-radius: 6px;
}
/* ── 触摸目标:窄屏所有可点元件 ≥40px 高(与 .town-view button 同效) ── */
@media (max-width: 1023px) {
  button { min-height: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  .rpg-line.live .rpg-bubble, .ty-dot { animation: none; }
}
</style>
