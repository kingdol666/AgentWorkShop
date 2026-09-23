<script setup lang="ts">
/**
 * 小镇视图 · 右轨检查器 · 数采节点分支(单点控制 + 绑定设备)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
import type { DaqNodeLive, useDaqStream } from '@/app/composables/workshop/useDaqStream'
import type { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'
import type { DaqSimState } from '@/app/composables/workshop/town/town-view-types'

const bindPick = defineModel<string>('bindPick', { required: true })
const daqIntervalDraft = defineModel<number | null>('daqIntervalDraft', { required: true })

defineProps<{
  mode: 'browse' | 'edit'
  selected: { kind: 'agent' | 'device', id: string, scale: number, rotation: number }
  deviceTwins: ReturnType<typeof useDeviceTwins>
  daq: ReturnType<typeof useDaqStream>
  daqBoundDeviceName: string
  selectedDaqNode: DaqNodeLive | null
  selectedDaqSim: DaqSimState | null | undefined
  fmtDaq: (st: DaqSimState) => string
  isLegacyDaqTwin: (t: ReturnType<typeof useDeviceTwins>['twins'][number]) => boolean
  onDaqIntervalCommit: () => void
  onDaqThresholdCommit: (key: 'min' | 'max' | 'warnLow' | 'warnHigh', raw: string) => void
  removeSelectedDevice: () => void
  unbindDaq: (daqId: string) => void
  bindDaq: (daqId: string, deviceId: string) => void
}>()
</script>

<template>
  <div
    class="daq-info"
  >
    <div class="daq-info-row">
      <span>{{ $t('townView.k3mv305072') }}</span>
      <b class="cy">{{ selectedDaqSim ? fmtDaq(selectedDaqSim) : '--' }} {{ selectedDaqSim?.tpl.unit }}</b>
    </div>
    <div class="daq-info-row">
      <span>{{ $t('townView.k1faqmjb073') }}</span>
      <b>{{ selectedDaqSim?.tpl.min }} ~ {{ selectedDaqSim?.tpl.max }}</b>
    </div>
    <div class="daq-info-row">
      <span>{{ $t('townView.k1i8rtqt070') }}</span>
      <b>{{ daqBoundDeviceName || $t('townView.k3own4q148') }}</b>
    </div>
    <div
      v-if="mode === 'edit'"
      class="daq-bind-bar"
    >
      <select
        v-model="bindPick"
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
        :disabled="!daqBoundDeviceName && !bindPick"
        @click="daqBoundDeviceName ? unbindDaq(selected.id) : bindDaq(selected.id, bindPick); bindPick = ''"
      >
        {{ daqBoundDeviceName ? $t('townView.k479eh149') : $t('townView.k452a8102') }}
      </button>
    </div>
    <!-- 节点单点控制(server DaqNode 参数:启停/周期/量程/预警带;REST 落库即时生效) -->
    <div
      v-if="mode === 'edit' && selectedDaqNode"
      class="daq-node-ctl"
    >
      <div class="daq-info-row">
        <span>{{ $t('townView.k1l6g2ga074') }}</span>
        <span class="daq-th-inputs">
          <input
            v-model.number="daqIntervalDraft"
            type="number"
            min="200"
            max="60000"
            step="100"
            class="daq-num"
            @change="onDaqIntervalCommit"
          ><small>{{ $t('townView.k1or92b075') }}</small>
        </span>
      </div>
      <div class="daq-info-row">
        <span>{{ $t('townView.k3x5tpx076') }}</span>
        <span class="daq-th-inputs">
          <input
            :value="selectedDaqNode.warnLow"
            type="number"
            step="any"
            class="daq-num"
            @change="onDaqThresholdCommit('warnLow', ($event.target as HTMLInputElement).value)"
          >
          ~
          <input
            :value="selectedDaqNode.warnHigh"
            type="number"
            step="any"
            class="daq-num"
            @change="onDaqThresholdCommit('warnHigh', ($event.target as HTMLInputElement).value)"
          >
        </span>
      </div>
      <div class="daq-info-row">
        <span>{{ $t('townView.k1hjj0jf077') }}</span>
        <span class="daq-th-inputs">
          <input
            :value="selectedDaqNode.min"
            type="number"
            step="any"
            class="daq-num"
            @change="onDaqThresholdCommit('min', ($event.target as HTMLInputElement).value)"
          >
          ~
          <input
            :value="selectedDaqNode.max"
            type="number"
            step="any"
            class="daq-num"
            @change="onDaqThresholdCommit('max', ($event.target as HTMLInputElement).value)"
          >
        </span>
      </div>
      <div class="daq-info-row">
        <span>{{ $t('townView.k48tki078') }}</span>
        <button
          class="bind-add-btn"
          :class="{ warn: selectedDaqNode.enabled }"
          @click="daq.patchNode(selected.id, { enabled: !selectedDaqNode.enabled })"
        >
          {{ selectedDaqNode.enabled ? $t('townView.k1wv0nyo150') : $t('townView.kh1586b180') }}
        </button>
      </div>
      <div class="daq-info-row">
        <span>{{ $t('townView.k3xakp079') }}</span>
        <button
          class="bind-add-btn danger"
          :title="$t('townView.kpwutri014')"
          @click="removeSelectedDevice()"
        >
          {{ $t('townView.k1bpp30k080') }}
        </button>
      </div>
    </div>
    <div
      v-else
      class="ins-empty"
    >
      {{ $t('townView.kzk5dfx081') }}
    </div>
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
.ins-empty { color: var(--hud-faint); font-size: 11px; text-align: center; padding: 8px 0 6px; }
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

/* ===== 数采总控(左轨)+ 节点单点控制(检查器)===== */
.daq-ctrl {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  margin-bottom: 10px;
  background: var(--hud-panel);
  border: 1px solid var(--hud-line);
  border-radius: var(--hud-r-sm);
}
.daq-ctl-btn {
  padding: 4px 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.05em;
  color: var(--hud-dim);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--hud-line-hi);
  border-radius: var(--hud-r-sm);
}
.daq-ctl-btn.on {
  color: var(--hud-accent);
  border-color: rgba(53, 224, 160, 0.45);
}
.daq-ctl-cycle {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-size: 10.5px;
  color: var(--hud-faint);
}
.daq-ctl-cycle input,
.daq-num {
  width: 64px;
  padding: 2px 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--hud-text);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 6px;
}
.daq-th-inputs {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  font-size: 10px;
  color: var(--hud-faint);
}
.bind-add-btn.warn:not(:disabled) {
  color: var(--hud-amber);
  background: rgba(246, 196, 83, 0.12);
  box-shadow: none;
}
.bind-add-btn.warn:hover:not(:disabled) {
  background: rgba(246, 196, 83, 0.2);
  box-shadow: 0 0 14px rgba(246, 196, 83, 0.25);
}
.bind-add-btn.danger:not(:disabled) {
  color: var(--hud-danger);
  background: rgba(255, 107, 107, 0.1);
  box-shadow: none;
}
.bind-add-btn.danger:hover:not(:disabled) {
  background: rgba(255, 107, 107, 0.18);
  box-shadow: 0 0 14px rgba(255, 107, 107, 0.25);
}
/* 键盘可达:焦点环(设计稿 --focus-ring;补回 scoped 属性选择器降低的一档特异性,与 .town-view 规则同效) */
.bind-select:focus-visible,
.daq-num:focus-visible,
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
