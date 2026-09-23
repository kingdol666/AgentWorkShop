<script setup lang="ts">
/**
 * 编辑产线弹窗(名称/描述/光晕色) —— 页面下发待编辑卡片作为唯一数据源,
 * 组件在目标变化时填充表单(与原 openEdit 同一时点),提交动作回抛页面。
 */
import { reactive, watch } from 'vue'
import { DCW_LINE_COLORS } from '#shared/dcw-protocol'
import type { LineCard } from '../../pages/dcw/types'
import type { LineView } from '#shared/dcw-protocol'

const props = defineProps<{
  card: LineCard | null
  saving: boolean
  error: string
  /** 未选色时的默认色(按现有产线数轮转;页面派生) */
  nextColor: string
}>()

const emit = defineEmits<{ submit: [id: string, patch: Partial<LineView>], close: [] }>()

const open = defineModel<boolean>('open', { required: true })

const form = reactive({ name: '', description: '', color: '' })

// 目标变化 → 以产线现值填充表单(失败的编辑保留上次输入,与页面原行为一致)
watch(() => props.card, (card) => {
  if (!card) return
  form.name = card.line.name
  form.description = card.line.description
  form.color = card.line.color
})

function submit(): void {
  if (!props.card) return
  emit('submit', props.card.line.id, {
    name: form.name.trim(),
    description: form.description.trim(),
    color: form.color || undefined,
  })
}
</script>

<template>
  <Transition name="modal">
    <div
      v-if="open"
      class="modal-mask"
      @click.self="emit('close')"
    >
      <div class="modal">
        <h3 class="m-title">
          {{ $t('dcw.k5tq8wc071') }}
        </h3>
        <label class="f">
          <span>{{ $t('dcw.k1b2ioko019') }}<em>*</em></span>
          <input
            v-model="form.name"
            class="inp"
            :placeholder="$t('dcw.kru37i3004')"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcw.k24dxcd020') }}</span>
          <input
            v-model="form.description"
            class="inp"
            :placeholder="$t('dcw.k1f2nwsp005')"
          >
        </label>
        <div class="f">
          <span>{{ $t('dcw.k1x7nubr021') }}</span>
          <div class="color-row">
            <button
              v-for="c in DCW_LINE_COLORS"
              :key="c"
              class="color-dot"
              :class="{ on: form.color === c }"
              :style="{ background: c }"
              @click="form.color = form.color === c ? '' : c"
            />
            <small class="dim">{{ form.color || $t('dcw.k1qidbpy061', { p0: nextColor }) }}</small>
          </div>
        </div>
        <p
          v-if="error"
          class="m-err"
        >
          {{ error }}
        </p>
        <div class="m-actions">
          <button
            class="mini-btn"
            @click="emit('close')"
          >
            {{ $t('dcw.k3xdnn022') }}
          </button>
          <button
            class="pill-btn"
            :disabled="saving || !form.name.trim()"
            @click="submit"
          >
            {{ $t('common.save') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
