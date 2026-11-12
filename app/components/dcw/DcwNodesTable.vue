<script setup lang="ts">
/**
 * 控制节点清单 —— 逐节点控制开关/状态/当前值/读取值/直写/量程周期/绑定设备/删除。
 * 在飞 id 与写输入框内容由页面持有(经 v-model 就地读写),动作一律回抛页面。
 *
 * 第二轮 E3/E4:11 列表格在 1440 已把「控制中」「工艺里程」挤成竖排,390 下
 * 设定值/读数/写入口全部滚出屏外。改为响应式节点卡:同一份控件在桌面与手持
 * 都完整可见,不再依赖横向卷轴。
 */
import type { DcwNodeView } from '#shared/dcw-protocol'
import { reactive } from 'vue'
import { dcwDriverBadgeKey } from '~/utils/dcw-driver-badge'

defineProps<{
  lineNodes: DcwNodeView[]
  stateLabel: Record<string, string>
  togglingId: string
  readingId: string
  writingId: string
  stepPatchingId: string
  loaded: boolean
  error: string
  dcwTemplateRefCh: (templateRef?: string) => string
  nodeDeviceNames: (n: { deviceIds?: string[], deviceBindingId?: string | null }) => string
}>()

const emit = defineEmits<{
  'toggle': [nodeId: string, enabled: boolean]
  'read': [nodeId: string]
  'write': [nodeId: string, value: number]
  'patch-step-limit': [nodeId: string, value: number | null]
  'artifacts': [nodeId: string]
  'remove': [nodeId: string]
}>()

const { t } = useI18n()

/** 边缘层徽标文案(mes-rest=「MES 边缘层」;mock/s7-stub=「无协议转换」;真实协议自明不加) */
function drvBadge(driver: string): string {
  const key = dcwDriverBadgeKey(driver)
  return key ? t(key) : ''
}

/** 直写输入框逐节点暂存(与页面 useDcwWrites 的 setInputs 同一个对象) */
const setInputs = defineModel<Record<string, number | ''>>('setInputs', { required: true })
const stepDrafts = reactive<Record<string, number | '' | null>>({})
function stepDraft(n: DcwNodeView): number | '' | null {
  return stepDrafts[n.id] ?? n.stepLimit
}
function saveStep(n: DcwNodeView): void {
  const value = stepDrafts[n.id] === undefined ? n.stepLimit : stepDrafts[n.id]
  emit('patch-step-limit', n.id, value === '' || value == null ? null : Number(value))
}

function clock(iso: string | null | undefined): string {
  return iso ? iso.slice(11, 19) : ''
}
</script>

