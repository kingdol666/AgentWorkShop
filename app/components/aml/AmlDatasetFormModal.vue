<script setup lang="ts">
/**
 * 新建数据集快照弹窗(spec 与 server/services/workshop/aml/spec.ts 的 zod 模式对齐)。
 * 表单与节点草稿自持(打开/关闭之间保留输入,与拆分前一致);提交成功后由页面刷新列表。
 */
import { reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { amlApi } from '../../pages/aml/api'
import { useAmlFormat } from '../../pages/aml/composables/useAmlFormat'
import type { AmlDatasetBundle, DsNodeDraft } from '../../pages/aml/types'

const emit = defineEmits<{
  created: []
}>()

/** 弹窗开合(页面持有时刻,便于从数据集表的「新建」按钮拉起) */
const open = defineModel<boolean>('open', { required: true })

const { t: tt } = useI18n()
const { shortId } = useAmlFormat()

const dsSaving = ref(false)
const dsFormError = ref('')
const dsForm = reactive({
  lineId: '',
  productId: '',
  recipeId: '',
  beatMs: 5000,
  historySteps: 60,
  horizonSteps: 30,
  valRatio: 0.15,
  testRatio: 0.15,
  seed: 7,
  purpose: 'mpc_surrogate',
  note: '',
})
const dsNodes = reactive<DsNodeDraft[]>([
  { nodeId: '', role: 'control' },
  { nodeId: '', role: 'target' },
])

// 打开即清掉上一次的报错(表单值保留,与拆分前的 openDsForm 等价)
watch(open, (v) => {
  if (v) dsFormError.value = ''
})

function addDsNode(): void {
  dsNodes.push({ nodeId: '', role: 'feature' })
}
function removeDsNode(i: number): void {
  dsNodes.splice(i, 1)
}

async function submitDsForm(): Promise<void> {
  dsFormError.value = ''
  const nodes = dsNodes.filter(n => n.nodeId.trim()).map(n => ({ nodeId: n.nodeId.trim(), role: n.role }))
  if (!dsForm.lineId.trim() || !dsForm.productId.trim() || !dsForm.recipeId.trim()) {
    dsFormError.value = tt('aml.k1amlx161')
    return
  }
  if (nodes.length < 2 || !nodes.some(n => n.role === 'target')) {
    dsFormError.value = tt('aml.k1amlx054')
    return
  }
  dsSaving.value = true
  try {
    const data = await amlApi<AmlDatasetBundle>('/datasets', {
      method: 'POST',
      body: JSON.stringify({
        lineId: dsForm.lineId.trim(),
        productId: dsForm.productId.trim(),
        recipeId: dsForm.recipeId.trim(),
        nodes,
        beatMs: Number(dsForm.beatMs),
        window: { historySteps: Number(dsForm.historySteps), horizonSteps: Number(dsForm.horizonSteps) },
        split: { valRatio: Number(dsForm.valRatio), testRatio: Number(dsForm.testRatio), seed: Number(dsForm.seed) },
        purpose: dsForm.purpose,
        note: dsForm.note.trim() || undefined,
      }),
    })
    message.success(tt('aml.k1amlx073', { p0: shortId(data.dataset.id), p1: data.dataset.rowCount }))
    open.value = false
    emit('created')
  }
  catch (err) {
    dsFormError.value = apiErrorMessage(err)
  }
  finally {
    dsSaving.value = false
  }
}
</script>

<template>
  <div
    v-if="open"
    class="modal-mask"
    @click.self="open = false"
  >
    <div class="modal">
      <h3 class="m-title">
        {{ $t('aml.k1amlx050') }}
      </h3>
      <div class="f-grid">
        <label class="f">
          <span>{{ $t('aml.k1amlx051') }}<em>*</em></span>
          <input
            v-model="dsForm.lineId"
            class="inp"
            placeholder="line-ov-01"
          >
        </label>
        <label class="f">
          <span>{{ $t('aml.k1amlx052') }}<em>*</em></span>
          <input
            v-model="dsForm.productId"
            class="inp"
          >
        </label>
        <label class="f">
          <span>{{ $t('aml.k1amlx053') }}<em>*</em></span>
          <input
            v-model="dsForm.recipeId"
            class="inp"
          >
        </label>
      </div>
      <p class="sec-label">
        {{ $t('aml.k1amlx054') }}
      </p>
      <div class="node-rows">
        <div
          v-for="(n, i) in dsNodes"
          :key="i"
          class="node-row"
        >
          <input
            v-model="n.nodeId"
            class="inp grow"
            :placeholder="$t('aml.k1amlx056')"
          >
          <select
            v-model="n.role"
            class="inp sel"
          >
            <option value="control">
              {{ $t('aml.k1amlx057') }}
            </option>
            <option value="feature">
              {{ $t('aml.k1amlx058') }}
            </option>
            <option value="target">
              {{ $t('aml.k1amlx059') }}
            </option>
          </select>
          <button
            class="mini-btn danger"
            :disabled="dsNodes.length <= 1"
            @click="removeDsNode(i)"
          >
            ✕
          </button>
        </div>
        <button
          class="mini-btn"
          @click="addDsNode"
        >
          <span class="i-tabler-plus" />
          {{ $t('aml.k1amlx055') }}
        </button>
      </div>
      <div class="f-grid">
        <label class="f">
          <span>{{ $t('aml.k1amlx060') }}</span>
          <input
            v-model.number="dsForm.beatMs"
            type="number"
            min="1000"
            step="500"
            class="inp"
          >
        </label>
        <label class="f">
          <span>{{ $t('aml.k1amlx061') }}</span>
          <input
            v-model.number="dsForm.historySteps"
            type="number"
            min="1"
            class="inp"
          >
        </label>
        <label class="f">
          <span>{{ $t('aml.k1amlx062') }}</span>
          <input
            v-model.number="dsForm.horizonSteps"
            type="number"
            min="1"
            class="inp"
          >
        </label>
        <label class="f">
          <span>{{ $t('aml.k1amlx063') }}</span>
          <input
            v-model.number="dsForm.valRatio"
            type="number"
            min="0"
            max="0.8"
            step="0.05"
            class="inp"
          >
        </label>
        <label class="f">
          <span>{{ $t('aml.k1amlx064') }}</span>
          <input
            v-model.number="dsForm.testRatio"
            type="number"
            min="0"
            max="0.8"
            step="0.05"
            class="inp"
          >
        </label>
        <label class="f">
          <span>{{ $t('aml.k1amlx065') }}</span>
          <input
            v-model.number="dsForm.seed"
            type="number"
            class="inp"
          >
        </label>
        <label class="f">
          <span>{{ $t('aml.k1amlx066') }}</span>
          <select
            v-model="dsForm.purpose"
            class="inp"
          >
            <option value="mpc_surrogate">
              {{ $t('aml.k1amlx067') }}
            </option>
            <option value="quality_predict">
              {{ $t('aml.k1amlx068') }}
            </option>
          </select>
        </label>
        <label class="f wide">
          <span>{{ $t('aml.k1amlx026') }}</span>
          <input
            v-model="dsForm.note"
            class="inp"
            :placeholder="$t('aml.k1amlx069')"
          >
        </label>
      </div>
      <p
        v-if="dsFormError"
        class="m-err"
      >
        {{ dsFormError }}
      </p>
      <div class="m-actions">
        <button
          class="ghost-btn"
          @click="open = false"
        >
          {{ $t('aml.k1amlx071') }}
        </button>
        <button
          class="pill-btn"
          :disabled="dsSaving"
          @click="submitDsForm"
        >
          {{ dsSaving ? $t('aml.k1amlx070') : $t('aml.k1amlx072') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped src="../../pages/aml/styles.css"></style>
