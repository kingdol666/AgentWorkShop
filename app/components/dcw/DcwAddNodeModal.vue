<script setup lang="ts">
/**
 * 添加控制节点向导 —— mock / 真实设备(协议参数 schema 动态表单 + 测试连接 + 数据语义标定)。
 * 向导各字段由页面 useDcwAddNode 独占持有,经 v-model 就地读写(与原模板写法一致);
 * 组件只负责呈现,测试/提交回抛页面。
 */
import type { DcwTemplateDef } from '#shared/dcw-protocol'
import type { DaqDriverCatalogEntry, DriverConfigField } from '#shared/daq-protocol'

defineProps<{
  templates: DcwTemplateDef[]
  driverCatalog: DaqDriverCatalogEntry[]
  addFields: DriverConfigField[]
  addTesting: boolean
  addTest: { ok: boolean, message: string } | null
  addSaving: boolean
  addError: string
}>()

const emit = defineEmits<{ test: [], submit: [] }>()

const { t } = useI18n()

const addOpen = defineModel<boolean>('open', { required: true })
const addScenario = defineModel<'mock' | 'real'>('scenario', { required: true })
const addTemplate = defineModel<string>('template', { required: true })
const addDriver = defineModel<'mock' | 'modbus-tcp' | 'opcua'>('driver', { required: true })
const addName = defineModel<string>('name', { required: true })
const addHold = defineModel<number | null>('hold', { required: true })
const addRead = defineModel<number | null>('read', { required: true })
const addWriteLock = defineModel<number>('writeLock', { required: true })
const addCfg = defineModel<Record<string, string | number>>('cfg', { required: true })
const addTransform = defineModel<{ kind: 'none' | 'linear', scale: number, offset: number }>('transform', { required: true })
const addSemantics = defineModel<string>('semantics', { required: true })
</script>

<template>
  <div
    v-if="addOpen"
    class="modal-mask"
    @click.self="addOpen = false"
  >
    <div class="modal">
      <h3 class="m-title">
        {{ $t('dcwDetail.k1976uns021') }}
      </h3>

      <div class="seg-row">
        <button
          class="seg"
          :class="{ on: addScenario === 'mock' }"
          @click="addScenario = 'mock'"
        >
          {{ $t('dcwDetail.mockPlc') }}
        </button>
        <button
          class="seg"
          :class="{ on: addScenario === 'real' }"
          @click="addScenario = 'real'"
        >
          {{ $t('dcwDetail.kyj8fen044') }}
        </button>
      </div>

      <div class="f-grid">
        <label class="f">
          <span>{{ $t('dcwDetail.k1ejzwqp045') }}</span>
          <select
            v-model="addTemplate"
            class="inp"
          >
            <option
              v-for="tpl in templates"
              :key="tpl.key"
              :value="tpl.key"
            >
              {{ catalogTplName(t, tpl) }} · {{ tpl.ch }}({{ tpl.min }}~{{ tpl.max }} {{ tpl.unit }}){{ tpl.builtin ? '' : $t('dcwDetail.kr45rk9157') }}
            </option>
          </select>
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k1ce2k1y046') }}</span>
          <input
            v-model="addName"
            class="inp"
            :placeholder="$t('dcwDetail.kgpxzy3009')"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k1vyb8im047') }}</span>
          <input
            v-model.number="addHold"
            type="number"
            min="0"
            max="3600000"
            step="500"
            class="inp"
            :placeholder="$t('dcwDetail.kb1srz0010')"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k9r7d4e016') }}</span>
          <input
            v-model.number="addRead"
            type="number"
            min="0"
            max="3600000"
            step="500"
            class="inp"
            :placeholder="$t('dcwDetail.k9r7d4e017')"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.writeLockLabel') }}</span>
          <input
            v-model.number="addWriteLock"
            type="number"
            min="0"
            max="3600"
            step="1"
            class="inp"
            :placeholder="$t('dcwDetail.writeLockHint')"
          >
        </label>
      </div>

      <!-- 数据语义标定 encode(物理设定值 → PLC 设定值;mock/真实均可用) -->
      <div class="f-grid cal-form">
        <label class="f">
          <span>{{ $t('dcwDetail.kiune1f048') }}</span>
          <select
            v-model="addTransform.kind"
            class="inp"
          >
            <option value="none">
              {{ $t('dcwDetail.kkzy0k049') }}
            </option>
            <option value="linear">
              {{ $t('dcwDetail.linearCalOpt') }}
            </option>
          </select>
        </label>
        <label class="f">
          <span>scale / offset</span>
          <div style="display: flex; gap: 6px;">
            <input
              v-model.number="addTransform.scale"
              type="number"
              step="0.1"
              class="inp"
              :disabled="addTransform.kind !== 'linear'"
              :title="$t('dcwDetail.calScaleTip')"
            >
            <input
              v-model.number="addTransform.offset"
              type="number"
              step="0.1"
              class="inp"
              :disabled="addTransform.kind !== 'linear'"
              :title="$t('dcwDetail.calOffsetTip')"
            >
          </div>
        </label>
      </div>

      <template v-if="addScenario === 'real'">
        <div class="f-grid">
          <label class="f">
            <span>{{ $t('dcwDetail.k1kt87rx050') }}</span>
            <select
              v-model="addDriver"
              class="inp"
            >
              <option
                v-for="d in driverCatalog.filter(x => x.status !== 'builtin')"
                :key="d.kind"
                :value="d.kind"
              >
                {{ d.label }}{{ d.plugin ? ' ⌁' : '' }}
              </option>
            </select>
          </label>
        </div>
        <div
          v-if="addFields.length"
          class="f-grid driver-form"
        >
          <label
            v-for="f in addFields"
            :key="f.key"
            class="f"
          >
            <span>{{ f.label }}<em
              v-if="f.required"
              style="color: var(--tone-danger-dot); font-style: normal;"
            >*</em></span>
            <select
              v-if="f.type === 'select'"
              v-model="addCfg[f.key]"
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
              v-model="addCfg[f.key]"
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
            class="pill-btn outline"
            :disabled="addTesting"
            @click="emit('test')"
          >
            {{ addTesting ? $t('dcwDetail.k1fsh720158') : $t('dcwDetail.k1fstglk172') }}
          </button>
          <span
            v-if="addTest"
            class="test-result"
            :class="addTest.ok ? 'good' : 'bad'"
          >{{ addTest.ok ? '✓' : '✗' }} {{ addTest.message }}</span>
        </div>
      </template>

      <label class="f">
        <span>{{ $t('dcwDetail.k1hgizn7051') }}</span>
        <textarea
          v-model="addSemantics"
          class="inp"
          rows="2"
          :placeholder="$t('dcwDetail.k12bnyt9011')"
        />
      </label>

      <p
        v-if="addError"
        class="m-err"
      >
        {{ addError }}
      </p>

      <div class="m-actions">
        <button
          class="aw-pill outline"
          @click="addOpen = false"
        >
          {{ $t('dcwDetail.k3xdnn052') }}
        </button>
        <button
          class="aw-pill"
          :disabled="addSaving"
          @click="emit('submit')"
        >
          {{ addSaving ? $t('dcwDetail.k1bg4759156') : $t('dcwDetail.k1bge46t173') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/.modal-mask/.banner/.nodes-table/.sec-label/.st-pill 等)
   在此各持一份逐字相同的副本,以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */

.inp { padding: 5px 9px; font-size: 12.5px; color: var(--ink); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); }

