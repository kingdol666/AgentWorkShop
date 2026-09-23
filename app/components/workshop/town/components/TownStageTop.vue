<script setup lang="ts">
/**
 * 小镇视图 · 舞台顶栏(视角标题 + 定位/环绕/标注/全屏工具 + 视角预设)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
const showCallouts = defineModel<boolean>('showCallouts', { required: true })

defineProps<{
  activeChannelName: string
  viewPreset: 'std' | 'top' | 'front' | 'side'
  orbitOn: boolean
  locateSelected: () => void
  toggleOrbit: () => void
  fullscreenStage: () => void
  onViewPreset: (e: Event) => void
}>()
</script>

<template>
  <div class="stage-top">
    <div class="vp-title">
      <h2>{{ $t('townView.k1b0z4vr035') }}</h2>
      <span class="vp-id">CH · {{ activeChannelName || $t('townView.k3lkuz3142') }}</span>
    </div>
    <div class="vp-tools">
      <button
        class="vp-tool"
        :title="$t('townView.k18d6wnb005')"
        @click="locateSelected"
      >
        <svg
          class="vp-svg"
          viewBox="0 0 24 24"
        ><circle
          cx="12"
          cy="12"
          r="7"
        /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
      </button>
      <button
        class="vp-tool"
        :class="{ on: orbitOn }"
        :title="$t('townView.k1io51dn006')"
        @click="toggleOrbit"
      >
        <svg
          class="vp-svg"
          viewBox="0 0 24 24"
        ><circle
          cx="12"
          cy="12"
          r="3.2"
        /><path d="M20.5 9a10 10 0 0 1 .3 4.5M3.5 15a10 10 0 0 1-.3-4.5" /></svg>
      </button>
      <button
        class="vp-tool"
        :class="{ on: showCallouts }"
        :title="$t('townView.k1sgjlq8007')"
        @click="showCallouts = !showCallouts"
      >
        <svg
          class="vp-svg"
          viewBox="0 0 24 24"
        ><path d="M4 8h12l4 4-4 4H4z" /><circle
          cx="8.5"
          cy="12"
          r="1.4"
        /></svg>
      </button>
      <button
        class="vp-tool"
        :title="$t('townView.k3wuf0008')"
        @click="fullscreenStage"
      >
        <svg
          class="vp-svg"
          viewBox="0 0 24 24"
        ><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
      </button>
    </div>
  </div>

  <div class="angle-chip">
    <select
      :value="viewPreset"
      :aria-label="$t('townView.k1k4j5i7009')"
      @change="onViewPreset($event)"
    >
      <option value="std">
        {{ $t('townView.kv72860036') }}
      </option>
      <option value="top">
        {{ $t('townView.viewTop') }}
      </option>
      <option value="front">
        {{ $t('townView.viewFront') }}
      </option>
      <option value="side">
        {{ $t('townView.viewSide') }}
      </option>
    </select>
  </div>
</template>

<style scoped>
.stage-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 6;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 14px 16px;
  pointer-events: none;
}
.stage-top > * { pointer-events: auto; }
.vp-title {
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(9, 14, 24, 0.72);
  border: 1px solid #1c2942;
  border-radius: var(--hud-r-md);
  padding: 8px 12px;
  backdrop-filter: blur(8px);
}
.vp-title h2 { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: 0.02em; }
.vp-id {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--hud-dim);
  border: 1px solid #223050;
  border-radius: 6px;
  padding: 1px 8px;
  white-space: nowrap;
  background: rgba(10, 17, 29, 0.6);
}
.vp-tools { display: flex; gap: 8px; align-items: center; }
.vp-tool {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--hud-dim);
  background: rgba(13, 20, 32, 0.85);
  border: 1px solid #223050;
  backdrop-filter: blur(8px);
  font-size: 12px;
  font-weight: 600;
  transition: color 0.15s var(--hud-ease), border-color 0.15s var(--hud-ease), background 0.15s var(--hud-ease);
}
.vp-tool:hover { color: var(--hud-text); border-color: #33507c; }
.vp-tool.on {
  color: #04120c;
  background: var(--hud-accent);
  border-color: var(--hud-accent);
  box-shadow: 0 0 12px rgba(53, 224, 160, 0.3);
}
.vp-svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.leaders {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 7;
  pointer-events: none;
}
.angle-chip {
  position: absolute;
  top: 64px;
  left: 16px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(9, 14, 24, 0.78);
  border: 1px solid #1c2942;
  border-radius: var(--hud-r-sm);
  padding: 5px 8px;
  backdrop-filter: blur(8px);
  font-size: 11.5px;
  color: var(--hud-dim);
}
.angle-chip select {
  background: transparent;
  border: 0;
  color: var(--hud-text);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
}
.angle-chip select option { background: #0e1626; }
.vp-title h2 { color: var(--hud-text); }
/* 按压态:轻微下沉,松手回弹(自 TownView.vue 同源规则搬移) */
.vp-tool:active {
  transform: scale(0.96);
}
vp-tool {
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
    .stage-top { padding: 10px 12px; gap: 8px; flex-wrap: wrap; }
    .vp-title { padding: 6px 10px; gap: 8px; }
    .vp-title h2 { font-size: 14px; }
    .vp-id { font-size: 11.5px; }
    .vp-tool { width: 40px; height: 40px; }
    .vp-svg { width: 17px; height: 17px; }
    .angle-chip { top: 58px; left: 12px; min-height: 40px; padding: 4px 10px; font-size: 13px; }
    .angle-chip select { font-size: 13px; }
}
@media (max-width: 639px) {
    .stage-top { padding: 8px 10px; }
    .vp-tools { gap: 6px; }
    .vp-tool { width: 40px; height: 40px; }
    .angle-chip { top: 54px; left: 10px; }
}
</style>
