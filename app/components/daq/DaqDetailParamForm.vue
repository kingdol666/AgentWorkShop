<script setup lang="ts">
/**
 * 参数控制 —— 单点参数(启停/产线/驱动/周期/WS 下发节拍/标定/量程/预警带)
 * + 驱动连接参数 schema 动态表单 + 测试连接 + 设备绑定。
 * 表单对象由页面 useDaqDetailParams 独占持有(经 v-model 就地读写同一 reactive 对象),
 * 本组件只负责呈现;绑定下拉是纯 UI 态(同样经 v-model)。
 */
import type { LineView } from '#shared/dcw-protocol'
import type { DaqDriverCatalogEntry, DriverConfigField, DriverTestResult as DaqDriverTestResult } from '#shared/daq-protocol'
import type { DaqDetailParamForm } from '../../pages/daq/composables/useDaqDetailParams'

defineProps<{
  lines: LineView[]
  driverCatalog: DaqDriverCatalogEntry[]
  driverFields: DriverConfigField[]
  saving: boolean
  testing: boolean
  testResult: DaqDriverTestResult | null
  boundDeviceName: string
  availableDevices: Array<{ id: string, name: string }>
}>()

const emit = defineEmits<{
  'save': []
  'test': []
  'bind-toggle': []
}>()

/** 表单模型 = useDaqDetailParams 持有的同一个 reactive 对象 */
const form = defineModel<DaqDetailParamForm>('form', { required: true })
/** 驱动连接参数(与 useDaqDetailParams 的 driverCfg 同一个对象,就地读写) */
const driverCfg = defineModel<Record<string, string | number>>('driverCfg', { required: true })
/** 换绑下拉选择(纯 UI 态;换绑/解绑动作回抛页面) */
const bindDeviceId = defineModel<string>('bindDeviceId', { required: true })
</script>

