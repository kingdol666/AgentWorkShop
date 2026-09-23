<script setup lang="ts">
/**
 * 小镇视图 · 左轨场景管理(频道坞列表:拖入场景 / 已放置标记)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
import type { DockChannelRow } from '@/app/composables/workshop/town/town-view-types'

defineProps<{
  mode: 'browse' | 'edit'
  dockChannels: DockChannelRow[]
  dockHint: string
  onChannelDragStart: (e: DragEvent, channelId: string) => void
  onDockCardClick: (ch: { channelId: string, placed: boolean }) => void
}>()
</script>

<template>
  <div class="scene-list">
    <div
      v-for="ch in dockChannels"
      :key="ch.channelId"
      class="scene-row"
      :class="{ active: ch.placed }"
      :draggable="!ch.placed && mode === 'edit'"
      :data-channel-id="ch.channelId"
      :title="ch.placed ? $t('townView.chPlaced') : $t('townView.chDragHint')"
      @dragstart="ch.placed ? undefined : onChannelDragStart($event, ch.channelId)"
      @click="onDockCardClick(ch)"
    >
      <span
        class="scene-ico"
        :style="{ '--ch': ch.color }"
      />
      <div class="scene-meta-wrap">
        <span class="scene-name">{{ ch.name }}</span>
        <span class="scene-meta">{{ ch.agentCount }} {{ $t('townView.k1brss7t128') }} {{ ch.placed ? $t('townView.k3n94g3141') : $t('townView.k3os7i3176') }}</span>
      </div>
      <span
        v-if="ch.placed"
        class="scene-cur"
      >✓</span>
      <span
        v-else
        class="scene-add"
      >＋</span>
    </div>
    <div
      v-if="dockHint"
      class="scene-hint"
    >
      {{ dockHint }}
    </div>
  </div>
</template>

<style scoped>
.scene-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 9px;
  border-radius: var(--hud-r-md);
  border: 1px solid transparent;
  margin-bottom: 4px;
  cursor: grab;
  transition: background 0.15s var(--hud-ease), border-color 0.15s var(--hud-ease);
}
.scene-row:hover { background: #111b2c; }
.scene-row.active {
  background: rgba(53, 224, 160, 0.06);
  border-color: rgba(53, 224, 160, 0.35);
}
.scene-row:active { cursor: grabbing; }
.scene-ico {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  flex: none;
  background: color-mix(in srgb, var(--ch, var(--hud-accent)) 16%, #101a2c);
  border: 1px solid color-mix(in srgb, var(--ch, var(--hud-accent)) 45%, transparent);
}
.scene-row.active .scene-ico { box-shadow: 0 0 10px color-mix(in srgb, var(--ch, var(--hud-accent)) 40%, transparent); }
.scene-meta-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.scene-name { font-size: 12px; font-weight: 600; color: var(--hud-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.scene-meta { font-family: var(--font-mono); font-size: 10px; color: var(--hud-faint); }
.scene-cur, .scene-add {
  margin-left: auto;
  flex: none;
  font-size: 10px;
  border-radius: 6px;
  padding: 1px 7px;
}
.scene-cur { color: var(--hud-accent); border: 1px solid rgba(53, 224, 160, 0.4); }
.scene-add { color: var(--hud-dim); border: 1px solid var(--hud-line); }
.scene-hint {
  font-size: 10px;
  color: var(--hud-amber);
  padding: 6px 4px 0;
  line-height: 1.5;
}
/* 键盘可达:焦点环(设计稿 --focus-ring;补回 scoped 属性选择器降低的一档特异性,与 .town-view 规则同效) */
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
