<script setup lang="ts">
/**
 * HITL 下发参数审批卡(产线详情页)—— 本产线控制节点的 Agent 写入待批项。
 * 数据与裁决由页面 useDcwParamApprovals 独占持有(经 props/emit 回抛,与节点表同模式);
 * 空态由页面 v-if 收敛(整卡不渲染,避免噪音)。三态语义:同意=立即执行;
 * 拒绝=Agent 按原值继续(意见逐字回流);超时=默认不同意(卡头小字常驻)。
 */
import type { DcwApprovalRow } from '../../pages/dcw/composables/useDcwParamApprovals'

defineProps<{
  items: DcwApprovalRow[]
  decidingId: string
  remainingSec: (a: DcwApprovalRow) => number
  agentName: (a: DcwApprovalRow) => string
  nodeName: (a: DcwApprovalRow) => string
}>()

const emit = defineEmits<{ decide: [id: string, approved: boolean] }>()

const comments = defineModel<Record<string, string>>('comments', { required: true })
</script>

<template>
  <section class="aw-tile ap-card">
    <div class="ap-head">
      <b>{{ $t('dcwDetail.apTitle') }}</b>
      <span class="ap-count mono">{{ items.length }}</span>
      <small class="ap-rule">{{ $t('dcwDetail.apRule') }}</small>
    </div>
    <div
      v-for="ap in items"
      :key="ap.id"
      class="ap-row"
    >
      <div class="ap-main">
        <div class="ap-line">
          <span class="ap-node">{{ nodeName(ap) }}</span>
          <span class="ap-detail">{{ ap.detail }}</span>
        </div>
        <small class="ap-meta">
          <span class="mono">{{ $t('dcwDetail.apInitiator') }} {{ agentName(ap) }}</span>
          <span
            v-if="Number.isFinite(remainingSec(ap))"
            class="ap-ttl mono"
            :class="{ urgent: remainingSec(ap) <= 30 }"
          >⏱ {{ remainingSec(ap) }}s {{ $t('dcwDetail.apTimeout') }}</span>
          <span
            v-else
            class="ap-ttl mono hold"
          >⏱ 等待人工裁决(hold 模式,不自动拒绝)</span>
        </small>
      </div>
      <input
        v-model="comments[ap.id]"
        class="inp ap-comment"
        :placeholder="$t('dcwDetail.apCommentPh')"
      >
      <div class="ap-actions">
        <button
          class="mini-btn ap-ok"
          :disabled="decidingId === ap.id"
          @click="emit('decide', ap.id, true)"
        >
          {{ $t('dcwDetail.apApprove') }}
        </button>
        <button
          class="mini-btn danger"
          :disabled="decidingId === ap.id"
          @click="emit('decide', ap.id, false)"
        >
          {{ $t('dcwDetail.apReject') }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/... 等)在此各持一份逐字相同的副本。 */

.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

.ap-card { padding: 12px 18px; margin-bottom: 14px; border-color: color-mix(in srgb, var(--tone-warning-dot) 35%, transparent); }
.ap-head { display: flex; gap: 8px; align-items: baseline; }
.ap-head b { font-size: 13.5px; }
.ap-count { padding: 0 7px; font-size: 11.5px; color: var(--tone-warning-dot); border: 1px solid var(--tone-warning-dot); border-radius: 4px; }
.ap-rule { margin-left: auto; font-size: 10.5px; color: var(--ink-faint); }

.ap-row { display: flex; gap: 10px; align-items: center; padding: 9px 0; border-top: 1px solid var(--divider-hair); }
.ap-row:first-of-type { border-top: 0; margin-top: 8px; }
.ap-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ap-line { display: flex; gap: 8px; align-items: baseline; min-width: 0; flex-wrap: wrap; }
.ap-node { font-weight: 600; font-size: 12.5px; }
.ap-detail { font-size: 12px; color: var(--ink-soft); overflow-wrap: anywhere; }
.ap-meta { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: 11px; color: var(--ink-faint); }
.ap-ttl { color: var(--tone-warning-dot); }
.ap-ttl.urgent { color: var(--tone-danger-dot); }
.ap-ttl.hold { color: var(--tone-info-dot); }
.ap-comment { flex: none; width: 240px; padding: 5px 9px; font-size: 12px; }
.ap-actions { display: flex; flex: none; gap: 6px; }
.ap-ok { color: var(--tone-success-dot); }

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖):审批行落成一列,触摸目标 ≥40px ══ */
  .ap-card { padding: 12px; }
  .ap-rule { margin-left: 0; }
  .ap-row { flex-wrap: wrap; }
  .ap-comment { flex: 1 1 100%; width: auto; }
  .ap-actions { margin-left: auto; }
  .mini-btn,
  .inp {
    min-height: 40px;
  }
}
</style>
