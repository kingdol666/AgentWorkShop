<script setup lang="ts">
/**
 * 小镇视图 · 右轨导航图(全域缩略画布 + 视角按钮 + 缩放读数)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
import type { TownScene3D } from '../TownScene3D'
import type { MiniState } from '@/app/composables/workshop/town/town-view-types'

defineProps<{
  minimap: MiniState | null
  navScale: number
  scene3dRef: TownScene3D | null
  setCanvas: (el: Element | ComponentPublicInstance | null) => void
  onNavDown: (e: PointerEvent) => void
  onNavMove: (e: PointerEvent) => void
  onNavUp: (e: PointerEvent) => void
  onNavWheel: (e: WheelEvent) => void
  onResetView: () => void
}>()
</script>

<template>
  <div class="mm-body">
    <div
      class="mm-wrap"
      :title="$t('townView.klfwiqg023')"
    >
      <canvas
        :ref="setCanvas"
        class="nav-cv"
        @pointerdown="onNavDown"
        @pointermove="onNavMove"
        @pointerup="onNavUp"
        @pointercancel="onNavUp"
        @wheel.prevent="onNavWheel"
      />
    </div>
    <div class="mm-col">
      <button
        class="vp-tool"
        :title="$t('townView.k1lap9bs024')"
        @click="onResetView"
      >
        <svg
          class="vp-svg"
          viewBox="0 0 24 24"
        ><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" /></svg>
      </button>
      <button
        class="vp-tool"
        :title="$t('townView.kav8a8k025')"
        @click="scene3dRef?.zoomBy(0.22)"
      >
        <svg
          class="vp-svg"
          viewBox="0 0 24 24"
        ><circle
          cx="11"
          cy="11"
          r="6.5"
        /><path d="m16 16 4.5 4.5M8.5 11h5" /></svg>
      </button>
      <button
        class="vp-tool"
        :title="$t('townView.k1u7uce9026')"
        @click="scene3dRef?.zoomBy(-0.18)"
      >
        <svg
          class="vp-svg"
          viewBox="0 0 24 24"
        ><circle
          cx="11"
          cy="11"
          r="6.5"
        /><path d="m16 16 4.5 4.5M8.5 11h5M11 8.5v5" /></svg>
      </button>
    </div>
  </div>
  <div class="mm-meta mono">
    {{ $t('townView.k1gaaodq136') }}{{ navScale.toFixed(1) }} · {{ minimap?.devices?.length ?? 0 }} {{ $t('townView.k47e16126') }}
  </div>
</template>

<style scoped>
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
/* 导航图 */
.mm-body { display: flex; gap: 8px; align-items: stretch; }
.mm-wrap {
  flex: 1;
  position: relative;
  border-radius: var(--hud-r-md);
  overflow: hidden;
  border: 1px solid #223050;
  min-height: 148px;
  background: #060b13;
}
.mini-svg { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; }
.nav-cv { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
.mm-col { display: flex; flex-direction: column; gap: 6px; }
.mm-col .vp-tool { width: 30px; height: 30px; border-radius: 8px; }
.mm-meta {
  margin-top: 8px;
  font-size: 9.5px;
  color: var(--hud-faint);
  letter-spacing: 0.08em;
  text-align: center;
}
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
</style>
