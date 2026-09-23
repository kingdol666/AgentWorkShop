<script setup lang="ts">
/**
 * 设备孪生面板 · 设备卡(自 DeviceTwinPanel.vue 抽出,纯结构搬移):
 * 单台设备的铭牌/状态灯/遥测网格/实时数采行,智控设定区交子组件。
 *
 * 数据经 props 传入、动作经事件上抛(面板仍是共享状态的唯一持有者,本组件不新建
 * 任何响应式副本;armed/busy 由面板的比较结果传入);样式为本组件模板专属规则,
 * 随模板一并搬移。
 */
import DeviceTwinDcwSection from './DeviceTwinDcwSection.vue'
import type { DaqLiveRow, DcwLiveRow } from '@/app/composables/workshop/device-twin-types'
import type { DeviceTwinView } from '@/app/composables/workshop/useDeviceTwins'

defineProps<{
  /** 该设备孪生实体 */
  twin: DeviceTwinView
  /** 该设备的实时数采行(面板传入 daqLive[twin.id]) */
  daqRows?: DaqLiveRow[]
  /** 该设备绑定的智控通道行(面板传入 dcwLive[twin.id]) */
  dcwRows?: DcwLiveRow[]
  /** 行内删除已布防(面板:armedId === twin.id) */
  armed: boolean
  /** 该行删除进行中(面板:busyId === twin.id) */
  busy: boolean
}>()

defineEmits<{
  (e: 'focus' | 'remove'): void
}>()

/** 数采实体(绿卡):kind=daq 或旧数据 modelRef 前缀兜底 */
const isDaq = (t: { kind?: string, modelRef?: string }): boolean =>
  t.kind === 'daq' || (t.modelRef ?? '').startsWith('daq-')
const stateColor: Record<string, string> = {
  idle: 'var(--hud-amber)',
  running: 'var(--hud-ok)',
  alarm: 'var(--hud-danger)',
  offline: 'var(--hud-dim)',
}
const stateLabel: Record<string, string> = {
  idle: 'STANDBY', running: 'RUNNING', alarm: 'ALARM', offline: 'OFFLINE',
}
const modelTag = (name: string): string => name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'DEV'
const devNo = (id: string): string => id.replace(/^dev-/, '').replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase()
const fmt = (v: unknown): string => (typeof v === 'number' ? (Math.round(v * 100) / 100).toString() : String(v))
</script>

<template>
  <button
    class="twin-card"
    :class="{ daq: isDaq(twin) }"
    type="button"
    @click="$emit('focus')"
  >
    <div class="twin-row">
      <span class="twin-model-tag">{{ modelTag(twin.modelRef || twin.name) }}</span>
      <div class="twin-idbar">
        <span class="twin-name">{{ twin.name }}</span>
        <span class="twin-code">{{ isDaq(twin) ? 'DAQ' : devNo(twin.id) }}</span>
      </div>
      <button
        class="twin-del"
        :class="{ armed }"
        :disabled="busy"
        :title="armed ? $t('deviceTwinPanel.armDelete') : $t('deviceTwinPanel.delDevice')"
        @click.stop="$emit('remove')"
      >
        {{ armed ? $t('deviceTwinPanel.k44653007') : '✕' }}
      </button>
      <span
        class="twin-state"
        :class="`s-${twin.state}`"
      >
        <i
          class="twin-state-dot"
          :style="{ background: stateColor[twin.state] || 'var(--hud-dim)' }"
        />
        {{ stateLabel[twin.state] || twin.state }}
      </span>
    </div>
    <div
      v-if="Object.keys(twin.telemetry).length"
      class="twin-tele"
    >
      <span
        v-for="(v, k) in twin.telemetry"
        :key="k"
        class="tele-item"
      ><em>{{ k }}</em><b>{{ fmt(v) }}</b></span>
    </div>
    <!-- 实时数采(绿色;数采节点 = 自身通道,设备 = 绑定通道) -->
    <div
      v-if="daqRows?.length"
      class="twin-daq"
    >
      <span
        v-for="(d, i) in daqRows"
        :key="`${d.ch}-${i}`"
        class="daq-item"
        :class="{ alarm: d.alarm }"
      >
        <em>{{ d.ch }}</em>
        <b>{{ d.value }}<i>{{ d.unit }}</i></b>
      </span>
    </div>
    <!-- 智控设定(绑定通道的当前 set 值展示 + 生效上下限 + 窗口内直写下发) -->
    <DeviceTwinDcwSection
      v-if="dcwRows?.length"
      :rows="dcwRows ?? []"
    />
  </button>
