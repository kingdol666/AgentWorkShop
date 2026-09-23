<script setup lang="ts">
/**
 * 添加节点向导 —— mock 模拟 / 真实设备(协议参数 + 测试连接)。
 * 表单是页面 useDaqAddNode 持有的同一个 reactive 对象(经 v-model 传入并就地读写,
 * 与拆分前的模板写法一致;字段数组由页面把 addFields 注入同一对象),
 * 组件只负责呈现。
 */
import type { DaqDriverCatalogEntry, DaqTemplateDef, DriverConfigField, DriverTestResult as DaqDriverTestResult } from '#shared/daq-protocol'

/** 表单模型 = useDaqAddNode 的表单对象 + 页面注入的驱动参数字段 */
export interface DaqAddNodeFormModel {
  scenario: 'mock' | 'real'
  template: string
  driver: string
  name: string
  interval: number | null
  cfg: Record<string, string | number>
  transform: { kind: 'none' | 'linear', scale: number, offset: number }
  testing: boolean
  test: DaqDriverTestResult | null
  saving: boolean
  error: string
  fields: DriverConfigField[]
}

defineProps<{
  templates: DaqTemplateDef[]
  driverCatalog: DaqDriverCatalogEntry[]
  driverReady: (kind: string) => boolean
}>()

const emit = defineEmits<{
  test: []
  submit: []
  close: []
}>()

const open = defineModel<boolean>('open', { required: true })
const form = defineModel<DaqAddNodeFormModel>('form', { required: true })
</script>

<template>
  <div
    v-if="open"
    class="modal-mask"
    @click.self="emit('close')"
  >
    <div class="modal">
      <h3 class="m-title">
        {{ $t('daq.k19rioqa024') }}
      </h3>

      <div class="seg-row">
        <button
          class="seg"
          :class="{ on: form.scenario === 'mock' }"
          @click="form.scenario = 'mock'"
        >
          {{ $t('daq.k1p5c1un025') }}
        </button>
        <button
          class="seg"
          :class="{ on: form.scenario === 'real' }"
          @click="form.scenario = 'real'"
        >
          {{ $t('daq.k1cbcp3o026') }}
        </button>
      </div>

      <div class="f-grid">
        <label class="f">
          <span>{{ $t('daq.k1fsgerc027') }}</span>
          <select
            v-model="form.template"
            class="inp"
          >
            <option
              v-for="t in templates"
              :key="t.key"
              :value="t.key"
            >
              {{ t.name }} · {{ t.ch }}({{ t.min }}~{{ t.max }} {{ t.unit }}){{ t.builtin ? '' : $t('daq.kr45rk9097') }}
            </option>
          </select>
        </label>
        <label class="f">
          <span>{{ $t('daq.k1ce2k1y028') }}</span>
          <input
            v-model="form.name"
            class="inp"
            :placeholder="$t('daq.kgpxzy3005')"
          >
        </label>
        <label
          v-if="form.scenario === 'real'"
          class="f"
        >
          <span>{{ $t('daq.k13mfsfc029') }}</span>
          <input
            v-model.number="form.interval"
            type="number"
            min="1000"
            max="60000"
            step="500"
            class="inp"
            :placeholder="$t('daq.k1eg1000a136')"
          >
        </label>
      </div>

      <!-- 真实场景:协议选择 + 动态参数表单 + 测试连接 -->
      <template v-if="form.scenario === 'real'">
        <div class="f-grid">
          <label class="f">
            <span>{{ $t('daq.k1kt87rx030') }}</span>
            <select
              v-model="form.driver"
              class="inp"
            >
              <option
                v-for="d in driverCatalog.filter(x => x.status !== 'planned')"
                :key="d.kind"
                :value="d.kind"
              >
                {{ d.label }}{{ d.plugin ? ' ⌁' : '' }}{{ driverReady(d.kind) ? '' : $t('daq.kjbqphp098') }}
              </option>
            </select>
          </label>
        </div>

        <div
          v-if="form.fields.length"
          class="f-grid driver-form"
        >
          <label
            v-for="f in form.fields"
            :key="f.key"
            class="f"
          >
            <span>{{ f.label }}<em v-if="f.required">*</em></span>
            <select
              v-if="f.type === 'select'"
              v-model="form.cfg[f.key]"
              class="inp"
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
              v-model="form.cfg[f.key]"
              :type="f.type === 'number' ? 'number' : 'text'"
              :placeholder="f.placeholder"
              class="inp"
            >
            <small
              v-if="f.hint"
              class="hint"
            >{{ f.hint }}</small>
          </label>
        </div>

        <div class="test-row">
          <button
            class="pill-btn"
            :disabled="form.testing"
            @click="emit('test')"
          >
            {{ form.testing ? $t('daq.k1fsh720099') : $t('daq.k1fstglk112') }}
          </button>
          <span
            v-if="form.test"
            class="test-result"
            :class="form.test.ok ? 'ok' : 'bad'"
          >{{ form.test.ok ? '✓' : '✗' }} {{ form.test.message }}<template v-if="form.test.latencyMs != null">({{ form.test.latencyMs }}ms)</template></span>
        </div>
      </template>

      <p
        v-if="form.error"
        class="m-err"
      >
        {{ form.error }}
      </p>

      <div class="m-actions">
        <button
          class="aw-pill outline"
          @click="emit('close')"
        >
          {{ $t('daq.k3xdnn031') }}
        </button>
        <button
          class="aw-pill"
          :disabled="form.saving || (form.scenario === 'real' && form.test != null && !form.test.ok)"
          :title="form.scenario === 'real' && !(form.test && form.test.ok) ? $t('daq.k1needtst137') : ''"
          @click="emit('submit')"
        >
          {{ form.saving ? $t('daq.k1bg4759100') : (form.scenario === 'real' ? $t('daq.k7pxjxo113') : $t('daq.k1bge46t118')) }}
        </button>
      </div>
    </div>
  </div>
</template>
