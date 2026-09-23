<script setup lang="ts">
/**
 * 删除产线弹窗(两步确认) —— purge 勾选决定是否级联清理旗下节点/产品/配方。
 * 打开状态与摘要数据由页面(useDcwLineMutations)持有,确认动作回抛页面。
 */
import type { LineCard } from '../../pages/dcw/types'

defineProps<{
  card: LineCard | null
  purge: boolean
  busy: boolean
  error: string
}>()

const emit = defineEmits<{
  'update:purge': [value: boolean]
  'close': []
  'confirm': []
}>()

const open = defineModel<boolean>('open', { required: true })
</script>

<template>
  <Transition name="modal">
    <div
      v-if="open && card"
      class="modal-mask"
      @click.self="emit('close')"
    >
      <div class="modal">
        <h3 class="m-title danger-title">
          <span class="i-tabler-alert-triangle" />
          {{ $t('dcw.k7xq2mfd063', { p0: card.line.name }) }}
        </h3>
        <p class="del-summary">
          {{ purge
            ? $t('dcw.k4r7nbd073', { p0: card.line.name, p1: card.nodes, p2: card.products, p3: card.recipes })
            : $t('dcw.k1gp649b062', { p0: card.line.name, p1: card.nodes, p2: card.products, p3: card.recipes }) }}
        </p>
        <label class="del-purge">
          <input
            :checked="purge"
            type="checkbox"
            @change="emit('update:purge', ($event.target as HTMLInputElement).checked)"
          >
          <span>{{ $t('dcw.k9m2vxa072') }}</span>
        </label>
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
            class="pill-btn danger"
            :disabled="busy"
            @click="emit('confirm')"
          >
            {{ $t('dcw.k3xakp026') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
