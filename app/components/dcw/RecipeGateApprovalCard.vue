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
  /** 应急豁免频控标记(审批不可豁免;高亮提示裁决人) */
  emergency?: boolean
}

const props = defineProps<{
  items: Array<{ id: string, nodeId: string, detail: string, createdAt: string, expiresAt: string, payload?: GatePayload }>
  comments: Record<string, string>
  decidingId: string
  error: string
}>()

const emit = defineEmits<{ decide: [id: string, approved: boolean, comment: string] }>()

const { t } = useI18n()

const opOf = (a: { payload?: GatePayload }): string => {
  const op = a.payload?.op
  if (!op) return t('dcwDetail.recipeGateOpFallback')
  const key = `dcwDetail.recipeGateOp${op.charAt(0).toUpperCase()}${op.slice(1)}`
  const label = t(key)
  // 未登记的 op 直接展示原值(t() 对缺失 key 会回显 key 名,这里拦住)
  return label === key ? op : label
}
const reasonOf = (a: { payload?: GatePayload, detail: string }): string => a.payload?.reason ?? ''
const paramsOf = (a: { payload?: GatePayload }): GateParam[] => Array.isArray(a.payload?.params) ? a.payload!.params! : []

/** 审批有效期:1s 心跳的剩余时长;过期禁用双侧按钮,不再"提交后才暴露"(2026-11-06) */
const now = ref(Date.now())
let expireTick: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  expireTick = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => {
  if (expireTick) clearInterval(expireTick)
})
const remainMsOf = (a: { expiresAt: string }): number => Date.parse(a.expiresAt) - now.value
const isExpired = (a: { expiresAt: string }): boolean => remainMsOf(a) <= 0
const remainLabelOf = (a: { expiresAt: string }): string => {
  const ms = remainMsOf(a)
  if (ms <= 0) return t('dcwDetail.recipeGateExpired')
  const min = Math.floor(ms / 60000)
  if (min >= 1) return t('dcwDetail.recipeGateRemainMin', { n: min })
  return t('dcwDetail.recipeGateRemainSec', { n: Math.max(1, Math.floor(ms / 1000)) })
}

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
        <span
          v-if="a.payload?.emergency"
          class="op-pill emergency"
          :title="$t('dcwDetail.recipeGateEmergencyTip')"
        >{{ $t('dcwDetail.recipeGateEmergency') }}</span>
        <small
          v-if="a.payload?.runId"
          class="dim"
        >{{ $t('dcwDetail.recipeGateRun') }} {{ a.payload.runId.slice(0, 8) }}</small>
        <small
          class="dim expiry"
          :class="{ expired: isExpired(a) }"
        >⏱ {{ remainLabelOf(a) }}</small>
      </div>
      <div
        v-if="reasonOf(a)"
        class="gate-reason"
      >
        <span class="dim">{{ $t('dcwDetail.recipeGateAgentReason') }}</span>{{ reasonOf(a) }}
      </div>
      <table
        v-if="paramsOf(a).length"
        class="gate-params"
      >
        <thead>
          <tr>
            <th>{{ $t('dcwDetail.recipeGateParam') }}</th>
            <th>{{ $t('dcwDetail.recipeGateFrom') }}</th>
            <th>{{ $t('dcwDetail.recipeGateTo') }}</th>
          </tr>
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
        <summary>{{ $t('dcwDetail.recipeGateRawSummary') }}</summary>
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
          :disabled="decidingId === a.id || isExpired(a)"
          @click="emit('decide', a.id, true, commentOf(a.id))"
        >
          {{ $t('dcwDetail.recipeGateApprove') }}
        </button>
        <button
          class="mini-btn danger"
          :disabled="decidingId === a.id || isExpired(a)"
          @click="emit('decide', a.id, false, commentOf(a.id))"
        >
          {{ $t('dcwDetail.recipeGateReject') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gate-card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 8px 0; display: grid; gap: 8px; }
.gate-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.op-pill { border: 1px solid var(--accent); color: var(--accent); border-radius: 999px; padding: 0 8px; font-size: 12px; }
/* 应急徽标:语义 = 告警,走 tone-danger 而非场外 hex(色彩锁) */
.op-pill.emergency { border-color: var(--tone-danger-dot); color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
/* 审批有效期:<60s 转警示色,过期置灰并禁用双侧按钮 */
.expiry.expired { color: var(--ink-fainter); text-decoration: line-through; }
.gate-reason { font-size: 13px; line-height: 1.5; }
.gate-params { width: 100%; font-size: 12px; border-collapse: collapse; }
.gate-params th, .gate-params td { text-align: left; padding: 3px 8px; border-bottom: 1px dashed var(--line); }
.gate-actions { display: flex; gap: 8px; }
.gate-actions .inp { flex: 1; }
</style>