.cal-form { grid-template-columns: 2fr 1fr; align-items: end; }

.modal-mask { position: fixed; z-index: 50; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--scrim); backdrop-filter: blur(2px); }
.modal { width: 680px; max-width: 94vw; max-height: 88vh; overflow-y: auto; padding: 22px 24px; background: var(--surface-glass-strong); backdrop-filter: var(--aurora-blur); border: 1px solid var(--glass-line); border-radius: var(--radius-panel); box-shadow: var(--glass-edge), var(--shadow-float); }
.m-title { margin: 0 0 14px; font-size: 17px; }
.seg-row { display: flex; gap: 8px; margin-bottom: 14px; }
.seg { flex: 1; padding: 8px 0; font-size: 13px; cursor: pointer; color: var(--ink-faint); background: var(--paper-deep); border: 1px solid var(--line); border-radius: var(--radius-chip); }
.seg.on { font-weight: 600; color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.f-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
.driver-form { grid-template-columns: repeat(3, 1fr); }

.f { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-faint); }
.f em { margin-left: 3px; font-style: normal; }
.hint { font-size: 11.5px; color: var(--ink-faint); }
.test-row { display: flex; gap: 10px; align-items: center; margin: 6px 0 4px; }
.test-result { font-family: var(--font-mono); font-size: 11px; }
.test-result.good { color: var(--tone-success-dot); }
.test-result.bad { color: var(--tone-danger-dot); }
.m-err { margin: 8px 0 0; font-size: 12px; color: var(--tone-danger-dot); }

.m-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.aw-pill.outline { color: var(--ink); background: var(--paper-raised); border-color: var(--line-strong); }

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖,≤640 单列)════════════════════════════
   375px 下本页的三类实测缺陷:网关总控条右侧三件套不换行(整块顶出画布)、
   运行控制行的两个 150px 选择器 + 按钮并排超宽、微标签 9~10.5px。 */
  /* 触摸目标:手持命中区 ≥40px(main.css 只在 pointer:coarse 下兜底) */
  .pill-btn,
  .aw-pill,
  .inp {
    min-height: 40px;
  }
  /* 弹窗表单:两列/三列在窄屏一律落成一列,否则标签被压成竖排字 */
  .f-grid { grid-template-columns: 1fr; }
  .driver-form { grid-template-columns: 1fr; }
  .cal-form { grid-template-columns: 1fr; }
  .modal {
    width: calc(100vw - 20px);
    max-width: calc(100vw - 20px);
    padding: 16px 14px;
  }
  .seg { padding: 10px 0; min-height: 40px; }
  .m-actions { flex-wrap: wrap; }
  .m-actions > * { flex: 1 1 auto; }
}
</style>
