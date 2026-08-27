<script setup lang="ts">
/**
 * 设备控制台(Device Twin Console) —— 工业数字孪生 HMI:
 * 设备实体直接列表展示(状态灯/遥测数据网格/下发控制),点击行聚焦小镇场景中的对应实体。
 *
 * 与 3D 小镇联动:拖 `dev` 模型进场景会创建设备 twin;本面板实时刷新其 state/telemetry,
 * 并提供 power_on/power_off/set_speed 等控制(等价 MCP device.control 的用户面)。
 */
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'

/** 实时数采数据(twinId → 该实体相关的实时通道:
 *  数采节点 = 自身通道;设备 = 绑定到它的全部数采通道;由 TownView 从模拟上报喂入) */
interface DaqLiveRow { ch: string, value: string, unit: string, alarm?: boolean }
defineProps<{ daqLive?: Record<string, DaqLiveRow[]> }>()

defineEmits<{ (e: 'focus-device', twin: { id: string, posX?: number, posZ?: number }): void }>()

const twins = useDeviceTwins()

/** 数采实体(绿卡):kind=daq 或旧数据 modelRef 前缀兜底 */
const isDaq = (t: { kind?: string, modelRef?: string }): boolean =>
  t.kind === 'daq' || (t.modelRef ?? '').startsWith('daq-')

