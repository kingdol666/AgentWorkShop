<script setup lang="ts">
/**
 * Recipe 逐动作审批卡(权限模型 v2)—— 配方参数写入/下发/试验/回退的 HITL 单。
 * nodeId = `recipe:<recipeId>`(与整包审批 recipe-propose:<id> 平行分流);
 * payload 为 recipeApprovalPayload(op/recipeName/reason/params/runId),
 * payload 缺失时降级渲染 detail 文本(批准/拒绝仍可用 —— 单动作无 choice 语义)。
 */
import { computed, ref } from 'vue'

interface GateParam { nodeId: string, name: string, from: number | null, to: number, unit?: string }
interface GatePayload {
  schemaVersion: number
  kind?: string
  op?: string
  recipeId?: string
  recipeName?: string
  reason?: string
  params?: GateParam[]
  runId?: string
}

const props = defineProps<{
  items: Array<{ id: string, nodeId: string, detail: string, createdAt: string, expiresAt: string, payload?: GatePayload }>
  comments: Record<string, string>
  decidingId: string
  error: string
}>()

const emit = defineEmits<{ decide: [id: string, approved: boolean, comment: string] }>()

const { t } = useI18n()

const OP_LABEL: Record<string, string> = {
  update: '参数写入',
  dispatch: '下发',
  trial: '试验下发',
  rollback: '回退',
}

const opOf = (a: { payload?: GatePayload }): string => a.payload?.op ? (OP_LABEL[a.payload.op] ?? a.payload.op) : '配方操作'
const reasonOf = (a: { payload?: GatePayload, detail: string }): string => a.payload?.reason ?? ''
const paramsOf = (a: { payload?: GatePayload }): GateParam[] => Array.isArray(a.payload?.params) ? a.payload!.params! : []

/** 意见输入(就地 v-model:父组件 comments 记录经 provide 传入不可写,这里本地暂存) */
const localComments = ref<Record<string, string>>({})
const commentOf = (id: string): string => localComments.value[id] ?? props.comments[id] ?? ''
const setComment = (id: string, v: string): void => {
  localComments.value[id] = v
}

const title = computed(() => t('dcwDetail.recipeGateTitle'))
</script>

<template>
  <div class="sec">
    <h3 class="sec-label">
      {{ title }}
    </h3>
    <p
      v-if="error"
      class="test-result bad"
    >
      ✗ {{ error }}
    </p>
    <div
      v-for="a in items"
      :key="a.id"
      class="gate-card"
    >
      <div class="gate-head">
        <span class="op-pill">{{ opOf(a) }}</span>
        <strong>{{ a.payload?.recipeName || a.nodeId }}</strong>
        <small
          v-if="a.payload?.runId"
          class="dim"
        >批次 {{ a.payload.runId.slice(0, 8) }}</small>
        <small class="dim">⏱ {{ a.expiresAt.slice(11, 19) }} 前有效</small>
      </div>
      <div
        v-if="reasonOf(a)"
        class="gate-reason"
      >
        <span class="dim">Agent 理由:</span>{{ reasonOf(a) }}
      </div>
      <table
        v-if="paramsOf(a).length"
        class="gate-params"
      >
        <thead>
          <tr><th>参数</th><th>原值</th><th>新值</th></tr>
        </thead>
        <tbody>
          <tr
            v-for="p in paramsOf(a)"
            :key="p.nodeId"
          >
            <td>{{ p.name }}</td>
            <td class="mono">
              {{ p.from ?? '—' }}{{ p.unit }}
            </td>
            <td class="mono">
              {{ p.to }}{{ p.unit }}
            </td>
          </tr>
        </tbody>
      </table>
      <details
        v-if="!paramsOf(a).length"
        class="dim"
      >
        <summary>原始摘要</summary>
        <p class="mono">
          {{ a.detail }}
        </p>
      </details>
      <div class="gate-actions">
        <input
          class="inp"
          :value="commentOf(a.id)"
          :placeholder="$t('dcwDetail.recipeGateCommentPh')"
          @input="setComment(a.id, ($event.target as HTMLInputElement).value)"
        >
        <button
          class="mini-btn good"
          :disabled="decidingId === a.id"
          @click="emit('decide', a.id, true, commentOf(a.id))"
        >
          {{ $t('dcwDetail.recipeGateApprove') }}
        </button>
        <button
          class="mini-btn danger"
          :disabled="decidingId === a.id"
          @click="emit('decide', a.id, false, commentOf(a.id))"
        >
          {{ $t('dcwDetail.recipeGateReject') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gate-card { border: 1px solid var(--line-faint, rgba(255,255,255,.12)); border-radius: 8px; padding: 10px 12px; margin: 8px 0; display: grid; gap: 8px; }
.gate-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.op-pill { border: 1px solid var(--accent); color: var(--accent); border-radius: 999px; padding: 0 8px; font-size: 12px; }
.gate-reason { font-size: 13px; line-height: 1.5; }
.gate-params { width: 100%; font-size: 12px; border-collapse: collapse; }
.gate-params th, .gate-params td { text-align: left; padding: 3px 8px; border-bottom: 1px dashed var(--line-faint, rgba(255,255,255,.08)); }
.gate-actions { display: flex; gap: 8px; }
.gate-actions .inp { flex: 1; }
</style>
