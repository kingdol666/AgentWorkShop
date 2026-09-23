<script setup lang="ts">
/**
 * 参数台账(调控闭环)—— 当前值/配方目标/lastGood 三值对照 + 设定历史 + 优化记录。
 * 台账按所选节点拉取(唯一副本在页面 useDcwLedger),刷新与单步回退回抛页面。
 */
import type { DcwNodeView, DcwParamLedger } from '#shared/dcw-protocol'

defineProps<{
  lineNodes: DcwNodeView[]
  ledger: DcwParamLedger | null
}>()

const emit = defineEmits<{ load: [], rollback: [] }>()

const ledgerNodeId = defineModel<string>('nodeId', { required: true })
</script>

<template>
  <section class="aw-tile ledger-card">
    <div class="ledger-head">
      <b>{{ $t('dcwDetail.k1ledgt001') }}</b>
      <select
        v-model="ledgerNodeId"
        class="inp"
        @change="emit('load')"
      >
        <option value="">
          {{ $t('dcwDetail.k1ledgs001') }}
        </option>
        <option
          v-for="n in lineNodes"
          :key="n.id"
          :value="n.id"
        >
          {{ n.name }}
        </option>
      </select>
    </div>
    <template v-if="ledger">
      <div class="ledger-tri">
        <div class="tri-cell">
          <small>{{ $t('dcwDetail.k1ledgv001') }}</small>
          <b class="mono">{{ ledger.current ?? '--' }}</b>
        </div>
        <div class="tri-cell">
          <small>{{ $t('dcwDetail.k1ledgv002') }}</small>
          <b class="mono">{{ ledger.recipeTarget ?? '--' }}</b>
        </div>
        <div class="tri-cell">
          <small>{{ $t('dcwDetail.k1ledgv003') }}</small>
          <b class="mono">{{ ledger.lastGood ?? '--' }}</b>
        </div>
        <button
          class="mini-btn"
          @click="emit('load')"
        >
          {{ $t('dcwDetail.k1ledga001') }}
        </button>
        <button
          class="mini-btn danger"
          @click="emit('rollback')"
        >
          {{ $t('dcwDetail.k1ledga002') }}
        </button>
      </div>
      <div class="ledger-cols">
        <div class="ledger-col">
          <small class="sec-t">{{ $t('dcwDetail.k1ledgh001') }}</small>
          <ul class="ledger-list mono">
            <li
              v-for="a in ledger.journal"
              :key="a.id"
            >
              {{ a.at.slice(5, 16).replace('T', ' ') }} [{{ a.source }}] {{ a.prevValue ?? '?' }} → {{ a.newValue }}
            </li>
          </ul>
        </div>
        <div class="ledger-col">
          <small class="sec-t">{{ $t('dcwDetail.k1ledgr001') }}</small>
          <ul class="ledger-list">
            <li
              v-for="r in ledger.records"
              :key="r.id"
              class="ledger-rec"
            >
              <span
                class="rec-st"
                :class="r.status"
              >{{ r.status }}</span>
              <span class="mono">{{ r.params[0]?.from ?? '?' }} → {{ r.params[0]?.to }}</span>
              <small>{{ r.judge ? `${r.judge.verdict}(${r.judge.by})` : (r.status === 'open' ? 'open' : r.closedBy ?? '') }}</small>
            </li>
          </ul>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/.modal-mask/.banner/.nodes-table/.sec-label/.st-pill 等)
   在此各持一份逐字相同的副本,以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */

/* ── 参数台账(调控闭环) ── */
.ledger-card { padding: 14px 18px; margin-bottom: 14px; }
.ledger-head { display: flex; gap: 12px; align-items: center; }
.ledger-head b { font-size: 13.5px; }
.ledger-tri { display: flex; gap: 12px; align-items: center; margin-top: 12px; }
.tri-cell {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 2px;
  padding: 8px 16px;
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}
.tri-cell small { font-size: 11.5px; color: var(--ink-faint); }
.tri-cell b { font-size: 17px; color: var(--ink); }
.ledger-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px; }
.sec-t { display: block; margin-bottom: 6px; font-size: 11.5px; font-weight: 700; letter-spacing: 0.12em; color: var(--ink-faint); }
.ledger-list { display: flex; flex-direction: column; gap: 3px; max-height: 200px; margin: 0; padding: 0; overflow: auto; font-size: 11.5px; color: var(--ink-soft); list-style: none; }
.ledger-rec { display: flex; gap: 8px; align-items: center; }
.rec-st {
  flex: none;
  padding: 0 6px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-faint);
  border: 1px solid var(--line-strong);
  border-radius: 4px;
}
.rec-st.open { color: var(--tone-warning-dot); border-color: var(--tone-warning-dot); }
.tri-cell b { overflow-wrap: anywhere; }
.rec-st.judged { color: var(--tone-warning-dot); border-color: var(--tone-warning-dot); opacity: 0.85; }
.rec-st.rolled-back, .rec-st.judged-keep { color: var(--tone-success-dot); border-color: var(--tone-success-dot); }

.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

.mini-btn { margin-right: 4px; }
.mini-btn.danger { color: var(--tone-danger-dot); }
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }
.inp { padding: 5px 9px; font-size: 12.5px; color: var(--ink); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); }

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖,≤640 单列)════════════════════════════
   375px 下本页的三类实测缺陷:网关总控条右侧三件套不换行(整块顶出画布)、
   运行控制行的两个 150px 选择器 + 按钮并排超宽、微标签 9~10.5px。 */
  .ledger-card { padding: 12px; }
  .ledger-cols { grid-template-columns: 1fr; }
  .ledger-tri { flex-wrap: wrap; }
  /* 触摸目标:手持命中区 ≥40px(main.css 只在 pointer:coarse 下兜底) */
  .mini-btn,
  .inp {
    min-height: 40px;
  }
}
</style>
