<script setup lang="ts">
/**
 * 控制节点清单 —— 逐节点控制开关/状态/当前值/读取值/直写/量程周期/绑定设备/删除。
 * 在飞 id 与写输入框内容由页面持有(经 v-model 就地读写),动作一律回抛页面。
 */
import type { DcwNodeView } from '#shared/dcw-protocol'

defineProps<{
  lineNodes: DcwNodeView[]
  stateLabel: Record<string, string>
  togglingId: string
  readingId: string
  writingId: string
  loaded: boolean
  error: string
  dcwTemplateRefCh: (templateRef?: string) => string
  nodeDeviceNames: (n: { deviceIds?: string[], deviceBindingId?: string | null }) => string
}>()

const emit = defineEmits<{
  toggle: [nodeId: string, enabled: boolean]
  read: [nodeId: string]
  write: [nodeId: string, value: number]
  remove: [nodeId: string]
}>()

/** 直写输入框逐节点暂存(与页面 useDcwWrites 的 setInputs 同一个对象) */
const setInputs = defineModel<Record<string, number | ''>>('setInputs', { required: true })
</script>

<template>
  <a-spin :spinning="!loaded && !error">
    <section class="aw-tile table-card">
      <table class="nodes-table">
        <thead>
          <tr>
            <th>{{ $t('dcwDetail.k1e2dtkt053') }}</th>
            <th>{{ $t('dcwDetail.k403cy054') }}</th>
            <th>{{ $t('dcwDetail.k42w8s055') }}</th>
            <th>{{ $t('dcwDetail.k1deqh0d056') }}</th>
            <th>{{ $t('dcwDetail.k9r7d4e018') }}</th>
            <th>{{ $t('dcwDetail.k1k79ec9057') }}</th>
            <th>{{ $t('dcwDetail.k1dexou6058') }}</th>
            <th>{{ $t('dcwDetail.k1b1nnaa059') }}</th>
            <th>{{ $t('dcwDetail.k1i8rtqt060') }}</th>
            <th class="right">
              {{ $t('dcwDetail.k40aa6061') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="n in lineNodes"
            :key="n.id"
            :class="{ 'node-paused': !n.enabled }"
          >
            <td>
              <span class="mono dim">{{ n.id.slice(0, 8) }}</span>
              <b>{{ n.name }}</b>
              <small class="mono ch">{{ dcwTemplateRefCh(n.templateRef) }}</small>
            </td>
            <td>
              <button
                class="ctrl-toggle"
                :class="{ on: n.enabled }"
                :disabled="togglingId === n.id"
                :title="n.enabled ? $t('dcwDetail.pauseCtrlTip') : $t('dcwDetail.enableCtrlTip')"
                @click="emit('toggle', n.id, !n.enabled)"
              >
                <span class="ct-dot" />
                {{ n.enabled ? $t('dcwDetail.k3o3ib3159') : $t('dcwDetail.k3n93ed062') }}
              </button>
            </td>
            <td>
              <span
                v-if="!n.enabled"
                class="st-pill paused"
              >{{ $t('dcwDetail.k3n93ed062') }}</span>
              <span
                v-else
                class="st-pill"
                :class="n.state"
              >{{ stateLabel[n.state] ?? n.state }}</span>
            </td>
            <td class="mono val">
              {{ n.value != null ? n.value.toFixed(n.decimals) : '--' }}
              <small>{{ n.unit }}</small>
              <small
                v-if="n.lastAckAt"
                class="dim"
              > · {{ n.lastAckAt.slice(11, 19) }}</small>
            </td>
            <td class="mono val">
              <span
                :title="n.lastReadError ?? $t('dcwDetail.k9r7d4e019')"
                :class="{ 'read-stale': n.lastReadError }"
              >{{ n.readValue != null ? n.readValue.toFixed(n.decimals) : '--' }}</span>
              <small>{{ n.unit }}</small>
              <small
                v-if="n.lastReadAt"
                class="dim"
              > · {{ n.lastReadAt.slice(11, 19) }}</small>
              <button
                class="mini-btn read-btn"
                :disabled="readingId === n.id"
                :title="$t('dcwDetail.k9r7d4e020')"
                @click="emit('read', n.id)"
              >
                {{ readingId === n.id ? '···' : $t('dcwDetail.k9r7d4e021') }}
              </button>
            </td>
            <td>
              <div class="write-row">
                <input
                  v-model.number="setInputs[n.id]"
                  type="number"
                  class="inp write-inp mono"
                  :placeholder="`${n.min}~${n.max}`"
                  :min="n.min"
                  :max="n.max"
                  :step="10 ** -n.decimals"
                  :disabled="!n.enabled"
                  :title="!n.enabled ? $t('dcwDetail.pausedTip') : ''"
                >
                <button
                  class="mini-btn write-btn"
                  :disabled="!n.enabled || writingId === n.id || setInputs[n.id] == null || setInputs[n.id] === ''"
                  :title="!n.enabled ? $t('dcwDetail.pausedTip') : $t('dcwDetail.writeTip')"
                  @click="emit('write', n.id, Number(setInputs[n.id]))"
                >
                  {{ writingId === n.id ? $t('dcwDetail.k3l3h80123') : $t('dcwDetail.k3w6td174') }}
                </button>
              </div>
            </td>
            <td class="mono dim">
              {{ n.min }} ~ {{ n.max }} {{ n.unit }}
            </td>
            <td class="mono">
              {{ n.holdIntervalMs == null ? $t('dcwDetail.k3zul4160') : `${n.holdIntervalMs}ms` }}
              <small
                class="dim"
                :title="$t('dcwDetail.k9r7d4e016')"
              >· {{ n.readIntervalMs === 0 ? $t('dcwDetail.k9r7d4e022') : (n.readIntervalMs == null ? $t('dcwDetail.k9r7d4e023') : `${n.readIntervalMs}ms`) }}</small>
              <small
                class="dim"
                :title="$t('dcwDetail.writeLockHint')"
              >· {{ n.writeLockSeconds === 0 ? '0s' : `${n.writeLockSeconds}s` }}</small>
            </td>
            <td>{{ nodeDeviceNames(n) }}</td>
            <td class="right">
              <button
                class="mini-btn danger"
                @click="emit('remove', n.id)"
              >
                {{ $t('dcwDetail.k3xakp063') }}
              </button>
            </td>
          </tr>
          <tr v-if="loaded && lineNodes.length === 0">
            <td colspan="9">
              <div
                class="pane-empty"
                style="min-height: 120px;"
              >
                <p class="pe-sub">
                  {{ $t('dcwDetail.k1wtecyw064') }}
                </p>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </a-spin>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/.modal-mask/.banner/.nodes-table/.sec-label/.st-pill 等)
   在此各持一份逐字相同的副本,以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */

.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.dim { opacity: 0.55; }

.table-card { overflow-x: auto; margin-bottom: 14px; }
.nodes-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.nodes-table th, .nodes-table td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--divider-hair); }
.nodes-table th { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); border-bottom: 1px solid var(--line-strong); }
.nodes-table td b { margin-left: 8px; }
.ch { display: block; margin-top: 2px; font-size: 11.5px; color: var(--ink-faint); }
.right { text-align: right; }
.val { font-size: 13px; }
.val small { margin-left: 3px; color: var(--ink-faint); }
.read-stale { color: var(--tone-danger-dot, #e05a5a); text-decoration: underline dotted; text-underline-offset: 3px; }
.read-btn { margin-left: 8px; }

.st-pill { display: inline-block; padding: 3px 9px; font-family: var(--font-mono); font-size: 11.5px; letter-spacing: 0.04em; border-radius: var(--radius-pill); }
.st-pill.ok { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.st-pill.writing { color: var(--ink); background: var(--hover-tint); }
.st-pill.error, .st-pill.alarm { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.st-pill.warn { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.st-pill.offline, .st-pill.idle { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); }
.st-pill.paused { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }

/* 逐节点 控制开关 */
.ctrl-toggle { display: inline-flex; gap: 6px; align-items: center; padding: 3px 10px; font-size: 11.5px; cursor: pointer; color: var(--ink-faint); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-pill); }
.ctrl-toggle .ct-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tone-neutral-dot); }
.ctrl-toggle.on { color: var(--tone-success-dot); border-color: color-mix(in srgb, var(--tone-success-dot) 45%, transparent); }
.ctrl-toggle.on .ct-dot { background: var(--tone-success-dot); box-shadow: 0 0 6px var(--tone-success-dot); }
.ctrl-toggle:disabled { opacity: 0.55; cursor: wait; }
.node-paused td { opacity: 0.6; }
.node-paused .write-row { opacity: 0.5; }

.write-row { display: flex; gap: 6px; align-items: center; }
.write-inp { width: 92px; padding: 4px 8px; }
.write-btn { padding: 5px 12px; }
.mini-btn { margin-right: 4px; }
.mini-btn.danger { color: var(--tone-danger-dot); }
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }
.inp { padding: 5px 9px; font-size: 12.5px; color: var(--ink); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); }

@media (prefers-reduced-motion: no-preference) {
  .nodes-table tbody tr:hover { background: var(--hover-tint); }
}

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖,≤640 单列)════════════════════════════
   375px 下本页的三类实测缺陷:网关总控条右侧三件套不换行(整块顶出画布)、
   运行控制行的两个 150px 选择器 + 按钮并排超宽、微标签 9~10.5px。 */
  /* 控制节点表:保留列语义,给一条可横扫的卷轴 + 首列钉住 */
  .table-card { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .nodes-table { min-width: 1080px; }
  .nodes-table th,
  .nodes-table td { white-space: nowrap; }
  .nodes-table thead > tr > th:first-child,
  .nodes-table tbody > tr > td:first-child {
    position: sticky;
    left: 0;
    z-index: 2;
    background: var(--paper-raised);
    box-shadow: 1px 0 0 var(--line);
  }
  /* 触摸目标:手持命中区 ≥40px(main.css 只在 pointer:coarse 下兜底) */
  .mini-btn,
  .ctrl-toggle,
  .inp,
  .write-inp {
    min-height: 40px;
  }
  .write-inp { width: 100%; min-width: 90px; }
  .write-row { flex-wrap: wrap; }
}
</style>
