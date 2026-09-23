<script setup lang="ts">
/**
 * 小镇视图 · 右轨告警面板列表(状态流转 + 空态)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
import type { AlarmItem } from '@/app/composables/workshop/town/town-view-types'

defineProps<{
  alarms: AlarmItem[]
  alarmStates: ReadonlyArray<string>
  advanceAlarm: (id: number) => void
}>()
</script>

<template>
  <div class="alarm-list">
    <div
      v-for="a in alarms.slice(0, 8)"
      :key="a.id"
      class="al-row"
    >
      <span
        class="al-ico"
        :class="a.state === 2 ? 'info' : a.state === 1 ? 'warn' : 'crit'"
      >
        <svg
          class="al-svg"
          viewBox="0 0 24 24"
        ><path d="M12 3 22 20H2L12 3Z" /><path d="M12 10v4M12 17v.2" /></svg>
      </span>
      <div class="al-body">
        <div class="al-txt">
          {{ a.txt }}
        </div>
        <div class="al-src">
          {{ a.src }} · {{ a.time }}
        </div>
      </div>
      <button
        class="al-state"
        :class="`s${a.state}`"
        @click="advanceAlarm(a.id)"
      >
        {{ alarmStates[a.state] }}
      </button>
    </div>
    <div
      v-if="!alarms.length"
      class="rail-empty"
    >
      <svg
        class="re-ico"
        viewBox="0 0 24 24"
      ><path d="M12 3l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V6l7-3Z" /><path d="m9.2 12.2 2 2 3.6-4" /></svg>
      <span>{{ $t('townView.kjz544r119') }}</span>
    </div>
  </div>
</template>

<style scoped>
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
.alarm-list { display: flex; flex-direction: column; }
.al-row {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  padding: 9px 8px;
  border-radius: var(--hud-r-md);
  transition: background 0.15s;
}
.al-row:hover { background: #101a2c; }
.al-ico {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  flex: none;
}
.al-ico.crit { background: rgba(255, 107, 107, 0.12); color: var(--hud-danger); }
.al-ico.warn { background: rgba(246, 196, 83, 0.12); color: var(--hud-amber); }
.al-ico.info { background: rgba(65, 200, 244, 0.12); color: var(--hud-cyan); }
.al-svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.al-body { flex: 1; min-width: 0; }
.al-txt { font-size: 12px; font-weight: 500; line-height: 1.35; color: var(--hud-text); }
.al-src { font-family: var(--font-mono); font-size: 9.5px; color: var(--hud-faint); margin-top: 2px; }
.al-state {
  font-size: 9.5px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 6px;
  flex: none;
  cursor: pointer;
  border: 1px solid;
  background: transparent;
  margin-top: 2px;
}
.al-state.s0 { color: var(--hud-danger); background: rgba(255, 107, 107, 0.1); border-color: rgba(255, 107, 107, 0.4); }
.al-state.s1 { color: var(--hud-amber); background: rgba(246, 196, 83, 0.1); border-color: rgba(246, 196, 83, 0.35); }
.al-state.s2 { color: var(--hud-dim); background: rgba(143, 160, 181, 0.08); border-color: rgba(143, 160, 181, 0.3); }
.nav-bell-warn { color: var(--hud-danger); border-color: rgba(255, 107, 107, 0.5); }
/* 按压态:轻微下沉,松手回弹(自 TownView.vue 同源规则搬移) */
.al-state:active {
  transform: scale(0.96);
}
al-state {
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
/* ── 触摸目标:窄屏所有可点元件 ≥40px 高(与 .town-view button 同效) ── */
@media (max-width: 1023px) {
  button { min-height: 40px; }
}
</style>
