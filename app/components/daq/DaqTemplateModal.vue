<script setup lang="ts">
/**
 * 模板管理 —— 自定义模板增删改 + 内置模板复制(server 权威 CRUD)。
 * 表单/编辑目标/两段式删除确认都在 useDaqTemplates;组件只做呈现。
 */
import type { DaqTemplateDef, DaqTemplateIcon } from '#shared/daq-protocol'

/** 模板表单(useDaqTemplates 的 tplForm;经 v-model 传入,子组件就地读写同一对象) */
interface DaqTemplateFormModel {
  name: string
  ch: string
  code: string
  unit: string
  min: number | string
  max: number | string
  base: number | string
  amp: number | string
  decimals: number | string
  icon: DaqTemplateIcon
}

defineProps<{
  customTpls: DaqTemplateDef[]
  builtinTpls: DaqTemplateDef[]
  iconChoices: readonly DaqTemplateIcon[]
  iconLabels: Record<DaqTemplateIcon, string>
  editing: string | null
  saving: boolean
  error: string
  confirmingDel: string
}>()

const emit = defineEmits<{
  edit: [tpl: DaqTemplateDef]
  copy: [tpl: DaqTemplateDef]
  remove: [tpl: DaqTemplateDef]
  reset: []
  save: []
  close: []
}>()

const open = defineModel<boolean>('open', { required: true })
const form = defineModel<DaqTemplateFormModel>('form', { required: true })
</script>

<template>
  <div
    v-if="open"
    class="modal-mask"
    @click.self="emit('close')"
  >
    <div class="modal">
      <h3 class="m-title">
        {{ $t('daq.k11mv96s032') }}
      </h3>

      <p class="sec-label">
        {{ $t('daq.ktji4ky033') }}
      </p>
      <table class="tpl-table">
        <tbody>
          <tr
            v-for="t in customTpls"
            :key="t.key"
          >
            <td>
              <b>{{ t.name }}</b>
              <small class="mono dim">{{ t.code }}</small>
            </td>
            <td class="mono range">
              {{ t.min }}~{{ t.max }} {{ t.unit }} · {{ t.decimals }} {{ $t('daq.k48oi091') }}
            </td>
            <td class="right actions">
              <button
                class="mini-btn"
                @click="emit('edit', t)"
              >
                {{ $t('daq.k45eb0034') }}
              </button>
              <button
                class="mini-btn danger"
                @click="emit('remove', t)"
              >
                {{ confirmingDel === t.key ? $t('daq.k1hhheu3101') : $t('daq.k3xakp114') }}
              </button>
            </td>
          </tr>
          <tr v-if="!customTpls.length">
            <td
              colspan="3"
              class="empty"
            >
              {{ $t('daq.kztvzbo035') }}
            </td>
          </tr>
        </tbody>
      </table>

      <p class="sec-label">
        {{ editing ? $t('daq.k1iiph0s102') : $t('daq.k1efixrj115') }}
      </p>
      <div class="f-grid">
        <label class="f">
          <span>{{ $t('daq.k3xhia036') }}<em>*</em></span>
          <input
            v-model="form.name"
            class="inp"
            :placeholder="$t('daq.k5opd2t006')"
          >
        </label>
        <label class="f">
          <span>{{ $t('daq.k3x4ef037') }}<em>*</em></span>
          <input
            v-model="form.unit"
            class="inp"
            :placeholder="$t('daq.unitPh')"
          >
        </label>
        <label class="f">
          <span>{{ $t('daq.k1l477m0038') }}</span>
          <input
            v-model="form.ch"
            class="inp"
            :placeholder="$t('daq.kk8o4tl007')"
          >
        </label>
        <label class="f">
          <span>{{ $t('daq.k1ayxrqb039') }}</span>
          <input
            v-model="form.code"
            class="inp"
            :placeholder="$t('daq.kzn3l7l008')"
          >
        </label>
        <label class="f">
          <span>{{ $t('daq.k1l9jv5m040') }}<em>*</em></span>
          <input
            v-model.number="form.min"
            type="number"
            class="inp"
          >
        </label>
        <label class="f">
          <span>{{ $t('daq.k1l9jv4p041') }}<em>*</em></span>
          <input
            v-model.number="form.max"
            type="number"
            class="inp"
          >
        </label>
        <label class="f">
          <span>{{ $t('daq.k3mxmcx042') }}</span>
          <input
            v-model.number="form.decimals"
            type="number"
            min="0"
            max="4"
            class="inp"
          >
        </label>
        <label class="f">
          <span>{{ $t('daq.k3xx56043') }}</span>
          <select
            v-model="form.icon"
            class="inp"
          >
            <option
              v-for="ic in iconChoices"
              :key="ic"
              :value="ic"
            >
              {{ iconLabels[ic] }}
            </option>
          </select>
        </label>
        <label class="f">
          <span>{{ $t('daq.k1f4eknv044') }}</span>
          <input
            v-model.number="form.base"
            type="number"
            class="inp"
          >
          <small class="hint">{{ $t('daq.kytd15s045') }}</small>
        </label>
        <label class="f">
          <span>{{ $t('daq.k1f4ifpo046') }}</span>
          <input
            v-model.number="form.amp"
            type="number"
            class="inp"
          >
          <small class="hint">{{ $t('daq.ksp2aji047') }}</small>
        </label>
      </div>
      <p
        v-if="error"
        class="m-err"
      >
        {{ error }}
      </p>
      <div class="m-actions">
        <button
          class="aw-pill outline"
          @click="emit('reset')"
        >
          {{ $t('daq.k48p40048') }}
        </button>
        <button
          class="pill-btn"
          :disabled="saving"
          @click="emit('save')"
        >
          {{ saving ? $t('daq.k1b38d59103') : (editing ? $t('daq.k1b39281116') : $t('daq.k1b3dtga119')) }}
        </button>
      </div>

      <p class="sec-label">
        {{ $t('daq.k1w8s84s049') }}
      </p>
      <table class="tpl-table">
        <tbody>
          <tr
            v-for="t in builtinTpls"
            :key="t.key"
          >
            <td>
              <b>{{ t.name }}</b>
              <small class="mono dim">{{ t.code }}</small>
            </td>
            <td class="mono range">
              {{ t.min }}~{{ t.max }} {{ t.unit }} · {{ t.decimals }} {{ $t('daq.k48oi091') }}
            </td>
            <td class="right actions">
              <button
                class="mini-btn"
                @click="emit('copy', t)"
              >
                {{ $t('daq.k3y694050') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