<template>
  <section class="col-form aw-tile pad">
    <h3 class="sec">
      {{ $t('daqDetail.kd9d69j009') }}
    </h3>
    <form
      class="form-grid"
      @submit.prevent="emit('save')"
    >
      <label class="field">
        <span>{{ $t('daqDetail.k1iw7tbf010') }}</span>
        <button
          type="button"
          class="toggle"
          :class="{ on: form.enabled }"
          @click="form.enabled = !form.enabled"
        >
          {{ form.enabled ? $t('daqDetail.k3w3j8f037') : $t('daqDetail.k3n5aaj045') }}
        </button>
      </label>
      <label class="field">
        <span>{{ $t('daqDetail.k12k23od011') }}</span>
        <select
          v-model="form.lineId"
          class="input"
        >
          <option value="">
            {{ $t('daqDetail.k3ootr6012') }}
          </option>
          <option
            v-for="l in lines"
            :key="l.id"
            :value="l.id"
          >
            {{ l.name }}
          </option>
        </select>
      </label>
      <label class="field">
        <span>{{ $t('daqDetail.k1l6smxo013') }}</span>
        <select
          v-model="form.driver"
          class="input"
        >
          <option
            v-for="d in driverCatalog"
            :key="d.kind"
            :value="d.kind"
            :disabled="d.status === 'planned'"
          >
            {{ d.label }}{{ d.plugin ? ' ⌁' : '' }}{{ d.status === 'planned' ? $t('daqDetail.kz8zr9v035') : '' }}
          </option>
        </select>
      </label>
      <label class="field row">
        <button
          type="button"
          class="toggle slim"
          :class="{ on: form.followGlobal }"
          @click="form.followGlobal = !form.followGlobal"
        >
          {{ form.followGlobal ? $t('daqDetail.k1k2ueyq038') : $t('daqDetail.k1cgi8fy046') }}
        </button>
        <input
          v-model.number="form.intervalMs"
          type="number"
          min="1000"
          max="60000"
          step="500"
          class="input"
          :disabled="form.followGlobal"
        ><small>ms</small>
      </label>
      <label class="field row">
        <button
          type="button"
          class="toggle slim"
          :class="{ on: form.calKind === 'linear' }"
          :title="$t('daqDetail.calDecoderTip')"
          @click="form.calKind = form.calKind === 'linear' ? 'none' : 'linear'"
        >
          {{ form.calKind === 'linear' ? $t('daqDetail.k1eru4r1039') : $t('daqDetail.k3oktae047') }}
        </button>
        <input
          v-model.number="form.calScale"
          type="number"
          step="0.1"
          class="input"
          :disabled="form.calKind !== 'linear'"
          :title="$t('daqDetail.calScaleTip')"
        >
        <input
          v-model.number="form.calOffset"
          type="number"
          step="0.1"
          class="input"
          :disabled="form.calKind !== 'linear'"
          :title="$t('daqDetail.calOffsetTip')"
        ><small>decoder</small>
      </label>
      <label class="field row">
        <button
          type="button"
          class="toggle slim"
          :class="{ on: form.publishFollow }"
          @click="form.publishFollow = !form.publishFollow"
        >
          {{ form.publishFollow ? $t('daqDetail.k1k2t5o7040') : $t('daqDetail.k1cggz5f048') }}
        </button>
        <span
          class="toggle slim"
          :class="{ on: form.publishEveryFrame }"
          style="cursor: pointer;"
          @click="form.publishEveryFrame = !form.publishEveryFrame"
        >{{ form.publishEveryFrame ? $t('daqDetail.k41mvv041') : $t('daqDetail.k3n42dj049') }}</span>
        <input
          v-model.number="form.publishMs"
          type="number"
          min="0"
          max="60000"
          step="100"
          class="input"
          :disabled="form.publishFollow || form.publishEveryFrame"
        ><small>ms</small>
      </label>
      <label class="field">
        <span>{{ $t('daqDetail.k3x4ef014') }}</span>
        <input
          v-model="form.unit"
          class="input"
        >
      </label>
      <label class="field">
        <span>{{ $t('daqDetail.k3mxmcx015') }}</span>
        <input
          v-model.number="form.decimals"
          type="number"
          min="0"
          max="6"
          class="input"
        >
      </label>
      <div class="field-row">
        <label class="field">
          <span>{{ $t('daqDetail.k1l9jv5m016') }}</span>
          <input
            v-model.number="form.min"
            type="number"
            step="any"
            class="input"
          >
        </label>
        <label class="field">
          <span>{{ $t('daqDetail.k1md63hm017') }}</span>
          <input
            v-model.number="form.warnLow"
            type="number"
            step="any"
            class="input"
          >
        </label>
        <label class="field">
          <span>{{ $t('daqDetail.k1md63gp018') }}</span>
          <input
            v-model.number="form.warnHigh"
            type="number"
            step="any"
            class="input"
          >
        </label>
        <label class="field">
          <span>{{ $t('daqDetail.k1l9jv4p019') }}</span>
          <input
            v-model.number="form.max"
            type="number"
            step="any"
            class="input"
          >
        </label>
      </div>
      <button
        class="aw-pill"
        type="submit"
        :disabled="saving"
      >
        {{ saving ? $t('daqDetail.k1as0g50042') : $t('daqDetail.ksn9cgo050') }}
      </button>
    </form>

    <!-- 驱动连接参数(mock 空;真实协议 schema 动态表单 + 测试连接) -->
    <template v-if="driverFields.length">
      <h3 class="sec mt">
        {{ $t('daqDetail.k1p9gioa033') }} {{ driverCatalog.find(d => d.kind === form.driver)?.label }}
      </h3>
      <div class="driver-grid">
        <label
          v-for="f in driverFields"
          :key="f.key"
          class="field"
        >
          <span>{{ f.label }}<em v-if="f.required">*</em></span>
          <select
            v-if="f.type === 'select'"
            v-model="driverCfg[f.key]"
            class="input"
          >
            <option
              v-for="o in f.options"
              :key="o.value"
              :value="o.value"
            >
              {{ o.label }}
            </option>
          </select>
          <input
            v-else
            v-model="driverCfg[f.key]"
            :type="f.type === 'number' ? 'number' : 'text'"
            :placeholder="f.placeholder"
            class="input"
          >
        </label>
      </div>
      <div class="test-row">
        <button
          class="pill-btn"
          :disabled="testing"
          @click="emit('test')"
        >
          {{ testing ? $t('daqDetail.k1fsh720043') : $t('daqDetail.k1fstglk051') }}
        </button>
        <span
          v-if="testResult"
          class="test-out mono"
          :class="testResult.ok ? 'ok' : 'bad'"
        >{{ testResult.ok ? '✓' : '✗' }} {{ testResult.message }}</span>
      </div>
    </template>

    <h3 class="sec mt">
      {{ $t('daqDetail.k1ie6qju020') }}
    </h3>
    <div class="bind-row">
      <select
        v-model="bindDeviceId"
        class="input grow"
      >
        <option value="">
          {{ $t('daqDetail.kjobzu3021') }}
        </option>
        <option
          v-for="dv in availableDevices"
          :key="dv.id"
          :value="dv.id"
        >
          {{ dv.name }}
        </option>
      </select>
      <button
        class="pill-btn"
        @click="emit('bind-toggle')"
      >
        {{ boundDeviceName ? $t('daqDetail.k479eh044') : $t('daqDetail.k452a8052') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.sec/.pad/.input/.hist-hd/.raw-table)在此各持一份逐字相同的副本,
   以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.sec { margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); }
.mt { margin-top: 22px; }
.pad { padding: 16px 18px; }

/* 参数表单 */
.form-grid { display: flex; flex-direction: column; gap: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-faint); flex: 1; }
.field.row { flex-direction: row; align-items: center; gap: 8px; }
.field.row small { color: var(--ink-faint); }
.field-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.input {
  width: 100%;
  padding: 6px 9px;
  font-size: 12.5px;
  color: var(--ink);
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}
.input:disabled { opacity: 0.45; }
.grow { flex: 1 1 auto; }
.toggle {
  align-self: flex-start;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  color: var(--tone-neutral-dot);
  background: var(--tone-neutral-bg);
  border: 0;
  border-radius: var(--radius-chip);
}
.toggle.on { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.toggle.slim { padding: 6px 10px; font-size: 11.5px; }
.bind-row { display: flex; gap: 8px; }
.driver-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.field em { margin-left: 2px; font-style: normal; color: var(--tone-danger-dot); }
.test-row { display: flex; gap: 10px; align-items: center; margin-top: 8px; }
.test-out { font-size: 11px; }
.test-out.ok { color: var(--tone-success-dot); }
.test-out.bad { color: var(--tone-danger-dot); }
</style>
