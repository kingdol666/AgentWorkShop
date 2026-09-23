<script setup lang="ts">
/**
 * 小镇视图 · 舞台数据标注层(引线 + 靠近浮现 callout)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
import type { CalloutRow } from '@/app/composables/workshop/town/town-view-types'

defineProps<{
  showCallouts: boolean
  callouts: CalloutRow[]
  selectDeviceFromCallout: (daqId: string) => void
}>()
</script>

<template>
  <!-- 数据标注层(靠近浮现:callout + 引线 + 锚点;同设备多路竖排堆叠;点击选中设备) -->
  <template v-if="showCallouts">
    <svg class="leaders">
      <g
        v-for="c in callouts"
        v-show="c.leader"
        :key="`ld-${c.id}`"
        :class="{ near: c.near }"
      >
        <path
          :d="`M ${c.x} ${c.y - 8} L ${c.x} ${c.y - 2}`"
          :stroke="c.warn ? 'rgba(246,196,83,.8)' : 'rgba(65,200,244,.55)'"
          stroke-width="1.3"
          fill="none"
        />
        <circle
          :cx="c.x"
          :cy="c.y"
          r="2.6"
          :fill="c.warn ? '#f6c453' : '#41c8f4'"
        />
      </g>
    </svg>
    <div class="callout-layer">
      <div
        v-for="c in callouts"
        :key="c.id"
        class="callout"
        :class="{ warn: c.warn, near: c.near }"
        :style="{ left: c.x + 'px', top: c.y + 'px' }"
        :title="$t('townView.k1ejxiwp010')"
        @click="selectDeviceFromCallout(c.id)"
      >
        <div class="co-label">
          <span class="co-dot" />{{ c.label }}
        </div>
        <div class="co-val">
          {{ c.value }}<small>{{ c.unit }}</small>
        </div>
        <div class="co-range">
          {{ $t('townView.k1faqmjb073') }} {{ c.lo.toFixed(Math.min(2, (String(c.lo).split('.')[1] ?? '').length + 1)) }} – {{ c.hi.toFixed(Math.min(2, (String(c.hi).split('.')[1] ?? '').length + 1)) }}
        </div>
      </div>
    </div>
  </template>
</template>

<style scoped>
/* 标注层 */
.callout-layer {
  position: absolute;
  inset: 0;
  z-index: 7;
  pointer-events: none;
  overflow: hidden;
}
.callout {
  position: absolute;
  min-width: 150px;
  transform: translate(-50%, -112%) translateY(5px);
  opacity: 0;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(16, 26, 43, 0.94), rgba(10, 16, 28, 0.94));
  border: 1px solid rgba(65, 200, 244, 0.4);
  border-radius: var(--hud-r-md);
  padding: 9px 12px 8px;
  box-shadow: var(--hud-shadow);
  backdrop-filter: blur(8px);
  transition: opacity 0.22s var(--hud-ease), transform 0.22s var(--hud-ease), border-color 0.15s var(--hud-ease);
}
/* 越近越亮:相机进入阈值半径后淡入上浮(数据只属于走近的人) */
.callout.near {
  opacity: 1;
  transform: translate(-50%, -112%);
  pointer-events: auto;
}
.leaders g { opacity: 0; transition: opacity 0.22s var(--hud-ease); }
.leaders g.near { opacity: 1; }
.callout.warn { border-color: rgba(246, 196, 83, 0.6); }
.co-label {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 10.5px;
  color: var(--hud-dim);
  white-space: nowrap;
}
.co-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--hud-cyan);
  box-shadow: 0 0 8px rgba(65, 200, 244, 0.9);
  flex: none;
}
.callout.warn .co-dot { background: var(--hud-amber); box-shadow: 0 0 8px rgba(246, 196, 83, 0.9); }
.co-val {
  font-family: var(--font-mono);
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin-top: 2px;
  color: var(--hud-text);
  font-variant-numeric: tabular-nums;
}
.co-val small { font-size: 10.5px; color: var(--hud-dim); font-weight: 500; margin-left: 3px; }
.co-range {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--hud-faint);
  margin-top: 1px;
}
.callout.warn .co-range { color: var(--hud-amber); }
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
@media (prefers-reduced-motion: reduce) {
  .callout { animation: none; }
}
</style>
