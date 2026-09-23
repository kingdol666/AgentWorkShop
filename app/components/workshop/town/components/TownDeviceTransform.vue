<script setup lang="ts">
/**
 * 小镇视图 · 右轨检查器 · 变换模式(Blender G/R/S + 缩放 + 删除)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
defineProps<{
  mode: 'browse' | 'edit'
  selected: { kind: 'agent' | 'device', id: string, scale: number, rotation: number }
  tMode: 'translate' | 'rotate' | 'scale'
  deviceDeleteArmed: string
  setTMode: (m: 'translate' | 'rotate' | 'scale') => void
  onScaleInput: (v: number) => void
  onScaleCommit: (v: number) => void
  removeSelectedDevice: () => void
}>()
</script>

<template>
  <!-- 变换模式(Blender G/R/S;仅编辑模式) -->
  <template v-if="mode === 'edit'">
    <div class="sect-hd">
      {{ $t('townView.transformBlender') }}
    </div>
    <div class="xz-seg">
      <button
        class="seg-btn"
        :class="{ on: tMode === 'translate' }"
        @click="setTMode('translate')"
      >
        {{ $t('townView.k1hg3167089') }}
      </button>
      <button
        class="seg-btn"
        :class="{ on: tMode === 'rotate' }"
        @click="setTMode('rotate')"
      >
        {{ $t('townView.k1enlg7i090') }}
      </button>
      <button
        class="seg-btn"
        :class="{ on: tMode === 'scale' }"
        @click="setTMode('scale')"
      >
        {{ $t('townView.k1ibjg3j091') }}
      </button>
    </div>
    <div class="scale-row">
      <span class="scale-min">0.2×</span>
      <input
        class="scale-range"
        type="range"
        min="0.2"
        max="5"
        step="0.05"
        :value="selected.scale"
        @input="onScaleInput(Number(($event.target as HTMLInputElement).value))"
        @change="onScaleCommit(Number(($event.target as HTMLInputElement).value))"
      >
      <span class="scale-max">5×</span>
    </div>
    <div class="scale-val">
      {{ Math.round(selected.scale * 100) }}%
    </div>

    <div class="ins-foot">
      <button
        class="btn btn-danger ins-del"
        :class="{ armed: deviceDeleteArmed === selected.id }"
        @click="removeSelectedDevice"
      >
        {{ deviceDeleteArmed === selected.id ? $t('townView.k1w10xa5152') : $t('townView.k121kfef182') }}
      </button>
    </div>
  </template>
  <div
    v-else
    class="ins-empty"
  >
    {{ $t('townView.kt0i3y2092') }}
  </div>
</template>

<style scoped>
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
.sect-hd {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--hud-faint);
  letter-spacing: 0.16em;
  font-weight: 700;
  margin: 10px 0 7px;
}
/* 分区头刻度线:与面板左缘数据条同 motif,建立分区节奏 */
.sect-hd::before {
  content: '';
  width: 3px;
  height: 9px;
  background: var(--hud-accent);
  border-radius: 1px;
  opacity: 0.55;
}
.obj-mini {
  flex: none;
  padding: 4px 10px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--hud-dim);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 7px;
  cursor: pointer;
}
.obj-mini.on { color: #04120c; background: var(--hud-accent); border-color: var(--hud-accent); }
.obj-mini.danger { color: var(--hud-danger); margin-top: 4px; width: 100%; }
.obj-range { flex: 1; accent-color: var(--hud-accent); }
.bp-seg { display: flex; gap: 4px; }
.seg-btn {
  padding: 4px 12px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--hud-dim);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 7px;
  cursor: pointer;
  transition: border-color 0.14s var(--hud-ease), color 0.14s var(--hud-ease), background 0.14s var(--hud-ease);
}
.seg-btn:hover { border-color: var(--hud-line-hi); color: var(--hud-text); }
.seg-btn.on { color: #04120c; background: var(--hud-accent); border-color: var(--hud-accent); }
.xz-seg { display: flex; gap: 6px; margin-bottom: 8px; }
.xz-seg .seg-btn { flex: 1; }
.scale-row { display: flex; gap: 8px; align-items: center; }
.scale-min, .scale-max { font-family: var(--font-mono); font-size: 10px; color: var(--hud-faint); }
.scale-range { flex: 1; accent-color: var(--hud-accent); }
.scale-val {
  text-align: center;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--hud-text);
  font-variant-numeric: tabular-nums;
  margin-bottom: 4px;
}
.ins-foot { display: flex; gap: 8px; margin-top: 12px; }
.ins-del { border: 0; background: rgba(255, 107, 107, 0.1); color: var(--hud-danger); border: 1px solid rgba(255, 107, 107, 0.4); }
.ins-del.armed { background: var(--hud-danger); color: #fff; }
.ins-empty { color: var(--hud-faint); font-size: 11px; text-align: center; padding: 8px 0 6px; }
/* ===== 滑块全自绘:细轨 + 白芯绿环 thumb(场景控制/变换缩放等) ===== */
.obj-range, .scale-range {
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  background: #1a2740;
  border-radius: 999px;
  outline: none;
  cursor: pointer;
}
.obj-range::-webkit-slider-thumb, .scale-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 13px;
  height: 13px;
  background: #e8f6ef;
  border: 2px solid var(--hud-accent);
  border-radius: 50%;
  box-shadow: 0 0 0 3px rgba(53, 224, 160, 0.15), 0 2px 6px rgba(3, 7, 14, 0.5);
  transition: transform 0.15s var(--hud-ease), box-shadow 0.15s var(--hud-ease);
}
.obj-range::-webkit-slider-thumb:hover, .scale-range::-webkit-slider-thumb:hover {
  transform: scale(1.18);
  box-shadow: 0 0 0 5px rgba(53, 224, 160, 0.2), 0 2px 8px rgba(3, 7, 14, 0.55);
}
.obj-range::-moz-range-thumb, .scale-range::-moz-range-thumb {
  width: 13px;
  height: 13px;
  background: #e8f6ef;
  border: 2px solid var(--hud-accent);
  border-radius: 50%;
  box-shadow: 0 0 0 3px rgba(53, 224, 160, 0.15);
}
.obj-range::-moz-range-track, .scale-range::-moz-range-track {
  height: 4px;
  background: #1a2740;
  border-radius: 999px;
}
@keyframes estop-pulse { 50% { filter: brightness(1.35); } }
.btn-danger.armed { animation: estop-pulse 1s ease-in-out infinite; }
/* 按压态:轻微下沉,松手回弹(自 TownView.vue 同源规则搬移) */
.btn:active, .obj-mini:active {
  transform: scale(0.96);
}
btn, obj-mini {
  transition-property: filter, background, border-color, color, transform, opacity;
  transition-duration: 0.15s;
  transition-timing-function: var(--hud-ease);
}
/* 键盘可达:焦点环(设计稿 --focus-ring;补回 scoped 属性选择器降低的一档特异性,与 .town-view 规则同效) */
.obj-range:focus-visible,
.scale-range:focus-visible,
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
  .btn-danger.armed { animation: none; }
}
</style>
