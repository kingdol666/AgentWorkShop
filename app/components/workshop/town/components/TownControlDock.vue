<script setup lang="ts">
/**
 * 小镇视图 · 底部坞:场景控制卡(渲染 / 环境 / 操作 三组仪表分区)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 * 窄屏可收起横条的开合按钮随卡片一并迁入(开合状态经 v-model:dock-open 交回父组件)。
 */
const dockOpen = defineModel<boolean>('dockOpen', { required: true })
const threshPct = defineModel<number>('threshPct', { required: true })
const calloutNearDist = defineModel<number>('calloutNearDist', { required: true })

defineProps<{
  mode: 'browse' | 'edit'
  qualityMode: 'auto' | 'normal' | 'hd' | 'ultra'
  fpsCap: '60' | '120' | '0'
  qualityOptions: ReadonlyArray<{ v: 'auto' | 'normal' | 'hd' | 'ultra', label: string }>
  fpsOptions: ReadonlyArray<{ v: '60' | '120' | '0', label: string }>
  exposure: number
  tintOpacity: number
  snap: boolean
  estop: boolean
  sliderPct: (v: number, min: number, max: number) => string
  setQualityMode: (v: 'auto' | 'normal' | 'hd' | 'ultra') => void
  setFpsCap: (v: '60' | '120' | '0') => void
  onExposureInput: (e: Event) => void
  onTintInput: (e: Event) => void
  toggleSnap: () => void
  onResetView: () => void
  saveLayout: () => void
  toggleEstop: () => void
}>()
</script>

