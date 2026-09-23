<script setup lang="ts">
/**
 * 小镇视图 · 右轨设备健康环(环图 + 状态图例)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
defineProps<{
  healthPct: number
  healthTone: string
  idleCount: number
  alarmCount: number
  offlineCount: number
  runningCount: number
  setCanvas: (el: Element | ComponentPublicInstance | null) => void
}>()
</script>

<template>
  <div class="health-body">
    <div class="donut-wrap">
      <canvas
        :ref="setCanvas"
        width="118"
        height="118"
      />
      <div class="donut-center">
        <b :style="{ color: healthTone }">{{ healthPct }}%</b>
        <span>{{ $t('townView.k7h1nxo113') }}</span>
      </div>
    </div>
    <div class="health-legend">
      <div class="hl-row">
        <span
          class="hl-dot"
          :style="{ background: 'var(--hud-accent)' }"
        />
        {{ $t('townView.k3vp67i114') }}
        <span class="n">{{ runningCount }}</span>
      </div>
      <div class="hl-row">
        <span
          class="hl-dot"
          :style="{ background: 'var(--hud-amber)' }"
        />
        {{ $t('townView.k3zcvb115') }}
        <span class="n">{{ idleCount }}</span>
      </div>
      <div class="hl-row">
        <span
          class="hl-dot"
          :style="{ background: 'var(--hud-danger)' }"
        />
        {{ $t('townView.k3xmid116') }}
        <span class="n">{{ alarmCount }}</span>
      </div>
      <div class="hl-row">
        <span
          class="hl-dot"
          :style="{ background: '#3a4a63' }"
        />
        {{ $t('townView.statesOffline') }}
        <span class="n">{{ offlineCount }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 设备健康环 */
.health-body { display: flex; align-items: center; gap: 14px; }
.donut-wrap { position: relative; width: 118px; height: 118px; flex: none; }
.donut-wrap canvas { width: 118px; height: 118px; }
.donut-center {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  text-align: center;
}
.donut-center b { font-family: var(--font-mono); font-size: 21px; font-weight: 700; color: var(--hud-accent); }
.donut-center span { font-size: 9.5px; color: var(--hud-faint); }
.health-legend { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.hl-row { display: flex; align-items: center; gap: 7px; font-size: 11.5px; }
.hl-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.hl-row .n { margin-left: auto; font-family: var(--font-mono); font-weight: 700; font-size: 13px; color: var(--hud-text); }
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