<template>
  <a-spin :spinning="!loaded && !error">
    <section class="aw-tile nodes-panel">
      <header class="np-head">
        <h2>{{ $t('dcwDetail.k1e2dtkt053') }}</h2>
        <span class="np-count mono">{{ lineNodes.length }}</span>
        <span class="np-hint">{{ $t('dcwDetail.nodeListHint') }}</span>
      </header>

      <div
        v-if="lineNodes.length > 0"
        class="node-grid"
      >
        <article
          v-for="n in lineNodes"
          :key="n.id"
          class="node-card"
          :class="{ paused: !n.enabled }"
          data-testid="dcw-node-card"
        >
          <header class="nc-head">
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

            <div class="nc-title">
              <b
                class="nc-name"
                :title="n.name"
              >{{ n.name }}</b>
              <span class="nc-sub mono">
                {{ dcwTemplateRefCh(n.templateRef) }}
                <span
                  v-if="drvBadge(n.driver)"
                  class="drv-badge"
                >{{ drvBadge(n.driver) }}</span>
              </span>
            </div>

            <span
              v-if="!n.enabled || (n.state !== 'ok' && n.state !== 'idle')"
              class="st-pill"
              :class="n.enabled ? n.state : 'paused'"
            >{{ n.enabled ? (stateLabel[n.state] ?? n.state) : $t('dcwDetail.k3n93ed062') }}</span>

            <a-popconfirm
              :title="$t('dcwDetail.removeNodeConfirm', { p0: n.name || n.id })"
              :ok-text="$t('common.remove')"
              :cancel-text="$t('common.cancel')"
              :ok-button-props="{ danger: true }"
              placement="left"
              @confirm="emit('remove', n.id)"
            >
              <button
                class="nc-del"
                :aria-label="$t('dcwDetail.k3xakp063')"
                :title="$t('dcwDetail.k3xakp063')"
              >
                <span class="i-tabler-trash" />
              </button>
            </a-popconfirm>
          </header>

          <div class="nc-metrics">
            <div class="nc-metric">
              <span class="nc-label">{{ $t('dcwDetail.k1deqh0d056') }}</span>
              <span class="nc-value mono">
                <b>{{ n.value != null ? n.value.toFixed(n.decimals) : '--' }}</b>
                <small>{{ n.unit }}</small>
              </span>
              <span class="nc-sub mono">{{ clock(n.lastAckAt) || '—' }}</span>
            </div>

            <div class="nc-metric">
              <span class="nc-label">{{ $t('dcwDetail.k9r7d4e018') }}</span>
              <span class="nc-value mono">
                <b :class="{ 'read-stale': n.lastReadError }">{{ n.readValue != null ? n.readValue.toFixed(n.decimals) : '--' }}</b>
                <small>{{ n.unit }}</small>
                <button
                  class="mini-btn read-btn"
                  :disabled="readingId === n.id"
                  :title="n.lastReadError ?? $t('dcwDetail.k9r7d4e020')"
                  @click="emit('read', n.id)"
                >
                  {{ readingId === n.id ? '···' : $t('dcwDetail.k9r7d4e021') }}
                </button>
              </span>
              <span class="nc-sub mono">{{ clock(n.lastReadAt) || '—' }}</span>
            </div>

            <div class="nc-metric">
              <span class="nc-label">{{ $t('dcwDetail.thStepLimit') }}</span>
              <span class="nc-step">
                <input
                  :value="stepDraft(n) ?? ''"
                  type="number"
                  min="0"
                  step="any"
                  class="inp step-inp mono"
                  placeholder="2% default"
                  :title="$t('dcwDetail.stepInputTitle')"
                  @input="stepDrafts[n.id] = ($event.target as HTMLInputElement).value === '' ? '' : Number(($event.target as HTMLInputElement).value)"
                >
                <button
                  class="mini-btn"
                  :disabled="stepPatchingId === n.id"
                  @click="saveStep(n)"
                >
                  {{ stepPatchingId === n.id ? '…' : $t('common.save') }}
                </button>
              </span>
              <span class="nc-sub">{{ $t('dcwDetail.stepCurrent', { p0: n.stepLimit ?? $t('dcwDetail.stepUnset') }) }} {{ n.unit }}</span>
            </div>
          </div>

          <div class="nc-write">
            <label class="nc-write-label">{{ $t('dcwDetail.k1k79ec9057') }}</label>
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
            <span class="nc-range mono">{{ $t('dcwDetail.k1dexou6058') }} {{ n.min }} ~ {{ n.max }} {{ n.unit }}</span>
          </div>

          <footer class="nc-foot">
            <span>{{ $t('dcwDetail.k1i8rtqt060') }} <b>{{ nodeDeviceNames(n) }}</b></span>
            <span class="mono">{{ $t('dcwDetail.k1b1nnaa059') }} {{ n.holdIntervalMs == null ? $t('dcwDetail.k3zul4160') : `${n.holdIntervalMs}ms` }}</span>
            <span class="mono">{{ n.readIntervalMs === 0 ? $t('dcwDetail.k9r7d4e022') : (n.readIntervalMs == null ? $t('dcwDetail.k9r7d4e023') : `${n.readIntervalMs}ms`) }} · {{ n.writeLockSeconds === 0 ? '0s' : `${n.writeLockSeconds}s` }}</span>
            <button
              v-if="n.driver === 'mes-rest'"
              class="mini-btn"
              :title="$t('dcwDetail.mesArtifactsTitle')"
              @click="emit('artifacts', n.id)"
            >
              {{ $t('dcwDetail.mesArtifactsBtn') }}
            </button>
            <span
              class="nc-id mono"
              :title="n.id"
            >#{{ n.id.slice(0, 8) }}</span>
          </footer>
        </article>
      </div>

      <div
        v-else-if="loaded"
        class="pane-empty"
        style="min-height: 120px;"
      >
        <p class="pe-sub">
          {{ $t('dcwDetail.k1wtecyw064') }}
        </p>
      </div>
    </section>
  </a-spin>
</template>

<style scoped>
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.dim { opacity: 0.55; }

.nodes-panel {
  padding: 14px 16px;
  margin-bottom: 14px;
}

.np-head {
  display: flex;
  gap: 10px;
  align-items: baseline;
  margin-bottom: 12px;
}

.np-head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  color: var(--ink);
}

.np-count {
  padding: 1px 7px;
  font-size: 11px;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
}

