<script setup lang="ts">
/**
 * 小镇视图 · 频道边界编辑浮层(边界 tab + 成员 tab)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
import type { ChannelLayout } from '../TownScene3D'
import type { TownMemberRow, TownModelRow } from '@/app/composables/workshop/town/town-view-types'

const boundaryDraft = defineModel<ChannelLayout>('boundaryDraft', { required: true })

defineProps<{
  selectedChannel: string
  channelName: string | undefined
  channelPanelTab: 'boundary' | 'members'
  channelMembers: TownMemberRow[]
  agentModels: TownModelRow[]
  panelPos: Record<string, { x: number, y: number }>
  sliderPct: (v: number, min: number, max: number) => string
  hashColor: (id: string) => string
  onPanelGripDown: (e: PointerEvent, key: string) => void
  openChannelTab: (tab: 'boundary' | 'members') => void
  applyBoundaryDraft: () => void
  bindMemberModel: (agentId: string, modelRef: string) => void
  saveChannelLayout: () => void
  removeChannelFromScene: () => void
  onSelectChannel: (cid: string | null) => void
}>()
</script>

<template>
  <!-- 频道边界编辑(浮动) -->
  <div
    class="boundary-panel drag-panel"
    :style="panelPos.boundary ? { left: panelPos.boundary.x + 'px', top: panelPos.boundary.y + 'px', bottom: 'auto', transform: 'none' } : undefined"
  >
    <div
      class="bp-title drag-grip"
      :title="$t('townView.k1d0rl5z011')"
      @pointerdown="onPanelGripDown($event, 'boundary')"
    >
      <span class="bp-name">{{ channelName ?? selectedChannel.slice(0, 8) }}</span>
      <span class="bp-sub">{{ $t('townView.k1mehlxs046') }}</span>
      <div class="bp-tabs">
        <button
          class="bp-tab"
          :class="{ on: channelPanelTab === 'boundary' }"
          @click="openChannelTab('boundary')"
        >
          {{ $t('townView.k489ka047') }}
        </button>
        <button
          class="bp-tab"
          :class="{ on: channelPanelTab === 'members' }"
          @click="openChannelTab('members')"
        >
          {{ $t('townView.k3ztf1129') }} {{ channelMembers.length }}
        </button>
      </div>
    </div>
    <template v-if="channelPanelTab === 'boundary'">
      <div class="bp-row">
        <span class="bp-label">{{ $t('townView.k3zhy5048') }}</span>
        <div class="bp-seg">
          <button
            class="seg-btn"
            :class="{ on: boundaryDraft.shape === 'ellipse' }"
            @click="boundaryDraft.shape = 'ellipse'; applyBoundaryDraft()"
          >
            {{ $t('townView.k414bc049') }}
          </button>
          <button
            class="seg-btn"
            :class="{ on: boundaryDraft.shape === 'rect' }"
            @click="boundaryDraft.shape = 'rect'; applyBoundaryDraft()"
          >
            {{ $t('townView.k43u0g050') }}
          </button>
        </div>
      </div>
      <div class="bp-row">
        <span class="bp-label">{{ $t('townView.k1fbz4s1051') }}</span>
        <input
          v-model.number="boundaryDraft.radiusX"
          class="bp-range"
          type="range"
          min="80"
          max="4000"
          step="8"
          :style="{ '--fill': sliderPct(boundaryDraft.radiusX, 80, 4000) }"
          @change="applyBoundaryDraft"
        >
        <span class="bp-val">{{ Math.round(boundaryDraft.radiusX) }}</span>
      </div>
      <div class="bp-row">
        <span class="bp-label">{{ $t('townView.k1ighwgs052') }}</span>
        <input
          v-model.number="boundaryDraft.radiusZ"
          class="bp-range"
          type="range"
          min="60"
          max="4000"
          step="8"
          :style="{ '--fill': sliderPct(boundaryDraft.radiusZ, 60, 4000) }"
          @change="applyBoundaryDraft"
        >
        <span class="bp-val">{{ Math.round(boundaryDraft.radiusZ) }}</span>
      </div>
      <div class="bp-row">
        <span class="bp-label">{{ $t('townView.k40qab053') }}</span>
        <input
          v-model.number="boundaryDraft.rotationY"
          class="bp-range"
          type="range"
          min="0"
          max="360"
          step="5"
          :style="{ '--fill': sliderPct(boundaryDraft.rotationY ?? 0, 0, 360) }"
          @change="applyBoundaryDraft"
        >
        <span class="bp-val">{{ Math.round(boundaryDraft.rotationY ?? 0) }}°</span>
      </div>
    </template>
    <template v-else>
      <div class="bp-hint">
        {{ $t('townView.kimxls2054') }}
      </div>
      <div class="member-list">
        <div
          v-for="m in channelMembers"
          :key="m.agentId"
          class="member-row"
        >
          <span
            class="member-ava"
            :style="{ color: hashColor(selectedChannel) }"
          >{{ m.name.charAt(0).toUpperCase() }}</span>
          <div class="member-info">
            <span class="member-name">{{ m.name }}</span>
            <span
              class="member-role"
              :class="m.role === 'lead' ? 'r-lead' : 'r-worker'"
            >{{ m.role === 'lead' ? 'Leader' : 'Worker' }}</span>
          </div>
          <select
            class="member-select"
            :value="(m.modelRef ?? '') || 'hero-3d'"
            @change="bindMemberModel(m.agentId, ($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="model in agentModels"
              :key="model.id"
              :value="model.id"
            >
              {{ model.name }}
            </option>
          </select>
        </div>
        <div
          v-if="channelMembers.length === 0"
          class="bp-hint"
        >
          {{ $t('townView.k419rbs055') }}
        </div>
      </div>
    </template>
    <div class="bp-actions">
      <button
        v-if="channelPanelTab === 'boundary'"
        class="bp-btn save"
        @click="saveChannelLayout"
      >
        {{ $t('townView.k1b3kp8f056') }}
      </button>
      <button
        class="bp-btn danger"
        @click="removeChannelFromScene"
      >
        {{ $t('townView.k1hs45qg057') }}
      </button>
      <button
        class="bp-btn"
        @click="onSelectChannel(null)"
      >
        {{ $t('townView.k3x62t058') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.bp-range { accent-color: var(--hud-accent); }
.bp-range::-webkit-slider-thumb { transition: transform 0.15s var(--hud-ease); }
.bp-range:hover::-webkit-slider-thumb { transform: scale(1.15); }
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
/* 频道边界编辑(浮动) */
.boundary-panel {
  position: absolute;
  top: 84px;
  left: 16px;
  width: 302px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 12px 14px;
  z-index: 9;
  background: linear-gradient(180deg, rgba(16, 24, 39, 0.97), rgba(13, 20, 32, 0.97));
  border: 1px solid var(--hud-line);
  border-radius: var(--hud-r-lg);
  box-shadow: var(--hud-shadow);
  backdrop-filter: blur(8px);
  pointer-events: auto;
}
.bp-title { display: flex; gap: 8px; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--hud-line); cursor: grab; touch-action: none; }
.bp-title:active { cursor: grabbing; }
.bp-name { font-size: 13px; font-weight: 700; color: var(--hud-text); }
.bp-sub { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.12em; color: var(--hud-faint); }
.bp-tabs { display: flex; gap: 4px; margin-left: auto; }
.bp-tab {
  padding: 3px 10px;
  font-size: 10px;
  font-weight: 600;
  color: var(--hud-dim);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 6px;
  cursor: pointer;
}
.bp-tab.on { color: #04120c; background: var(--hud-accent); border-color: var(--hud-accent); }
.bp-row { display: flex; gap: 8px; align-items: center; }
.bp-label { flex: none; width: 52px; font-size: 10.5px; color: var(--hud-dim); }
.bp-range {
  -webkit-appearance: none;
  appearance: none;
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--hud-accent-dim) var(--fill, 50%), #1d2a42 var(--fill, 50%));
  cursor: pointer;
}
.bp-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--hud-accent);
  transition: transform 0.15s var(--hud-ease);
}
.bp-range:hover::-webkit-slider-thumb { transform: scale(1.15); }
.bp-hint { font-size: 10px; line-height: 1.6; color: var(--hud-faint); }
.bp-actions { display: flex; gap: 6px; margin-top: 4px; }
.bp-btn {
  flex: 1;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--hud-text);
  background: transparent;
  border: 1px solid #27395c;
  border-radius: var(--hud-r-sm);
  cursor: pointer;
}
.bp-btn:hover { border-color: #33507c; background: #14203a; }
.bp-btn.save { color: #04120c; background: var(--hud-accent-dim); border-color: var(--hud-accent-dim); }
.bp-btn.save:hover { background: #25b57e; }
.bp-btn.danger { color: var(--hud-danger); border-color: rgba(255, 107, 107, 0.4); }
.bp-btn.danger:hover { background: rgba(255, 107, 107, 0.1); }
.member-list { display: flex; flex-direction: column; gap: 5px; max-height: 220px; overflow: hidden auto; }
.member-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  background: var(--hud-panel-2);
  border: 1px solid var(--hud-line-soft);
  border-radius: var(--hud-r-md);
}
.member-ava {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  color: var(--hud-text);
  background: var(--hud-panel-raised);
  border: 1px solid var(--hud-line);
  border-radius: 7px;
}
.member-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.member-name { font-size: 11px; font-weight: 600; color: var(--hud-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.member-role { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.06em; color: var(--hud-faint); }
.member-role.r-lead { color: var(--hud-amber); }
.member-role.r-worker { color: var(--hud-cyan); }
.member-select { flex: 1; min-width: 0; font-size: 10px; color: var(--hud-text); background: var(--hud-input); border: 1px solid var(--hud-line); border-radius: 6px; padding: 3px 6px; }
/* 拖动面板抓手 */
.drag-grip { cursor: grab; touch-action: none; }
.drag-grip:active { cursor: grabbing; }
.drag-panel { will-change: left, top; }
/* 按压态:轻微下沉,松手回弹(自 TownView.vue 同源规则搬移) */
.bp-btn:active {
  transform: scale(0.96);
}
bp-btn {
  transition-property: filter, background, border-color, color, transform, opacity;
  transition-duration: 0.15s;
  transition-timing-function: var(--hud-ease);
}
/* 键盘可达:焦点环(设计稿 --focus-ring;补回 scoped 属性选择器降低的一档特异性,与 .town-view 规则同效) */
.bp-range:focus-visible,
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
</style>
