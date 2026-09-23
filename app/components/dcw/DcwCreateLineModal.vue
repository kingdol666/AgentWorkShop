<script setup lang="ts">
/**
 * 新建产线弹窗 —— 表单留在组件内(纯 UI 状态),开合/在飞/错误由页面下发的
 * useDcwLineMutations 持有;提交以 LineInput 回抛,不复制任何 store 状态。
 */
import { reactive, watch } from 'vue'
import { DCW_LINE_COLORS } from '#shared/dcw-protocol'
import type { LineInput } from '#shared/dcw-protocol'

defineProps<{
  saving: boolean
  error: string
  /** 新建未选色时的默认色(按现有产线数轮转;页面派生) */
  nextColor: string
}>()

const emit = defineEmits<{ submit: [input: LineInput], close: [] }>()

const open = defineModel<boolean>('open', { required: true })

const form = reactive({ name: '', description: '', color: '' })

// 打开即清零(与原 openCreate 同步):空表单不残留上一次输入
watch(open, (v) => {
  if (!v) return
  form.name = ''
  form.description = ''
  form.color = ''
})

function submit(): void {
  emit('submit', {
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
          {{ $t('dcw.k1efe391017') }}
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
            {{ $t('dcw.k3wzi2023') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
