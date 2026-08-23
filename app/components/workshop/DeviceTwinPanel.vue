<script setup lang="ts">
/**
 * 数字孪生侧栏(Device Twin Panel) —— 列出设备、实时遥测、下发控制指令。
 *
 * 与 3D 小镇联动:拖 `dev` 模型进场景会创建设备 twin;本面板实时刷新其 state/telemetry,
 * 并提供 power_on/power_off/set_speed 等控制(等价 MCP device.control 的用户面)。
 */
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'

const twins = useDeviceTwins()

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
  idle: 'var(--tone-warning-dot)',
  running: 'var(--tone-success-dot)',
  alarm: 'var(--tone-danger-dot)',
  offline: 'var(--ink-faint)',
}
const stateLabel: Record<string, string> = {
  idle: '待机', running: '运行', alarm: '告警', offline: '离线',
}
const fmt = (v: unknown): string => (typeof v === 'number' ? (Math.round(v * 100) / 100).toString() : String(v))
</script>

<template>
  <aside class="twin-panel">
    <div class="twin-head">
      <span class="head-dot" />
      <span class="head-title">数字孪生</span>
      <span class="head-hint">设备 · 遥测 · 控制</span>
    </div>

    <div
      v-if="!twins.loaded"
      class="twin-empty"
    >
      载入中…
    </div>
    <div
      v-else-if="twins.twins.length === 0"
      class="twin-empty"
    >
      暂无设备。把「工业泵设备」(⚙)拖入小镇即可创建数字孪生。
    </div>
    <div
      v-else
      class="twin-list"
    >
      <div
        v-for="t in twins.twins"
        :key="t.id"
        class="twin-card"
      >
        <div class="twin-row">
          <span
            class="twin-state-dot"
            :style="{ background: stateColor[t.state] || 'var(--ink-faint)' }"
          />
          <span class="twin-name">{{ t.name }}</span>
          <span class="twin-state">{{ stateLabel[t.state] || t.state }}</span>
        </div>
        <div
          v-if="Object.keys(t.telemetry).length"
          class="twin-tele"
        >
          <span
            v-for="(v, k) in t.telemetry"
            :key="k"
            class="tele-item"
          >{{ k }}: <b>{{ fmt(v) }}</b></span>
        </div>
        <div class="twin-ctrl">
          <button
            class="ctrl-btn"
            :disabled="busyId === t.id"
            @click="doControl(t, 'power_on')"
          >
            开
          </button>
          <button
            class="ctrl-btn"
            :disabled="busyId === t.id"
            @click="doControl(t, 'power_off')"
          >
            关
          </button>
          <input
            class="ctrl-input"
            type="number"
            :placeholder="'速度'"
            @change="(e) => doControl(t, 'set_speed', { value: Number((e.target as HTMLInputElement).value) })"
          >
          <button
            class="ctrl-btn"
            :disabled="busyId === t.id"
            @click="doControl(t, 'set_speed', { value: 60 })"
          >
            设定
          </button>
        </div>
      </div>
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
  gap: 9px;
  width: 172px;
  flex: none;
  padding: 10px 12px;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-highlight);
}
.twin-head { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--ink-soft); }
.head-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tone-warning-dot); }
.head-title { font-weight: 700; color: var(--ink); }
.head-hint { margin-left: auto; font-size: 10px; color: var(--ink-faint); white-space: nowrap; }
.twin-empty { font-size: 11px; color: var(--ink-faint); padding: 6px 4px; }
.twin-list { display: flex; flex-direction: column; gap: 8px; max-height: 40vh; overflow: hidden auto; }
.twin-card { padding: 7px 8px; background: var(--paper-raised); border: 1px solid var(--line); border-radius: var(--radius-panel-sm); }
.twin-row { display: flex; gap: 6px; align-items: center; }
.twin-state-dot { width: 8px; height: 8px; border-radius: 50%; }
.twin-name { font-size: 11px; font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.twin-state { margin-left: auto; font-size: 10px; color: var(--ink-soft); }
.twin-tele { display: flex; flex-wrap: wrap; gap: 4px 8px; margin: 5px 0; font-size: 10px; color: var(--ink-faint); }
.tele-item b { color: var(--ink); font-family: var(--font-mono); }
.twin-ctrl { display: flex; gap: 4px; align-items: center; }
.ctrl-btn { padding: 2px 7px; font-size: 10px; font-weight: 600; color: var(--ink-soft); background: var(--paper-deep); border: 1px solid var(--line); border-radius: var(--radius-chip); cursor: pointer; }
.ctrl-btn:disabled { opacity: 0.5; cursor: default; }
.ctrl-input { width: 44px; font-size: 10px; padding: 2px 4px; border: 1px solid var(--line); border-radius: var(--radius-chip); background: var(--paper); color: var(--ink); }
.twin-err { font-size: 10px; color: var(--tone-danger-dot); }
</style>
