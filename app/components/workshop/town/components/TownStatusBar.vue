<script setup lang="ts">
/**
 * 小镇视图 — 底部状态栏(statusbar)。
 *
 * 自 TownView.vue 抽出(纯结构搬移):连接态 / 场景统计 / FPS / 版权行。
 * 只读数据经 props 传入,组件自身无交互、无本地状态。
 */
defineProps<{
  /** WS 连接态(open 才显示已连接) */
  connState: string
  /** 正在同步(连接中) */
  syncing: boolean
  blockCount: number
  agentCount: number
  deviceCount: number
  fps: number
}>()
</script>

<template>
  <footer class="statusbar">
    <span>
      <span
        class="sb-dot"
        :class="{ red: connState !== 'open' }"
      />{{ $t('townView.k1i4g246123') }} <b>{{ connState === 'open' ? $t('townView.k41k5c154') : syncing ? $t('townView.k3lmtk3184') : $t('townView.k44c2n186') }}</b>
    </span>
    <span class="sb-stats">
      {{ $t('townView.k4a0jt124') }} <b>{{ blockCount }}</b><i>·</i>{{ $t('townView.k3xdvm125') }} <b>{{ agentCount }}</b><i>·</i>{{ $t('townView.k47e16126') }} <b>{{ deviceCount }}</b>
    </span>
    <span class="sb-lat mono">
      {{ fps }} FPS
    </span>
    <span class="copy">
      © 2026 ABO · DIGITAL TWIN · {{ $t('townView.k1h5gxpf137') }}</span>
  </footer>
</template>

<style scoped>
/* ===== 状态栏 ===== */
.statusbar {
  height: 30px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 14px;
  background: #0a101b;
  border-top: 1px solid var(--hud-line-soft);
  font-size: 11px;
  color: var(--hud-dim);
  position: relative;
  z-index: 60;
}
.statusbar b { color: var(--hud-accent); font-weight: 600; }
.statusbar .sb-stats {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.sb-stats b { color: var(--hud-text); font-weight: 600; }
.sb-stats i { font-style: normal; color: var(--hud-line-hi); }
.sb-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--hud-accent);
  box-shadow: 0 0 6px var(--hud-accent);
  display: inline-block;
  margin-right: 6px;
  vertical-align: 1px;
}
.sb-dot.red { background: var(--hud-danger); box-shadow: 0 0 6px var(--hud-danger); }
.sb-dot:not(.red) { animation: sb-pulse 2.4s var(--hud-ease) infinite; }
@keyframes sb-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@media (prefers-reduced-motion: reduce) {
  .sb-dot:not(.red) { animation: none; }
}
.sb-lat {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.statusbar .copy { margin-left: auto; color: var(--hud-faint); font-family: var(--font-mono); font-size: 10px; }

/* ── 窄屏(≤1023):留连接态 + 统计,FPS 贴右,版权行收起 ── */
@media (max-width: 1023px) {
  .statusbar {
    height: auto;
    min-height: 30px;
    flex-wrap: wrap;
    gap: 6px 12px;
    padding: 5px 10px;
    font-size: 11.5px;
  }
  .statusbar .copy { display: none; }
  .sb-lat { position: static; transform: none; margin-left: auto; }
  .statusbar { font-size: 12px; }
}
</style>
