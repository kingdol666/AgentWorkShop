<script setup lang="ts">
/**
 * 添加控制节点模板(本页内自定义创建)—— server 权威目录清单 + 自定义模板表单。
 * 表单对象由页面 useDcwDetailTemplates 独占持有(经 v-model 就地读写同一 reactive 对象)。
 */
import type { DcwTemplateDef, DcwTemplateIcon } from '#shared/dcw-protocol'
import type { DcwTemplateForm } from '../../pages/dcw/composables/useDcwDetailTemplates'

defineProps<{
  templates: DcwTemplateDef[]
  tplIcons: Array<{ key: DcwTemplateIcon, label: string }>
  builtinCount: number
  customCount: number
  tplSaving: boolean
  tplError: string
  tplOk: string
}>()

const emit = defineEmits<{ submit: [], close: [] }>()

const { t } = useI18n()

const tplOpen = defineModel<boolean>('open', { required: true })
const tplForm = defineModel<DcwTemplateForm>('form', { required: true })
</script>

<template>
  <div
    v-if="tplOpen"
    class="modal-mask"
    @click.self="tplOpen = false"
  >
    <div class="modal">
      <h3 class="m-title">
        {{ $t('dcwDetail.k1x4vam0031') }} <small class="dim mono">{{ $t('dcwDetail.k3x23c141') }} {{ builtinCount }} · {{ $t('dcwDetail.k3t616a142') }} {{ customCount }}</small>
      </h3>
      <p class="dim tpl-hint">
        {{ $t('dcwDetail.ke1iyud032') }}
      </p>

      <div class="tpl-chips">
        <span
          v-for="tpl in templates"
          :key="tpl.key"
          class="tpl-chip"
          :title="`${tpl.code} · ${tpl.min}~${tpl.max} ${tpl.unit}${tpl.semantics ? ` · ${tpl.semantics}` : ''}`"
        >
          {{ catalogTplName(t, tpl) }} <small class="mono">{{ tpl.min }}~{{ tpl.max }}{{ tpl.unit }}</small>
          <em
            class="tpl-tag"
            :class="{ builtin: tpl.builtin }"
          >{{ tpl.builtin ? $t('dcwDetail.k3x23c141') : $t('dcwDetail.k3t616a142') }}</em>
        </span>
      </div>

      <p class="sec-label">
        {{ $t('dcwDetail.k169eb4s033') }}
      </p>
      <div class="f-grid tpl-form">
        <label class="f">
          <span>{{ $t('dcwDetail.k1f55q76034') }}<em>*</em></span>
          <input
            v-model="tplForm.name"
            class="inp"
            :placeholder="$t('dcwDetail.k1tooi3o004')"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k1bqk219035') }}</span>
          <input
            v-model="tplForm.ch"
            class="inp"
            :placeholder="$t('dcwDetail.k698qz0005')"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k1ayxrqb036') }}</span>
          <input
            v-model="tplForm.code"
            class="inp"
            :placeholder="$t('dcwDetail.codePh')"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k3x4ef037') }}<em>*</em></span>
          <input
            v-model="tplForm.unit"
            class="inp"
            :placeholder="$t('dcwDetail.unitPh')"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k1l9jv5m038') }}<em>*</em></span>
          <input
            v-model.number="tplForm.min"
            type="number"
            class="inp"
            :placeholder="$t('dcwDetail.kxz9174006')"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k1l9jv4p039') }}<em>*</em></span>
          <input
            v-model.number="tplForm.max"
            type="number"
            class="inp"
            :placeholder="$t('dcwDetail.kxz9167007')"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k3mxmcx040') }}</span>
          <input
            v-model.number="tplForm.decimals"
            type="number"
            min="0"
            max="4"
            class="inp"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k3xx56041') }}</span>
          <select
            v-model="tplForm.icon"
            class="inp"
          >
            <option
              v-for="ic in tplIcons"
              :key="ic.key"
              :value="ic.key"
            >
              {{ ic.label }}
            </option>
          </select>
        </label>
      </div>
      <label class="f">
        <span>{{ $t('dcwDetail.knjmyfr042') }}</span>
        <textarea
          v-model="tplForm.semantics"
          class="inp"
          rows="2"
          :placeholder="$t('dcwDetail.k1qdnfzc008')"
        />
      </label>

      <p
        v-if="tplOk"
        class="banner good"
        style="margin-top: 10px;"
      >
        {{ tplOk }}
      </p>
      <p
        v-if="tplError"
        class="m-err"
      >
        {{ tplError }}
      </p>
      <div class="m-actions">
        <button
          class="aw-pill outline"
          @click="tplOpen = false"
        >
          {{ $t('dcwDetail.k3x62t043') }}
        </button>
        <button
          class="pill-btn"
          :disabled="tplSaving || !tplForm.name.trim() || tplForm.unit.trim() === '' || tplForm.min === '' || tplForm.max === ''"
          @click="emit('submit')"
        >
          {{ tplSaving ? $t('dcwDetail.k1bg4759156') : $t('dcwDetail.k1bg9nga171') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/.modal-mask/.banner/.nodes-table/.sec-label/.st-pill 等)
   在此各持一份逐字相同的副本,以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */

.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.dim { opacity: 0.55; }

.banner { padding: 9px 14px; margin: 0 0 12px; font-size: 12.5px; border-radius: var(--radius-chip); }
.banner.bad { color: var(--tone-danger-dot); background: var(--tone-danger-bg); border: 1px solid color-mix(in srgb, var(--tone-danger-dot) 40%, transparent); }
.banner.good { color: var(--tone-success-dot); background: var(--tone-success-bg); border: 1px solid color-mix(in srgb, var(--tone-success-dot) 40%, transparent); }

/* 模板弹窗 */
.tpl-hint { margin: 0 0 10px; font-size: 12px; }

.tpl-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
.tpl-chip { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 3px 9px; font-size: 11.5px; color: var(--ink-soft); background: var(--paper-deep); border: 1px solid var(--line); border-radius: var(--radius-chip); }
.tpl-chip small { color: var(--ink-faint); }
.tpl-tag { padding: 1px 6px; font-size: 11.5px; font-style: normal; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); border-radius: var(--radius-pill); }
.tpl-tag.builtin { color: var(--ink-faint); border-color: var(--line-strong); }

.inp { padding: 5px 9px; font-size: 12.5px; color: var(--ink); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); }

.sec-label { margin: 14px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); }

.modal-mask { position: fixed; z-index: 50; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--scrim); backdrop-filter: blur(2px); }
.modal { width: 680px; max-width: 94vw; max-height: 88vh; overflow-y: auto; padding: 22px 24px; background: var(--surface-glass-strong); backdrop-filter: var(--aurora-blur); border: 1px solid var(--glass-line); border-radius: var(--radius-panel); box-shadow: var(--glass-edge), var(--shadow-float); }
.m-title { margin: 0 0 14px; font-size: 17px; }

.f-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }

.f { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-faint); }
.f em { margin-left: 3px; font-style: normal; }

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
  .inp,
  .tpl-chip {
    min-height: 40px;
  }
  /* 弹窗表单:两列/三列在窄屏一律落成一列,否则标签被压成竖排字 */
  .f-grid { grid-template-columns: 1fr; }
  .modal {
    width: calc(100vw - 20px);
    max-width: calc(100vw - 20px);
    padding: 16px 14px;
  }
  .m-actions { flex-wrap: wrap; }
  .m-actions > * { flex: 1 1 auto; }
}
</style>
