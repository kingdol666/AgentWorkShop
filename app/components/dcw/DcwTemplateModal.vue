<script setup lang="ts">
/**
 * 控制模板管理弹窗 —— server 权威目录,内置只读 / 自定义可删。
 * 打开状态与表单留在组件内(纯 UI 状态),目录写动作走 useDcwTemplates。
 */
import { computed, reactive, watch } from 'vue'
import type { DcwTemplateIcon } from '#shared/dcw-protocol'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import { useDcwTemplates } from '../../pages/dcw/composables/useDcwTemplates'

const dcw = useDcwStream()
const { t } = useI18n()
const { tplError, clearTplError, doCreateTemplate, doRemoveTemplate, builtinCount } = useDcwTemplates()

const open = defineModel<boolean>('open', { required: true })

const form = reactive({
  name: '',
  ch: '',
  code: '',
  unit: '',
  min: '' as number | '',
  max: '' as number | '',
  decimals: 1,
  icon: 'gateway' as DcwTemplateIcon,
  semantics: '',
})

const iconOptions: Array<{ key: DcwTemplateIcon, label: string }> = [
  { key: 'thermo', label: t('dcw.k422b8040') },
  { key: 'pressure', label: t('dcw.k3x6ff041') },
  { key: 'tension', label: t('dcw.k3z9xc042') },
  { key: 'encoder', label: t('dcw.kjb3vhs043') },
  { key: 'camera', label: t('dcw.k47atw044') },
  { key: 'gateway', label: t('dcw.k48c07045') },
]

// 模板名走目录 i18n(稳定 key 翻译,自建回退原文)
const catalogName = (tpl: { key?: string, id?: string, name: string }): string => catalogTplName(t, tpl)

async function submit(): Promise<void> {
  if (!form.name.trim()) {
    tplError.value = t('dcw.k6ugbw2046')
    return
  }
  if (form.min === '' || form.max === '') {
    tplError.value = t('dcw.k13awowo047')
    return
  }
  await doCreateTemplate({
    name: form.name.trim(),
    ch: form.ch.trim() || form.name.trim(),
    code: form.code.trim() || 'CUSTOM',
    unit: form.unit.trim() || '-',
    min: Number(form.min),
    max: Number(form.max),
    decimals: Number(form.decimals) || 0,
    icon: form.icon,
    semantics: form.semantics.trim() || undefined,
  })
  if (tplError.value) return
  form.name = ''
  form.ch = ''
  form.code = ''
  form.unit = ''
  form.min = ''
  form.max = ''
}

const customCount = computed(() => dcw.templates.length - builtinCount.value)

// 打开即清错误(与原 tplOpen = true 时先开弹窗再看错误的时序一致)
watch(open, (v) => {
  if (v) clearTplError()
})
</script>

<template>
  <Transition name="modal">
    <div
      v-if="open"
      class="modal-mask"
      @click.self="open = false"
    >
      <div class="modal wide">
        <h3 class="m-title">
          {{ $t('dcw.k11oadmx024') }} <small class="dim mono">{{ $t('dcw.k3x23c054') }} {{ builtinCount }} · {{ $t('dcw.k3t616a058') }} {{ customCount }}</small>
        </h3>
        <p class="dim tpl-hint">
          {{ $t('dcw.k2hlav5025') }}
        </p>
        <div class="tpl-list">
          <div
            v-for="tpl in dcw.templates"
            :key="tpl.key"
            class="tpl-row"
            :title="tpl.semantics ?? ''"
          >
            <b>{{ catalogName(tpl) }}</b>
            <small class="mono dim">{{ tpl.code }} · {{ tpl.min }}~{{ tpl.max }} {{ tpl.unit }}</small>
            <small
              v-if="tpl.semantics"
              class="tpl-sem"
            >{{ tpl.semantics.slice(0, 40) }}{{ tpl.semantics.length > 40 ? '…' : '' }}</small>
            <span
              class="tpl-tag"
              :class="{ builtin: tpl.builtin }"
            >{{ tpl.builtin ? $t('dcw.k3x23c054') : $t('dcw.k3t616a058') }}</span>
            <button
              v-if="!tpl.builtin"
              class="mini-btn danger"
              @click="doRemoveTemplate(tpl.key)"
            >
              {{ $t('dcw.k3xakp026') }}
            </button>
          </div>
        </div>
        <p class="sec-label">
          {{ $t('dcw.k169eb4s027') }}
        </p>
        <div class="tpl-form">
          <label class="f">
            <span>{{ $t('dcw.k3xhia028') }}<em>*</em></span>
            <input
              v-model="form.name"
              class="inp"
              :placeholder="$t('dcw.k1tooi3o006')"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcw.k1bqk219029') }}</span>
            <input
              v-model="form.ch"
              class="inp"
              :placeholder="$t('dcw.k698qz0007')"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcw.k1ayxrqb030') }}</span>
            <input
              v-model="form.code"
              class="inp"
              :placeholder="$t('dcw.codePh')"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcw.k3x4ef031') }}</span>
            <input
              v-model="form.unit"
              class="inp"
              :placeholder="$t('dcw.unitPh')"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcw.k1l9jv5m032') }}<em>*</em></span>
            <input
              v-model.number="form.min"
              type="number"
              class="inp"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcw.k1l9jv4p033') }}<em>*</em></span>
            <input
              v-model.number="form.max"
              type="number"
              class="inp"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcw.k3mxmcx034') }}</span>
            <input
              v-model.number="form.decimals"
              type="number"
              class="inp"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcw.k3xx56035') }}</span>
            <select
              v-model="form.icon"
              class="inp"
            >
              <option
                v-for="ic in iconOptions"
                :key="ic.key"
                :value="ic.key"
              >
                {{ ic.label }}
              </option>
            </select>
          </label>
        </div>
        <label class="f">
          <span>{{ $t('dcw.k1b6qorg036') }}</span>
          <textarea
            v-model="form.semantics"
            class="inp"
            rows="3"
            :placeholder="$t('dcw.k1qdnfzc008')"
          />
        </label>
        <p
          v-if="tplError"
          class="m-err"
        >
          {{ tplError }}
        </p>
        <div class="m-actions">
          <button
            class="mini-btn"
            @click="open = false"
          >
            {{ $t('dcw.k3x62t037') }}
          </button>
          <button
            class="pill-btn"
            :disabled="!form.name.trim() || form.min === '' || form.max === ''"
            @click="submit"
          >
            {{ $t('dcw.k1bg9nga038') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