.np-hint {
  overflow: hidden;
  font-size: 10.5px;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  gap: 12px;
}

.node-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 12px 14px;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-left: 2px solid var(--line-strong);
  border-radius: var(--radius-panel-sm);
}

.node-card.paused {
  background: var(--paper-deep);
  border-left-color: var(--tone-warning-dot);
}

.nc-head {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.nc-title {
  flex: 1 1 auto;
  min-width: 0;
}

.nc-name {
  display: block;
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 650;
  line-height: 1.35;
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nc-sub {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  font-size: 10.5px;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drv-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  font-size: 10px;
  color: var(--ink-faint);
  border: 1px solid var(--line);
  border-radius: 4px;
}

.nc-del {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  font-size: 14px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 6px;
}

.nc-del:hover { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }

.nc-del:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.nc-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--divider-hair);
  border-bottom: 1px solid var(--divider-hair);
}

.nc-metric {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.nc-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--ink-faint);
  text-transform: uppercase;
}

.nc-value {
  display: flex;
  gap: 3px;
  align-items: baseline;
  min-width: 0;
}

.nc-value b {
  font-size: 22px;
  font-weight: 600;
  line-height: 1;
  color: var(--ink);
}

.nc-value small {
  font-size: 10.5px;
  color: var(--ink-soft);
}

.nc-step {
  display: flex;
  gap: 5px;
  align-items: center;
}

.read-stale {
  color: var(--tone-danger-dot);
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

.read-btn { margin-left: 4px; }

.nc-write {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  align-items: center;
}

.nc-write-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-soft);
}

.write-inp { width: 104px; }
.write-btn { padding: 5px 12px; }
.step-inp { width: 76px; padding: 4px 6px; }

.nc-range {
  margin-left: auto;
  font-size: 10px;
  color: var(--ink-faint);
  white-space: nowrap;
}

.nc-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
  font-size: 10px;
  color: var(--ink-faint);
}

.nc-foot b { font-weight: 600; color: var(--ink-soft); }

.nc-id { margin-left: auto; }

.st-pill {
  display: inline-block;
  flex: none;
  padding: 3px 9px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  border-radius: var(--radius-pill);
}

.st-pill.ok { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.st-pill.writing { color: var(--ink); background: var(--hover-tint); }
.st-pill.error, .st-pill.alarm { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.st-pill.warn { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.st-pill.offline, .st-pill.idle { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); }
.st-pill.paused { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }

.ctrl-toggle {
  display: inline-flex;
  flex: none;
  gap: 6px;
  align-items: center;
  padding: 3px 10px;
  font-size: 10.5px;
  color: var(--ink-faint);
  cursor: pointer;
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}

.ctrl-toggle .ct-dot {
  width: 7px;
  height: 7px;
  background: var(--tone-neutral-dot);
  border-radius: 50%;
}

.ctrl-toggle.on {
  color: var(--tone-success-dot);
  border-color: color-mix(in srgb, var(--tone-success-dot) 45%, transparent);
}

.ctrl-toggle.on .ct-dot {
  background: var(--tone-success-dot);
  box-shadow: 0 0 6px var(--tone-success-dot);
}

.ctrl-toggle:disabled { opacity: 0.55; cursor: wait; }

.mini-btn {
  margin-right: 0;
  padding: 5px 10px;
  font-size: 11px;
  color: var(--ink-soft);
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}

.mini-btn:hover { color: var(--ink); border-color: var(--ink-faint); }
.mini-btn:disabled { opacity: 0.45; cursor: default; }

.inp {
  padding: 5px 9px;
  font-size: 12.5px;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}

.inp:focus {
  outline: none;
  border-color: var(--focus-ring);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

@media (max-width: 900px) {
  .node-grid { grid-template-columns: 1fr; }
  .np-hint { display: none; }
}

@media (max-width: 640px) {
  .nodes-panel { padding: 12px; }
  .nc-head { flex-wrap: wrap; }
  .nc-title { flex: 1 1 100%; order: 2; }
  .ctrl-toggle { order: 1; }
  .st-pill { order: 1; }
  .nc-del { order: 1; margin-left: auto; }
  .nc-name {
    display: -webkit-box;
    overflow: hidden;
    white-space: normal;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }
  .nc-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .nc-metric:last-child { grid-column: 1 / -1; }
  .nc-write .write-inp { flex: 1 1 90px; }
  .nc-range { width: 100%; margin-left: 0; }
  .mini-btn,
  .ctrl-toggle,
  .nc-del { min-height: 40px; }
  .nc-del { width: 40px; }
}
</style>
