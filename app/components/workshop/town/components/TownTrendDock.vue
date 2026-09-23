<script setup lang="ts">
/**
 * 小镇视图 · 底部坞:趋势分析卡(信号选择条 + 折线画布)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
import type { ComponentPublicInstance } from 'vue'

const trendExpanded = defineModel<boolean>('trendExpanded', { required: true })

defineProps<{
  channelCount: number
  trendChips: Array<{ id: string, name: string }>
  trendOverflow: number
  trendOn: (id: string, idx?: number) => boolean
  trendColor: (id: string) => string
  toggleTrend: (id: string) => void
  setCanvas: (el: Element | ComponentPublicInstance | null) => void
}>()
</script>

<template>
  <section class="dock-card">
    <div class="dock-hd">
      <h3>{{ $t('townView.k1kfoef9067') }}</h3>
      <span class="dock-count mono">{{ channelCount }}</span>
      <div
        class="trend-legend"
        :class="{ expanded: trendExpanded }"
      >
        <button
          v-for="chip in trendChips"
          :key="chip.id"
          class="lg-chip"
          :class="{ off: !trendOn(chip.id) }"
          @click="toggleTrend(chip.id)"
        >
          <span
            class="lg-dot"
            :style="{ background: trendColor(chip.id) }"
          />{{ chip.name }}
        </button>
        <button
          v-if="trendOverflow > 0"
          class="lg-chip lg-more mono"
          :title="trendExpanded ? $t('townView.trendCollapse') : $t('townView.trendExpandAll', { p0: channelCount })"
          @click="trendExpanded = !trendExpanded"
        >
          {{ trendExpanded ? $t('townView.trendCollapse') : `+${trendOverflow}` }}
        </button>
      </div>
    </div>
    <div class="trend-wrap">
      <canvas
        :ref="setCanvas"
        class="trend-cv"
      />
      <span
        v-if="!channelCount"
        class="trend-empty"
      >{{ $t('townView.k1uht2uv068') }}</span>
    </div>
  </section>
</template>

<style scoped>
.dock-hd { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.dock-hd h3 { margin: 0; font-size: 12.5px; font-weight: 700; flex: none; }
/* 通道计数徽标:规模诚实可见(57 路不该藏在 chip 墙里) */
.dock-count {
  flex: none;
  padding: 1px 7px;
  font-size: 9.5px;
  letter-spacing: 0.08em;
  color: var(--hud-dim);
  border: 1px solid var(--hud-line-soft);
  border-radius: 6px;
}
.dock-mode {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--hud-faint);
  border: 1px solid var(--hud-line);
  border-radius: 6px;
  padding: 1px 7px;
}
/* 趋势 */
/* 信号选择条:收起时只渲染前 8 枚 chip + 「+N」聚合钮(至多两行,非 chip 墙);
 * 展开/收起走 max-height 过渡(240ms ease-out,状态指示预算内),
 * 画布高度随之联动,trend-wrap flex:1 自适应 */
.trend-legend {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  align-content: flex-start;
  flex: 1 1 auto;
  min-width: 0;
  max-height: 47px;
  margin-left: 6px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #1c2942 transparent;
  transition: max-height 240ms cubic-bezier(0.22, 0.68, 0.36, 1);
}
.trend-legend.expanded { max-height: 100px; }
.trend-legend::-webkit-scrollbar { width: 6px; }
.trend-legend::-webkit-scrollbar-thumb { background: #1c2942; border-radius: 3px; }
.trend-legend::-webkit-scrollbar-track { background: transparent; }
.lg-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--hud-dim);
  border: 1px solid var(--hud-line-soft);
  background: rgba(13, 20, 32, 0.6);
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
  transition: opacity 0.15s var(--hud-ease), border-color 0.15s var(--hud-ease), color 0.15s var(--hud-ease);
}
.lg-chip:hover { border-color: var(--hud-line-hi); color: var(--hud-text); }
.lg-chip.off { opacity: 0.32; }
/* 「+N」展开/收起聚合 chip:虚线边界 = 折叠语义 */
.lg-more {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--hud-faint);
  border-style: dashed;
}
.lg-more:hover { color: var(--hud-accent); border-color: rgba(53, 224, 160, 0.4); }
.lg-dot { width: 7px; height: 7px; border-radius: 2px; }
.trend-wrap { flex: 1; min-height: 0; position: relative; }
.trend-cv { position: absolute; inset: 0; width: 100%; height: 100%; }
.trend-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--hud-faint);
}
/* 按压态:轻微下沉,松手回弹(自 TownView.vue 同源规则搬移) */
.lg-chip:active {
  transform: scale(0.96);
}
lg-chip {
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
@media (max-width: 1023px) {
    .dock-hd h3 { font-size: 13px; }
    .dock-count,
    .dock-mode { font-size: 11.5px; }
}
@media (max-width: 1023px) {
    .lg-chip { font-size: 11.5px; }
    .trend-empty { font-size: 11.5px; }
}
</style>
