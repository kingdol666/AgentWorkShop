<script setup lang="ts">
/**
 * 编辑产线弹窗(名称/描述/光晕色/控制模式总闸) —— 页面下发待编辑卡片作为唯一数据源,
 * 组件在目标变化时填充表单(与原 openEdit 同一时点),提交动作回抛页面。
 * 控制模式(2026-10-08 生产化):manual=人工审批总闸(缺省);manual→auto 需二次确认。
 */
import { reactive, ref, watch } from 'vue'
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

const emit = defineEmits<{ submit: [id: string, patch: Partial<LineView> & { confirm?: boolean }], close: [] }>()

const open = defineModel<boolean>('open', { required: true })

const form = reactive({ name: '', description: '', color: '', controlMode: 'manual' as 'auto' | 'manual' })
/** manual→auto 二次确认态(两段式:先弹确认条,再点"仍要切换") */
const pendingAuto = ref(false)

// 目标变化 → 以产线现值填充表单(失败的编辑保留上次输入,与页面原行为一致)
watch(() => props.card, (card) => {
  if (!card) return
  form.name = card.line.name
  form.description = card.line.description
  form.color = card.line.color
  form.controlMode = card.line.controlMode === 'auto' ? 'auto' : 'manual'
  pendingAuto.value = false
})

function pickMode(m: 'auto' | 'manual'): void {
  if (m === form.controlMode) return
  if (m === 'auto') {
    // 摘审批闸门必须显式二次确认(fail-safe;与后端 confirm:true 守卫同语义)
    pendingAuto.value = true
    return
  }
  form.controlMode = 'manual'
  pendingAuto.value = false
}

function confirmAuto(): void {
  form.controlMode = 'auto'
  pendingAuto.value = false
}

function submit(): void {
  if (!props.card) return
  emit('submit', props.card.line.id, {
    name: form.name.trim(),
    description: form.description.trim(),
    color: form.color || undefined,
    ...(form.controlMode !== (props.card.line.controlMode === 'auto' ? 'auto' : 'manual')
      ? { controlMode: form.controlMode, ...(form.controlMode === 'auto' ? { confirm: true } : {}) }
      : {}),
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
        <div class="f">
          <span>控制模式</span>
          <div class="mode-row">
            <button
              class="mode-opt"
              :class="{ on: form.controlMode === 'manual' }"
              type="button"
              @click="pickMode('manual')"
            >
              手动(人工审批)
            </button>
            <button
              class="mode-opt"
              :class="{ on: form.controlMode === 'auto', danger: form.controlMode === 'auto' }"
              type="button"
              @click="pickMode('auto')"
            >
              自动(按绑定模式)
            </button>
          </div>
          <small class="dim">手动:本线全部配方写动作强制人工批准(缺省);自动:按各节点/配方绑定的模式执行(auto 免批)。</small>
          <div
            v-if="pendingAuto"
            class="confirm-strip"
          >
            <span>切换为「自动」将摘除本线人工审批总闸(auto 绑定不再逐次审批)。确定?</span>
            <button
              class="mini-btn"
              type="button"
              @click="pendingAuto = false"
            >
              取消
            </button>
            <button
              class="pill-btn danger-btn"
              type="button"
              @click="confirmAuto"
            >
              仍要切换(需显式确认)
            </button>
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

<style scoped>
.mode-row {
  display: flex;
  gap: 8px;
}
.mode-opt {
  border: 1px solid var(--aw-border, #d9d9d9);
  border-radius: 999px;
  padding: 4px 14px;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
}
.mode-opt.on {
  border-color: var(--aw-primary, #3aa0ff);
  color: var(--aw-primary, #3aa0ff);
  background: color-mix(in srgb, var(--aw-primary, #3aa0ff) 10%, transparent);
}
.mode-opt.danger.on {
  border-color: #ff8a5c;
  color: #ff8a5c;
  background: rgba(255, 138, 92, 0.1);
}
.confirm-strip {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  border: 1px solid #ff8a5c;
  background: rgba(255, 138, 92, 0.08);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
}
.danger-btn {
  background: #ff8a5c;
  border-color: #ff8a5c;
  color: #fff;
}
</style>
