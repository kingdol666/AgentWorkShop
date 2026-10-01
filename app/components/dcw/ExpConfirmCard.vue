<script setup lang="ts">
/**
 * 本地调整确认卡(产线详情页)—— Co-Pilot 经验采集推断的「非平台写入」设定值变化,
 * 待人工转正:确认=认可为产线侧本地调整,进入经验总结流水线;忽略=不总结。
 * 数据与裁决由页面 useExpConfirmations 独占持有(经 props/emit 回抛,
 * 与 DcwParamApprovalCard 同模式);空态由页面 v-if 收敛(整卡不渲染,避免噪音)。
 * 卡片外框对齐审批卡(aw-tile);确认=成功色 mini-btn,忽略=danger mini-btn。
 */
import type { ExpConfirmRow } from '../../pages/dcw/composables/useExpConfirmations'
import { formatLocalStamp } from '@/app/composables/workshop/useLocalTime'

defineProps<{
  items: ExpConfirmRow[]
  /** 在飞裁决的行 id(行内按钮禁用) */
  decidingId: string
  /** 裁决失败提示(非空时卡内红字提示) */
  decideError: string
}>()

const emit = defineEmits<{ decide: [id: string, ok: boolean] }>()
</script>

<template>
  <section class="aw-tile xc-card">
    <div class="xc-head">
      <b>{{ $t('expConfirm.title') }}</b>
      <span class="xc-count mono">{{ items.length }}</span>
      <small class="xc-rule">{{ $t('expConfirm.rule') }}</small>
    </div>
    <p
      v-if="decideError"
      class="xc-err"
    >
      {{ decideError }}
    </p>
    <div
      v-for="row in items"
      :key="row.id"
      class="xc-row"
    >
      <div class="xc-main">
        <div class="xc-line">
          <span class="xc-node">{{ row.nodeName || row.nodeId }}</span>
          <span class="xc-delta mono">{{ row.from }} → {{ row.to }}</span>
          <span class="xc-at mono">{{ formatLocalStamp(row.at) }}</span>
        </div>
        <small class="xc-evidence">{{ row.evidence }}</small>
      </div>
      <div class="xc-actions">
        <button
          class="mini-btn xc-ok"
          :disabled="decidingId === row.id"
          @click="emit('decide', row.id, true)"
        >
          {{ $t('expConfirm.confirm') }}
        </button>
        <button
          class="mini-btn danger"
          :disabled="decidingId === row.id"
          @click="emit('decide', row.id, false)"
        >
          {{ $t('expConfirm.ignore') }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.mini-btn 在 main.css 全局,此处仅 .mono 需持副本)在此各持一份。 */

.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

.xc-card { padding: 12px 18px; margin-bottom: 14px; border-color: color-mix(in srgb, var(--tone-warning-dot) 35%, transparent); }
.xc-head { display: flex; gap: 8px; align-items: baseline; }
.xc-head b { font-size: 13.5px; }
.xc-count { padding: 0 7px; font-size: 11.5px; color: var(--tone-warning-dot); border: 1px solid var(--tone-warning-dot); border-radius: 4px; }
.xc-rule { margin-left: auto; font-size: 10.5px; color: var(--ink-faint); }
.xc-err { margin: 8px 0 0; font-size: 12px; color: var(--tone-danger-dot); }

.xc-row { display: flex; gap: 10px; align-items: center; padding: 9px 0; border-top: 1px solid var(--divider-hair); }
.xc-row:first-of-type { border-top: 0; margin-top: 8px; }
.xc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.xc-line { display: flex; gap: 10px; align-items: baseline; min-width: 0; flex-wrap: wrap; }
.xc-node { font-weight: 600; font-size: 12.5px; }
.xc-delta { font-size: 12px; color: var(--ink-soft); }
.xc-at { font-size: 11px; color: var(--ink-faint); }
.xc-evidence { font-size: 11px; color: var(--ink-faint); overflow-wrap: anywhere; }
.xc-actions { display: flex; flex: none; gap: 6px; }
.xc-ok { color: var(--tone-success-dot); }

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖):确认行落成一列,触摸目标 ≥40px ══ */
  .xc-card { padding: 12px; }
  .xc-rule { margin-left: 0; }
  .xc-row { flex-wrap: wrap; }
  .xc-actions { margin-left: auto; }
  .mini-btn {
    min-height: 40px;
  }
}
</style>
