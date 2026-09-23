<script setup lang="ts">
/**
 * 小镇视图 · 右轨实时事件列表(时间 / 角色 / 文本 + 空态)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
defineProps<{
  ticker: Array<{ channelId: string, agentName: string, text: string, at?: number }>
  fmtTime: (at?: number) => string
}>()
</script>

<template>
  <div class="event-list">
    <div
      v-for="(ev, i) in [...ticker].reverse()"
      :key="`${ev.at}-${i}`"
      class="event-row"
    >
      <span class="ev-time">{{ fmtTime(ev.at) }}</span>
      <span
        class="ev-name"
        :title="ev.agentName"
      >{{ ev.agentName }}</span>
      <span
        class="ev-text"
        :title="ev.text"
      >{{ ev.text }}</span>
    </div>
    <div
      v-if="!ticker.length"
      class="rail-empty"
    >
      <svg
        class="re-ico"
        viewBox="0 0 24 24"
      ><path d="M3 12h3l2.5-6 4 12L15 12h6" /></svg>
      <span>{{ $t('townView.k2uk6ua121') }}</span>
    </div>
  </div>
</template>

<style scoped>
/* 实时事件 */
.event-list {
  flex: 1;
  min-height: 0;
  max-height: 200px;
  display: flex;
  flex-direction: column;
  overflow: hidden auto;
}
.event-row {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 4px 6px;
  border-radius: 7px;
  transition: background 0.13s var(--hud-ease);
}
.event-row:hover { background: rgba(53, 224, 160, 0.05); }
.ev-time { flex: none; font-family: var(--font-mono); font-size: 10px; font-variant-numeric: tabular-nums; color: var(--hud-faint); }
.ev-name {
  flex: none;
  max-width: 70px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  color: var(--hud-text);
}
.ev-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--hud-dim);
}
.event-empty { padding: 12px; font-family: var(--font-mono); font-size: 9.5px; color: var(--hud-faint); text-align: center; }
.rail-empty {
  display: flex;
  flex-direction: column;
  gap: 7px;
  align-items: center;
  padding: 16px 10px 13px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.06em;
  color: var(--hud-faint);
  text-align: center;
}
.rail-empty .re-ico {
  width: 19px;
  height: 19px;
  fill: none;
  stroke: var(--hud-faint);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.85;
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
