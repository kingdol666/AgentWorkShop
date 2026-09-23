<script setup lang="ts">
/**
 * 小镇视图 · 右轨检查器 · 智控节点分支(设定值直写 + 绑定设备)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
import type { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import type { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'

const dcwWriteDrafts = defineModel<Record<string, number | ''>>('dcwWriteDrafts', { required: true })
const dcwBindPick = defineModel<string>('dcwBindPick', { required: true })

defineProps<{
  mode: 'browse' | 'edit'
  selected: { kind: 'agent' | 'device', id: string, scale: number, rotation: number }
  deviceTwins: ReturnType<typeof useDeviceTwins>
  dcw: ReturnType<typeof useDcwStream>
  selectedDcwNode: ReturnType<typeof useDcwStream>['nodes'][number] | null
  selectedDcwWindow: { lo: number, hi: number, src: 'recipe' | 'global' } | null
  selectedDcwDeviceName: string
  dcwWriteErrs: Record<string, string>
  dcwWinLabel: (n: ReturnType<typeof useDcwStream>['nodes'][number] | null) => string
  dcwWinInputPh: (n: ReturnType<typeof useDcwStream>['nodes'][number] | null) => string
  isLegacyDaqTwin: (t: ReturnType<typeof useDeviceTwins>['twins'][number]) => boolean
  doWriteSelectedDcw: () => void
  bindSelectedDcw: () => void
  unbindSelectedDcw: () => void
}>()
</script>

<template>
  <div
    class="daq-info"
  >
    <div class="daq-info-row">
      <span>{{ $t('townView.k1deqh0d069') }}</span>
      <b class="cy">{{ selectedDcwNode?.value != null ? selectedDcwNode.value.toFixed(selectedDcwNode.decimals) : '--' }} {{ selectedDcwNode?.unit }}</b>
    </div>
    <div class="daq-info-row">
      <span>{{ selectedDcwWindow?.src === 'recipe' ? $t('townView.kq2jssk147') : $t('townView.k1iwj796179') }}</span>
      <b :class="{ amber: selectedDcwWindow?.src === 'recipe' }">{{ dcwWinLabel(selectedDcwNode) }}</b>
    </div>
    <div class="daq-info-row">
      <span>{{ $t('townView.k1i8rtqt070') }}</span>
      <b>{{ selectedDcwDeviceName || $t('townView.k3own4q148') }}</b>
    </div>
    <div class="daq-bind-bar">
      <input
        v-model.number="dcwWriteDrafts[selected.id]"
        type="number"
        class="bind-select"
        :step="10 ** -(selectedDcwNode?.decimals ?? 2)"
        :placeholder="dcwWinInputPh(selectedDcwNode)"
        @keydown.enter="doWriteSelectedDcw"
      >
      <button
        class="bind-add-btn"
        :disabled="dcwWriteDrafts[selected.id] == null || dcwWriteDrafts[selected.id] === ''"
        @click="doWriteSelectedDcw"
      >
        {{ $t('townView.kwrbtn180') }}
      </button>
    </div>
    <p
      v-if="dcwWriteErrs[selected.id]"
      class="dcw-err"
    >
      {{ dcwWriteErrs[selected.id] }}
    </p>
    <div
      v-if="mode === 'edit'"
      class="daq-bind-bar"
    >
      <select
        v-model="dcwBindPick"
        class="bind-select"
      >
        <option value="">
          {{ $t('townView.kjo6ekr071') }}
        </option>
        <option
          v-for="dv in deviceTwins.twins.filter(x => !isLegacyDaqTwin(x) && x.id !== (selected?.id ?? ''))"
          :key="dv.id"
          :value="dv.id"
        >
          {{ dv.name }}
        </option>
      </select>
      <button
        class="bind-add-btn"
        :disabled="!selectedDcwDeviceName && !dcwBindPick"
        @click="selectedDcwDeviceName ? unbindSelectedDcw() : bindSelectedDcw()"
      >
        {{ selectedDcwDeviceName ? $t('townView.k479eh149') : $t('townView.k452a8102') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.dcw-err {
  display: block;
  padding: 4px 8px;
  font-size: 10px;
  color: var(--hud-danger);
  background: rgba(255, 107, 107, 0.08);
  border: 1px solid rgba(255, 107, 107, 0.28);
  border-radius: 6px;
}
/* ===== 控件语汇统一:输入场 focus 柔光环 + number 去原生 spinner ===== */
.obj-input:hover, .obj-select:hover, .bind-select:hover, .daq-num:hover,
.daq-ctl-cycle input:hover {
  border-color: var(--hud-line-hi);
}
.obj-input:focus, .obj-select:focus, .bind-select:focus, .daq-num:focus,
.daq-ctl-cycle input:focus {
  outline: none;
  border-color: var(--hud-accent);
  box-shadow: 0 0 0 3px rgba(53, 224, 160, 0.13);
}
input[type='number']::-webkit-outer-spin-button,
input[type='number']::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
input[type='number'] { -moz-appearance: textfield; appearance: textfield; }
.daq-bind-bar { display: flex; gap: 6px; }
.bind-select {
  flex: 1;
  min-width: 0;
  height: 28px;
  font-size: 10.5px;
  color: var(--hud-dim);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: var(--hud-r-sm);
  padding: 0 8px;
  transition: border-color 0.15s var(--hud-ease), box-shadow 0.15s var(--hud-ease), color 0.15s var(--hud-ease);
}
.bind-select:hover { border-color: var(--hud-line-hi); color: var(--hud-text); }
.bind-select:focus { outline: none; border-color: var(--hud-accent); color: var(--hud-text); box-shadow: 0 0 0 3px rgba(53, 224, 160, 0.13); }
.bind-add-btn {
  flex: none;
  height: 28px;
  padding: 0 12px;
  font-size: 10.5px;
  font-weight: 600;
  color: #04120c;
  background: var(--hud-accent-dim);
  border: 0;
  border-radius: var(--hud-r-sm);
  cursor: pointer;
  transition: background 0.15s var(--hud-ease), box-shadow 0.15s var(--hud-ease);
}
.bind-add-btn:hover:not(:disabled) {
  background: var(--hud-accent);
  box-shadow: 0 0 14px rgba(53, 224, 160, 0.35);
}
.bind-add-btn:disabled { opacity: 0.4; cursor: default; }
.daq-info-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--hud-dim);
  padding: 3px 0;
}
.daq-info-row b { font-family: var(--font-mono); font-weight: 600; color: var(--hud-text); font-variant-numeric: tabular-nums; }
.daq-info-row b.cy { color: var(--hud-cyan); font-size: 13px; }
/* 键盘可达:焦点环(设计稿 --focus-ring;补回 scoped 属性选择器降低的一档特异性,与 .town-view 规则同效) */
.bind-select:focus-visible,
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
