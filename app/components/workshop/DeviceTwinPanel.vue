<script setup lang="ts">
/**
 * 设备控制台(Device Twin Console) —— 工业数字孪生 HMI:
 * 设备实体直接列表展示(状态灯/遥测数据网格/下发控制),点击行聚焦小镇场景中的对应实体。
 *
 * 与 3D 小镇联动:拖 `dev` 模型进场景会创建设备 twin;本面板实时刷新其 state/telemetry,
 * 并展示绑定智控通道的当前 set 值,支持窗口内直写下发(替代旧 power_on/power_off/set_speed)。
 *
 * 本组件只做编排(容器):列表/轮询/行内删除来自 useDeviceTwinPanel,
 * 智控写入态来自 useDeviceTwinDcwWrite(整面板一份,provide 给子树),
 * 单行渲染交 DeviceTwinCard、智控通道渲染交 DeviceTwinDcwSection;
 * 样式仅为本组件模板专属规则(各子组件样式随各自标记搬移)。
 */
import DeviceTwinCard from './device-twin/DeviceTwinCard.vue'
import { provideDeviceTwinDcwWrite } from '@/app/composables/workshop/useDeviceTwinDcwWrite'
import { useDeviceTwinPanel } from '@/app/composables/workshop/useDeviceTwinPanel'
import type { DaqLiveRow, DcwLiveRow } from '@/app/composables/workshop/device-twin-types'

export type { DcwLiveRow } from '@/app/composables/workshop/device-twin-types'

defineProps<{
  daqLive?: Record<string, DaqLiveRow[]>
  dcwLive?: Record<string, DcwLiveRow[]>
}>()

defineEmits<{ (e: 'focus-device', twin: { id: string, posX?: number, posZ?: number }): void }>()

const { twins, busyId, ctrlMsg, armedId, removeTwin } = useDeviceTwinPanel()
// 智控写入态(草稿/错误/busy)整面板一份:草稿与错误按智控节点 id 键控、busy 单值,
// 与拆分前同一份语义 —— 经 provide 交给智控通道区,不按卡片复制状态。
provideDeviceTwinDcwWrite()
</script>

<template>
  <aside class="twin-panel">
    <div class="twin-head">
      <span class="twin-kicker">{{ $t('deviceTwinPanel.k7k6evr002') }}</span>
      <span class="twin-count">{{ twins.twins.length }}</span>
    </div>

    <!-- 加载失败横幅:错误可见,旧数据保留不清空 -->
    <div
      v-if="twins.error"
      class="twin-error"
    >
      {{ twins.error }}
    </div>

    <div
      v-if="!twins.loaded"
      class="twin-empty"
    >
      {{ $t('deviceTwinPanel.kkw7sn5003') }}
    </div>
    <div
      v-else-if="twins.twins.length === 0"
      class="twin-empty"
    >
      <div class="twin-empty-frame">
        <div class="twin-empty-title">
          {{ $t('deviceTwinPanel.k13y2qmg004') }}
        </div>
        <div class="twin-empty-sub">
          {{ $t('deviceTwinPanel.kotf23l005') }}
        </div>
      </div>
    </div>
    <div
      v-else
      class="twin-list"
    >
      <DeviceTwinCard
        v-for="tw in twins.twins"
        :key="tw.id"
        :twin="tw"
        :daq-rows="daqLive?.[tw.id]"
        :dcw-rows="dcwLive?.[tw.id]"
        :armed="armedId === tw.id"
        :busy="busyId === tw.id"
        @focus="$emit('focus-device', tw)"
        @remove="removeTwin(tw)"
      />
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
/* 加载失败横幅:错误可见(旧数据保留,不再静默清空) */
.twin-error {
  padding: 7px 10px;
  font-size: 11px;
  line-height: 1.5;
  color: #ffb4b4;
  background: rgba(255, 107, 107, 0.1);
  border: 1px solid rgba(255, 107, 107, 0.35);
  border-radius: 8px;
  word-break: break-all;
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
.twin-err { font-size: 9.5px; color: var(--hud-danger); padding: 0 10px 8px; }
</style>
