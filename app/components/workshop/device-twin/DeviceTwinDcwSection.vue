<script setup lang="ts">
/**
 * 设备孪生面板 · 智控设定区(自 DeviceTwinPanel.vue 抽出,纯结构搬移):
 * 一台设备绑定的全部智控通道行(set 值 / ACT 回读 / 生效上下限 / 窗口内直写下发)。
 *
 * 写入态(草稿/错误/busy)不在此新建:经 useDeviceTwinDcwWriteContext() 取面板注入的
 * 同一份(按智控节点 id 键控),行为与拆分前一致。
 */
import { useDeviceTwinDcwWriteContext } from '@/app/composables/workshop/useDeviceTwinDcwWrite'
import type { DcwLiveRow } from '@/app/composables/workshop/device-twin-types'

defineProps<{
  /** 该设备绑定的智控通道行(面板传入 dcwLive[twin.id]) */
  rows: DcwLiveRow[]
}>()

const dcw = useDeviceTwinDcwWriteContext()
</script>

<template>
  <div class="twin-dcw">
    <div
      v-for="r in rows"
      :key="r.id"
      class="dcw-item"
    >
      <div class="dcw-head">
        <em>{{ r.ch }}<i
          v-if="r.src === 'recipe'"
          class="dcw-src"
        >{{ $t('deviceTwinPanel.k48grv006') }}</i></em>
        <b class="dcw-set">{{ r.value != null ? r.value.toFixed(r.decimals) : '--' }}<i>{{ r.unit }}</i></b>
      </div>
      <div
        v-if="r.readValue != null || r.lastReadAt"
        class="dcw-act"
        :title="$t('deviceTwinPanel.k9r7d4e030')"
      >
        <em>ACT</em>
        <b>{{ r.readValue != null ? r.readValue.toFixed(r.decimals) : '--' }}<i>{{ r.unit }}</i></b>
        <i
          v-if="r.lastReadAt"
          class="dcw-act-at"
        >{{ r.lastReadAt.slice(11, 19) }}</i>
      </div>
      <div class="dcw-win">
        <span :title="r.src === 'recipe' ? $t('deviceTwinPanel.winRecipe') : $t('deviceTwinPanel.winRange')">{{ dcw.winText(r) }}</span>
      </div>
      <div class="dcw-ctrl">
        <input
          v-model.number="dcw.drafts[r.id]"
          type="number"
          class="ctrl-input"
          :step="10 ** -r.decimals"
          :min="Number.isFinite(r.lo) ? r.lo : undefined"
          :max="Number.isFinite(r.hi) ? r.hi : undefined"
          :placeholder="`${Number.isFinite(r.lo) ? r.lo : ''} ~ ${Number.isFinite(r.hi) ? r.hi : ''}`"
          @keydown.enter="dcw.write(r)"
        >
        <button
          class="ctrl-btn dcw-send"
          :disabled="dcw.drafts[r.id] == null || dcw.drafts[r.id] === '' || dcw.busy === r.id"
          :title="$t('deviceTwinPanel.k1j04u8001')"
          @click.stop="dcw.write(r)"
        >
          {{ dcw.busy === r.id ? '···' : 'SET' }}
        </button>
      </div>
      <small
        v-if="dcw.errs[r.id]"
        class="dcw-err"
      >{{ dcw.errs[r.id] }}</small>
    </div>
  </div>
</template>

<style scoped>
/* 智控设定区(每通道:set 值 + 上下限 + 窗口内直写) */
.twin-dcw {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 0 2px;
  padding-top: 6px;
  border-top: 1px dashed rgba(240, 160, 76, 0.35);
}
.dcw-item { display: flex; flex-direction: column; gap: 3px; }
.dcw-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--hud-dim);
}
.dcw-head em {
  font-style: normal;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dcw-src {
  font-style: normal;
  font-size: 10px;
  padding: 0 3px;
  margin-left: 4px;
  color: var(--hud-amber, #f6c453);
  border: 1px solid rgba(240, 160, 76, 0.5);
  border-radius: 2px;
}
.dcw-set {
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--hud-amber, #f6c453);
  white-space: nowrap;
}
.dcw-set i {
  font-style: normal;
  font-size: 10px;
  font-weight: 500;
  margin-left: 2px;
  opacity: 0.75;
}
.dcw-act {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--hud-dim);
}
.dcw-act em { font-style: normal; font-size: 10px; letter-spacing: 0.08em; color: var(--hud-faint); }
.dcw-act b {
  font-size: 11.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--hud-accent, #35e0a0);
  white-space: nowrap;
}
.dcw-act b i { font-style: normal; font-size: 10px; font-weight: 500; margin-left: 2px; opacity: 0.75; }
.dcw-act-at { font-style: normal; font-size: 10px; color: var(--hud-faint); }
.dcw-win {
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--hud-faint);
  letter-spacing: 0.04em;
}
.dcw-win span {
  border-bottom: 1px dotted var(--hud-line);
  padding-bottom: 1px;
}
.dcw-ctrl { display: flex; gap: 4px; align-items: center; }
.dcw-ctrl .ctrl-input { flex: 1; min-width: 0; width: auto; }
.dcw-send {
  flex: none;
  color: var(--hud-amber, #f6c453);
  border-color: rgba(240, 160, 76, 0.5);
}
.dcw-send:hover:not(:disabled) {
  background: rgba(240, 160, 76, 0.12);
  color: var(--hud-amber, #f6c453);
  border-color: var(--hud-amber, #f6c453);
}
.dcw-err {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--hud-danger, #ff6b5c);
}
.ctrl-btn {
  padding: 3px 7px;
  font-size: 10px;
  letter-spacing: 0.06em;
  font-weight: 600;
  font-family: var(--font-mono);
  color: var(--hud-text);
  background: transparent;
  border: 1px solid var(--hud-line);
  border-radius: 2px;
  cursor: pointer;
  transition: border-color 0.14s ease, color 0.14s ease, background 0.14s ease;
}
.ctrl-btn:hover:not(:disabled) {
  border-color: var(--hud-accent);
  color: var(--hud-accent);
}
.ctrl-btn:disabled { opacity: 0.45; cursor: default; }
.ctrl-input {
  width: 48px;
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 3px 6px;
  border: 1px solid var(--hud-line);
  border-radius: 2px;
  background: var(--hud-input);
  color: var(--hud-text);
  font-variant-numeric: tabular-nums;
}
.ctrl-input:focus { outline: none; border-color: var(--hud-accent); }
</style>