<template>
  <!-- 窄屏:底部坞折成可收起横条(桌面档 CSS 隐藏),默认收起让舞台占满 -->
  <button
    type="button"
    class="dock-toggle"
    aria-controls="town-dock-controls"
    :aria-expanded="dockOpen ? 'true' : 'false'"
    @click="dockOpen = !dockOpen"
  >
    <span class="dock-toggle-t">{{ $t('townView.k1c9iq23060') }}</span>
    <span class="dock-toggle-hint mono">{{ mode === 'edit' ? $t('townView.k1iipfcs143') : $t('townView.k1l147w1177') }}</span>
    <span
      class="dock-caret"
      aria-hidden="true"
    >▾</span>
  </button>
  <section
    id="town-dock-controls"
    class="dock-card"
  >
    <div class="dock-hd">
      <h3>{{ $t('townView.k1c9iq23060') }}</h3>
      <span class="dock-mode">{{ mode === 'edit' ? $t('townView.k1iipfcs143') : $t('townView.k1l147w1177') }}</span>
    </div>
    <p class="ctl-sec">
      {{ $t('townView.secRender') }}
    </p>
    <div class="ctl-row">
      <span
        class="ctl-name"
        :title="$t('townView.qualityTip')"
      >{{ $t('townView.qualityLabel') }}</span>
      <div class="fps-seg">
        <button
          v-for="o in qualityOptions"
          :key="o.v"
          :class="{ on: qualityMode === o.v }"
          @click="setQualityMode(o.v)"
        >
          {{ $t(o.label) }}
        </button>
      </div>
      <span class="ctl-val" />
    </div>
    <div class="ctl-row">
      <span
        class="ctl-name"
        :title="$t('townView.fpsCapTip')"
      >{{ $t('townView.fpsCapLabel') }}</span>
      <div class="fps-seg">
        <button
          v-for="o in fpsOptions"
          :key="o.v"
          :class="{ on: fpsCap === o.v }"
          @click="setFpsCap(o.v)"
        >
          {{ o.label }}
        </button>
      </div>
      <span class="ctl-val" />
    </div>
    <p class="ctl-sec">
      {{ $t('townView.secEnv') }}
    </p>
    <div class="ctl-row">
      <span class="ctl-name">{{ $t('townView.k1gizopz061') }}</span>
      <input
        class="ctl-range"
        type="range"
        min="30"
        max="220"
        :value="Math.round(exposure * 100)"
        :style="{ '--fill': sliderPct(Math.round(exposure * 100), 30, 220) }"
        @input="onExposureInput($event)"
      >
      <span class="ctl-val">{{ Math.round(exposure * 100) }}%</span>
    </div>
    <div class="ctl-row">
      <span class="ctl-name">{{ $t('townView.k1bcpqto062') }}</span>
      <input
        class="ctl-range"
        type="range"
        min="10"
        max="100"
        :value="Math.round(tintOpacity * 100)"
        :style="{ '--fill': sliderPct(Math.round(tintOpacity * 100), 10, 100) }"
        @input="onTintInput($event)"
      >
      <span class="ctl-val">{{ Math.round(tintOpacity * 100) }}%</span>
    </div>
    <div class="ctl-row">
      <span class="ctl-name">{{ $t('townView.k1bztha1063') }}</span>
      <input
        class="ctl-range"
        type="range"
        min="60"
        max="120"
        :value="threshPct"
        :style="{ '--fill': sliderPct(threshPct, 60, 120) }"
        @input="threshPct = Number(($event.target as HTMLInputElement).value)"
      >
      <span class="ctl-val">{{ threshPct }}%</span>
    </div>
    <div class="ctl-row">
      <span
        class="ctl-name"
        :title="$t('townView.kz71l1f012')"
      >{{ $t('townView.ka4i1s9064') }}</span>
      <input
        class="ctl-range"
        type="range"
        min="0"
        max="3000"
        step="50"
        :value="calloutNearDist"
        :style="{ '--fill': sliderPct(calloutNearDist, 0, 3000) }"
        @input="calloutNearDist = Number(($event.target as HTMLInputElement).value)"
      >
      <span class="ctl-val">{{ calloutNearDist === 0 ? $t('townView.k493s144') : `${calloutNearDist}` }}</span>
    </div>
    <p class="ctl-sec">
      {{ $t('townView.secOps') }}
    </p>
    <div class="ctl-row">
      <span class="ctl-name">{{ $t('townView.k1idc6pa065') }}</span>
      <button
        class="snap-toggle"
        :class="{ on: snap }"
        @click="toggleSnap"
      >
        {{ snap ? $t('townView.k4bs5145') : $t('townView.k493s144') }}
      </button>
      <span class="ctl-val" />
    </div>
    <div class="ctl-btns">
      <button
        class="btn btn-primary"
        @click="onResetView"
      >
        {{ $t('townView.k1lap9bs024') }}
      </button>
      <button
        class="btn btn-ghost"
        :disabled="mode !== 'edit'"
        :title="mode === 'edit' ? $t('townView.ksavetip181') : $t('townView.krotip182')"
        @click="saveLayout"
      >
        {{ $t('townView.k1b3bk8t029') }}
      </button>
      <button
        class="btn btn-danger"
        :class="{ armed: estop }"
        @click="toggleEstop"
      >
        {{ $t('townView.k1i046wf066') }}
      </button>
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
.ctl-row { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; }
/* 分区微标(仪表铭牌语言):mono 小字 + 极低饱和,组与组之间唯一的结构性装饰 */
.ctl-sec {
  margin: 2px 0 7px;
  padding-top: 7px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--hud-faint);
  border-top: 1px solid var(--hud-line-soft);
}
.ctl-sec:first-of-type { margin-top: 0; padding-top: 0; border-top: 0; }
.ctl-name { font-size: 11.5px; color: var(--hud-dim); width: 64px; flex: none; }
.ctl-val {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--hud-text);
  width: 38px;
  text-align: right;
  flex: none;
  font-variant-numeric: tabular-nums;
}
.ctl-range {
  -webkit-appearance: none;
  appearance: none;
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--hud-accent-dim) var(--fill, 50%), #1d2a42 var(--fill, 50%));
  cursor: pointer;
}
.ctl-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  border: 2.5px solid var(--hud-accent);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  transition: transform 0.15s var(--hud-ease), box-shadow 0.15s var(--hud-ease);
}
.ctl-range:hover::-webkit-slider-thumb { transform: scale(1.18); box-shadow: 0 0 0 5px rgba(53, 224, 160, 0.12), 0 1px 4px rgba(0, 0, 0, 0.5); }
.ctl-range:active::-webkit-slider-thumb { transform: scale(1.05); }
.bp-range { accent-color: var(--hud-accent); }
.bp-range::-webkit-slider-thumb { transition: transform 0.15s var(--hud-ease); }
.bp-range:hover::-webkit-slider-thumb { transform: scale(1.15); }
.snap-toggle {
  flex: 1;
  height: 22px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--hud-dim);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 6px;
  cursor: pointer;
}
.snap-toggle.on { color: var(--hud-accent); border-color: rgba(53, 224, 160, 0.4); background: rgba(53, 224, 160, 0.08); }
/* 帧率选择段(60/120/∞):渲染节拍上限;数据消费在帧通道,与选择无关 */
.fps-seg { display: flex; flex: 1; gap: 4px; }
.fps-seg button {
  flex: 1;
  height: 22px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 600;
  color: var(--hud-dim);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 0.14s var(--hud-ease), color 0.14s var(--hud-ease), background 0.14s var(--hud-ease);
}
.fps-seg button:hover { border-color: var(--hud-line-hi); color: var(--hud-text); }
.fps-seg button.on { color: var(--hud-accent); border-color: rgba(53, 224, 160, 0.4); background: rgba(53, 224, 160, 0.08); }
.ctl-btns { display: flex; gap: 8px; margin-top: auto; }
.btn {
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--hud-r-sm);
  font-size: 12px;
  font-weight: 600;
  flex: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: filter 0.15s var(--hud-ease), background 0.15s var(--hud-ease), border-color 0.15s var(--hud-ease);
}
.btn-primary { background: var(--hud-accent-dim); color: #04120c; }
.btn-primary:hover { background: #25b57e; }
.btn-ghost { border: 1px solid #27395c; color: var(--hud-text); }
.btn-ghost:hover { background: #14203a; border-color: #33507c; }
.btn-danger { background: #b3273a; color: #fff; }
.btn-danger:hover { background: #d1304a; }
.btn:not(:disabled):active { transform: translateY(1px); }
/* 只读态:禁用控件降透明度 + 禁止光标(运行模式视觉语言) */
.btn:disabled, .nav-action:disabled, .obj-input:disabled, .obj-select:disabled,
.bind-select:disabled, .obj-mini:disabled {
  opacity: 0.38;
  cursor: not-allowed;
  filter: saturate(0.4);
}
.btn:disabled:hover, .nav-action:disabled:hover { background: inherit; }
@keyframes estop-pulse { 50% { filter: brightness(1.35); } }
.btn-danger.armed { animation: estop-pulse 1s ease-in-out infinite; }
/* 按压态:轻微下沉,松手回弹(自 TownView.vue 同源规则搬移) */
.btn:active, .snap-toggle:active {
  transform: scale(0.96);
}
btn, snap-toggle {
  transition-property: filter, background, border-color, color, transform, opacity;
  transition-duration: 0.15s;
  transition-timing-function: var(--hud-ease);
}
/* 键盘可达:焦点环(设计稿 --focus-ring;补回 scoped 属性选择器降低的一档特异性,与 .town-view 规则同效) */
.snap-toggle:focus-visible,
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
    .dock-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 44px;
      padding: 0 12px;
      border: 0;
      border-top: 1px solid var(--hud-line-soft);
      background: linear-gradient(180deg, #101827, #0c131f);
      color: var(--hud-text);
      font-size: 13px;
      font-weight: 600;
      text-align: left;
    }
    .dock-toggle-t { flex: none; }
    .dock-toggle-hint {
      font-size: 11.5px;
      color: var(--hud-faint);
      letter-spacing: 0.08em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dock-caret { margin-left: auto; flex: none; color: var(--hud-dim); transition: transform 0.2s var(--hud-ease); }
    .dock.dock-open .dock-caret { transform: rotate(180deg); }
}
@media (max-width: 1023px) {
    .dock-hd h3 { font-size: 13px; }
    .dock-count,
    .dock-mode { font-size: 11.5px; }
    .ctl-sec { font-size: 11.5px; }
    .ctl-row { flex-wrap: wrap; gap: 6px 10px; }
    .ctl-name { width: auto; min-width: 62px; font-size: 13px; }
    .ctl-val { width: auto; min-width: 38px; font-size: 12.5px; }
    .fps-seg { flex-wrap: wrap; }
    .fps-seg button { font-size: 13px; padding: 0 10px; }
    .snap-toggle { font-size: 11.5px; }
}
@media (prefers-reduced-motion: reduce) {
  .dock-caret { transition: none; }
}

@media (max-width: 1023px) {
  .ctl-val { font-size: 12.5px; }
  .dock-hd h3 { font-size: 13px; }
}
</style>
