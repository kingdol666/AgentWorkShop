<script setup lang="ts">
/**
 * 小镇视图 · 舞台 KPI 条(设备 / 运行 / 告警 / 数采通道 / 健康度)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
defineProps<{
  deviceCount: number
  runningCount: number
  activeAlarmCount: number
  channelCount: number
  healthPct: number
}>()
</script>

<template>
  <!-- KPI 条(设计稿五项:设备/运行/告警/数采通道/健康度) -->
  <div class="kpi-strip">
    <div class="kpi">
      <span class="kpi-ico c1">
        <svg
          class="kpi-svg"
          viewBox="0 0 24 24"
        ><path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Z" /><path d="M4 8.5l8 4.5 8-4.5M12 13v7" /></svg>
      </span>
      <div class="kpi-meta">
        <div class="kpi-label">
          {{ $t('townView.k1k6xemt037') }}
        </div>
        <div class="kpi-val">
          {{ deviceCount }}<small>{{ $t('townView.k49lh038') }}</small>
        </div>
      </div>
    </div>
    <div class="kpi">
      <span class="kpi-ico c2">
        <svg
          class="kpi-svg"
          viewBox="0 0 24 24"
        ><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
      </span>
      <div class="kpi-meta">
        <div class="kpi-label">
          {{ $t('townView.k1l1a9t2039') }}
        </div>
        <div class="kpi-val">
          {{ runningCount }}<small>{{ $t('townView.k49lh038') }}</small>
        </div>
      </div>
    </div>
    <div class="kpi">
      <span class="kpi-ico c3">
        <svg
          class="kpi-svg"
          viewBox="0 0 24 24"
        ><path d="M12 3 22 20H2L12 3Z" /><path d="M12 10v4M12 17v.2" /></svg>
      </span>
      <div class="kpi-meta">
        <div class="kpi-label">
          {{ $t('townView.k1fsi3ir002') }}
        </div>
        <div class="kpi-val">
          {{ activeAlarmCount }}<small>{{ $t('townView.k4dfq040') }}</small>
        </div>
      </div>
    </div>
    <div class="kpi">
      <span class="kpi-ico c4">
        <svg
          class="kpi-svg"
          viewBox="0 0 24 24"
        ><path d="M9.5 14.5 14.5 9.5" /><path d="M11 6.5 12.8 4.7a4 4 0 0 1 5.6 5.6L16.5 12" /><path d="m13 17.5-1.8 1.8a4 4 0 0 1-5.6-5.6L7.5 12" /></svg>
      </span>
      <div class="kpi-meta">
        <div class="kpi-label">
          {{ $t('townView.k1emsai1041') }}
        </div>
        <div class="kpi-val">
          {{ channelCount }}<small>{{ $t('townView.k4l1w042') }}</small>
        </div>
      </div>
    </div>
    <div class="kpi">
      <span class="kpi-ico c5">
        <svg
          class="kpi-svg"
          viewBox="0 0 24 24"
        ><path d="M5 19a9 9 0 1 1 14 0" /><path d="M12 13l3.5-3.5" /><circle
          cx="12"
          cy="13"
          r="1.4"
        /></svg>
      </span>
      <div class="kpi-meta">
        <div class="kpi-label">
          {{ $t('townView.kbrxdq1043') }}
        </div>
        <div class="kpi-val">
          {{ healthPct }}<small>%</small>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* KPI 条 */
.kpi-strip {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 12px;
  z-index: 6;
  display: flex;
  gap: 10px;
  justify-content: center;
  padding: 0 16px;
  pointer-events: none;
  flex-wrap: wrap;
}
.kpi {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  pointer-events: auto;
  background: linear-gradient(180deg, rgba(20, 30, 48, 0.92) 0%, rgba(12, 19, 32, 0.9) 100%);
  border: 1px solid #1e2c46;
  border-radius: var(--hud-r-md);
  backdrop-filter: blur(8px);
  /* 玻璃光泽:上缘内高光 + 悬浮投影,与 .panel 同族 */
  box-shadow:
    inset 0 1px 0 rgba(143, 176, 220, 0.08),
    0 8px 20px rgba(3, 7, 14, 0.4);
  transition: border-color 0.2s var(--hud-ease), transform 0.2s var(--hud-ease), box-shadow 0.2s var(--hud-ease);
}
.kpi:hover {
  border-color: #2c4568;
  transform: translateY(-1px);
  box-shadow:
    inset 0 1px 0 rgba(143, 176, 220, 0.1),
    0 12px 26px rgba(3, 7, 14, 0.5);
}
.kpi-ico {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  flex: none;
  font-size: 12px;
  font-weight: 700;
}
.kpi-ico.c1 { background: rgba(65, 200, 244, 0.12); color: var(--hud-cyan); }
.kpi-ico.c2 { background: rgba(53, 224, 160, 0.12); color: var(--hud-accent); }
.kpi-ico.c3 { background: rgba(246, 196, 83, 0.12); color: var(--hud-amber); }
.kpi-ico.c4 { background: rgba(167, 139, 250, 0.14); color: #a78bfa; }
.kpi-ico.c5 { background: rgba(255, 107, 107, 0.12); color: var(--hud-danger); }
.kpi-svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.kpi-meta { line-height: 1.25; }
.kpi-label { font-size: 10px; color: var(--hud-dim); letter-spacing: 0.08em; text-transform: uppercase; }
.kpi-val {
  font-family: var(--font-mono);
  font-size: 19px;
  font-weight: 700;
  color: var(--hud-text);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
.kpi-val small { font-size: 10px; color: var(--hud-faint); font-weight: 500; margin-left: 2px; }
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
    /* KPI 条:一行横滑,不再折成多行压住场景 */
    .kpi-strip {
      bottom: 10px;
      gap: 8px;
      padding: 0 12px;
      justify-content: flex-start;
      flex-wrap: nowrap;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scrollbar-width: none;
    }
    .kpi-strip::-webkit-scrollbar { display: none; }
    .kpi { flex: none; padding: 6px 10px; gap: 8px; }
    .kpi-ico { width: 28px; height: 28px; }
    .kpi-label { font-size: 11.5px; }
    .kpi-val { font-size: 13px; }
    .kpi-val small { font-size: 11.5px; }
}
@media (max-width: 639px) {
    .kpi-strip { padding: 0 10px; }
}
</style>