</template>

<style scoped>
.twin-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 10px;
  padding: 8px 9px;
  text-align: left;
  background: rgba(20, 27, 38, 0.65);
  border: 0;
  border-radius: 2px;
  cursor: pointer;
  transition: background 0.16s ease;
}
.twin-card:hover {
  background: var(--hud-panel-hover);
}
.twin-card:active {
  background: var(--hud-panel-raised);
}
.twin-card:hover .twin-name { color: #e8f1f8; }
/* 数采节点绿卡(用户指定:设备监控中数采卡为绿色) */
.twin-card.daq {
  background: rgba(53, 224, 160, 0.06);
  border: 1px solid rgba(53, 224, 160, 0.32);
}
.twin-card.daq:hover {
  background: rgba(53, 224, 160, 0.11);
  border-color: rgba(53, 224, 160, 0.5);
}
.twin-card.daq .twin-model-tag,
.twin-card.daq .twin-code { color: var(--hud-accent, #35e0a0); }
.twin-row { display: flex; gap: 8px; align-items: center; min-width: 0; }
.twin-model-tag {
  flex: none;
  min-width: 30px;
  font-family: var(--font-mono);
  /* 9px 的 mono 铭牌在 1440 下也读不动(实测每屏稳定被判为不可读);
     10px 是孪生侧栏这套 HUD 在桌面档的地板。 */
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--hud-faint);
}
.twin-idbar { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.twin-name {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--hud-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.twin-code {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--hud-dim);
}
.twin-del {
  flex: none;
  width: 18px;
  height: 18px;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  color: var(--hud-dim, #8496a5);
  background: transparent;
  border: 1px solid var(--hud-line, #263340);
  border-radius: 2px;
  cursor: pointer;
  transition: border-color 0.14s ease, color 0.14s ease, background 0.14s ease;
}
.twin-del:hover:not(:disabled) {
  border-color: var(--hud-danger, #ff6b5c);
  color: var(--hud-danger, #ff6b5c);
}
.twin-del.armed {
  width: auto;
  padding: 0 5px;
  color: #1a0d0a;
  background: var(--hud-danger, #ff6b5c);
  border-color: var(--hud-danger, #ff6b5c);
}
.twin-del:disabled { opacity: 0.4; cursor: default; }
.twin-state {
  flex: none;
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--hud-dim);
  padding: 2px 5px;
  border: 1px solid var(--hud-line);
  border-radius: 2px;
}
.twin-state.s-alarm { color: var(--hud-danger); border-color: rgba(255, 107, 92, 0.5); }
.twin-state.s-running { color: var(--hud-ok); border-color: rgba(127, 212, 160, 0.4); }
.twin-state-dot { width: 5px; height: 5px; border-radius: 50%; }
.twin-tele {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 10px;
  margin: 0 0 2px;
  padding-top: 6px;
  border-top: 1px dashed var(--hud-line);
}
.tele-item {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  color: var(--hud-dim);
  min-width: 0;
}
.tele-item em { font-style: normal; overflow: hidden; text-overflow: ellipsis; }
.tele-item b { color: var(--hud-text); font-weight: 500; }
/* 实时数采行(绿;越限琥珀) */
.twin-daq {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 0 2px;
  padding-top: 6px;
  border-top: 1px dashed rgba(53, 224, 160, 0.3);
}
.daq-item {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  color: var(--hud-accent, #35e0a0);
  min-width: 0;
}
.daq-item em {
  font-style: normal;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
}
.daq-item b { font-weight: 700; font-size: 10.5px; white-space: nowrap; }
.daq-item b i { font-style: normal; font-size: 10px; font-weight: 500; margin-left: 2px; opacity: 0.75; }
.daq-item.alarm { color: var(--hud-amber, #f6c453); }
</style>