// 节流轮询刷新(不打断拖拽/交互)
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void twins.load()
  timer = setInterval(() => void twins.load(), 2000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const busyId = ref('')
const ctrlMsg = ref('')
/** 行内删除(两步确认:首击布防 3s,再击执行) */
const armedId = ref('')
let armedTimer: ReturnType<typeof setTimeout> | null = null
async function removeTwin(t: { id: string, name: string }): Promise<void> {
  if (armedId.value !== t.id) {
    armedId.value = t.id
    if (armedTimer) clearTimeout(armedTimer)
    armedTimer = setTimeout(() => {
      armedId.value = ''
    }, 3000)
    return
  }
  if (armedTimer) clearTimeout(armedTimer)
  armedId.value = ''
  busyId.value = t.id
  ctrlMsg.value = ''
  try {
    await twins.remove(t.id)
  }
  catch (err) {
    ctrlMsg.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    busyId.value = ''
  }
}
async function doControl(t: { id: string, name: string }, command: string, args?: Record<string, unknown>): Promise<void> {
  busyId.value = t.id
  ctrlMsg.value = ''
  try {
    await twins.control(t.id, command, args)
  }
  catch (err) {
    ctrlMsg.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    busyId.value = ''
  }
}

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
  <aside class="twin-panel">
    <div class="twin-head">
      <span class="twin-kicker">设备控制台</span>
      <span class="twin-count">{{ twins.twins.length }}</span>
    </div>

    <div
      v-if="!twins.loaded"
      class="twin-empty"
    >
      正在装载设备寄存器…
    </div>
    <div
      v-else-if="twins.twins.length === 0"
      class="twin-empty"
    >
      <div class="twin-empty-frame">
        <div class="twin-empty-title">
          未注册设备
        </div>
        <div class="twin-empty-sub">
          将设备模型拖入孪生场景即可创建数字孪生实体
        </div>
      </div>
    </div>
    <div
      v-else
      class="twin-list"
    >
      <button
        v-for="t in twins.twins"
        :key="t.id"
        class="twin-card"
        :class="{ daq: isDaq(t) }"
        type="button"
        @click="$emit('focus-device', t)"
      >
        <div class="twin-row">
          <span class="twin-model-tag">{{ modelTag(t.modelRef || t.name) }}</span>
          <div class="twin-idbar">
            <span class="twin-name">{{ t.name }}</span>
            <span class="twin-code">{{ isDaq(t) ? 'DAQ' : devNo(t.id) }}</span>
          </div>
          <button
            class="twin-del"
            :class="{ armed: armedId === t.id }"
            :disabled="busyId === t.id"
            :title="armedId === t.id ? '再次点击确认删除该设备实例' : '删除该设备实例'"
            @click.stop="removeTwin(t)"
          >
            {{ armedId === t.id ? '确认' : '✕' }}
          </button>
          <span
            class="twin-state"
            :class="`s-${t.state}`"
          >
            <i
              class="twin-state-dot"
              :style="{ background: stateColor[t.state] || 'var(--hud-dim)' }"
            />
            {{ stateLabel[t.state] || t.state }}
          </span>
        </div>
        <div
          v-if="Object.keys(t.telemetry).length"
          class="twin-tele"
        >
          <span
            v-for="(v, k) in t.telemetry"
            :key="k"
            class="tele-item"
          ><em>{{ k }}</em><b>{{ fmt(v) }}</b></span>
        </div>
        <!-- 实时数采(绿色;数采节点 = 自身通道,设备 = 绑定通道) -->
        <div
          v-if="daqLive?.[t.id]?.length"
          class="twin-daq"
        >
          <span
            v-for="(d, i) in daqLive[t.id]"
            :key="`${d.ch}-${i}`"
            class="daq-item"
            :class="{ alarm: d.alarm }"
          >
            <em>{{ d.ch }}</em>
            <b>{{ d.value }}<i>{{ d.unit }}</i></b>
          </span>
        </div>
        <div
          v-if="!isDaq(t)"
          class="twin-ctrl"
        >
          <button
            class="ctrl-btn on"
            :disabled="busyId === t.id"
            @click.stop="doControl(t, 'power_on')"
          >
            开机
          </button>
          <button
            class="ctrl-btn"
            :disabled="busyId === t.id"
            @click.stop="doControl(t, 'power_off')"
          >
            停机
          </button>
          <input
            class="ctrl-input"
            type="number"
            :placeholder="'SPD'"
            @change="(e) => doControl(t, 'set_speed', { value: Number((e.target as HTMLInputElement).value) })"
          >
          <button
            class="ctrl-btn"
            :disabled="busyId === t.id"
            @click.stop="doControl(t, 'set_speed', { value: 60 })"
          >
            设定
          </button>
        </div>
      </button>
    </div>

    <span
      v-if="ctrlMsg"
      class="twin-err"
    >{{ ctrlMsg }}</span>
  </aside>
</template>

<style scoped>
.twin-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: auto;
  flex: none;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
.twin-head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px 12px 6px;
  border-bottom: 1px solid rgba(38, 51, 64, 0.45);
}
.twin-kicker {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.16em;
  color: var(--hud-text, #d9e4ee);
}
.twin-count {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--hud-dim, #8496a5);
}
.twin-empty {
  padding: 10px;
}
.twin-empty-frame {
  border: 1px dashed var(--hud-line);
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.twin-empty-title {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--hud-text);
}
.twin-empty-sub {
  font-size: 10px;
  line-height: 1.6;
  color: var(--hud-dim);
}
.twin-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 46vh;
  overflow: hidden auto;
  padding: 4px 0 10px;
}
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
  font-size: 9px;
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
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--hud-dim);
}
.twin-del {
  flex: none;
  width: 18px;
  height: 18px;
  font-family: var(--font-mono);
  font-size: 9px;
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
  font-size: 8.5px;
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
.daq-item b i { font-style: normal; font-size: 8.5px; font-weight: 500; margin-left: 2px; opacity: 0.75; }
.daq-item.alarm { color: var(--hud-amber, #f6c453); }
.twin-ctrl { display: flex; gap: 4px; align-items: center; }
.ctrl-btn {
  padding: 3px 7px;
  font-size: 9px;
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
.ctrl-btn.on {
  color: var(--hud-amber);
  border-color: rgba(240, 160, 76, 0.5);
}
.ctrl-btn.on:hover:not(:disabled) {
  background: rgba(240, 160, 76, 0.12);
  color: var(--hud-amber);
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
.twin-err { font-size: 9.5px; color: var(--hud-danger); padding: 0 10px 8px; }
</style>
