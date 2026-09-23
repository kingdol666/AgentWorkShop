<script setup lang="ts">
/**
 * 节点清单 —— 筛选工具条(产线/设备/产线运行/状态/模板/驱动/数据时间/名称搜索)
 * + 实时告警与实时事件双面板 + 窗口化节点表。
 * 筛选态是页面的唯一副本(按引用下发并就地读写),窗口切片与占位高度由页面下发。
 */
import type { DaqNodeLive } from '@/app/composables/workshop/useDaqStream'
import type { LineView } from '#shared/dcw-protocol'

/** 筛选态(reactive 对象;useDaqFilters 持有) */
interface DaqFilters {
  lineId: string
  deviceId: string
  template: string
  driver: string
  lineRun: string
  state: string
  time: string
  search: string
}

defineProps<{
  hasFilters: boolean
  lines: LineView[]
  boundDevices: Array<{ id: string, name: string, count: number }>
  templateOptions: Array<{ ref: string, count: number, label: string }>
  driverOptions: Array<{ kind: string, count: number, label: string }>
  filteredCount: number
  totalCount: number
  /** 实时事件轨(useOpsLog 的 recent;详情在 /logs) */
  opsRecent: Array<{ at: string, actor: string, action: string, actorKind: string, kind: string, summary: string }>
  opsKindLabel: (kind: string) => string
  opsTime: (at: string) => string
  alarms: Array<{ id: string, nodeName: string, metric: string, value: number | null, rule: string, threshold: number | null, escalation: number }>
  /** 窗口化切片 */
  visibleNodes: DaqNodeLive[]
  padTopPx: number
  padBottomPx: number
  loading: boolean
  loaded: boolean
  error: string
}>()

const emit = defineEmits<{
  'clear-filters': []
  'ack': [id: string]
}>()

/** 筛选态经 v-model 传入(与页面 useDaqFilters 同一 reactive 对象;下拉就地读写) */
const filters = defineModel<DaqFilters>('filters', { required: true })
/** <table> 引用(窗口计算用;由页面注入的 ref 承载) */
const tableEl = defineModel<HTMLTableElement | null>('tableEl', { required: true })
</script>

<template>
  <a-spin :spinning="loading">
    <section class="aw-tile table-card">
      <div class="tbl-toolbar">
        <div class="filters">
          <label class="flt">
            <span>{{ $t('daq.k3wj9n051') }}</span>
            <select
              v-model="filters.lineId"
              class="inp-sel"
            >
              <option value="">
                {{ $t('daq.k1bkl9uj052') }}
              </option>
              <option
                v-for="l in lines"
                :key="l.id"
                :value="l.id"
              >
                {{ l.name }}
              </option>
              <option value="none">
                {{ $t('daq.k3ootr6053') }}
              </option>
            </select>
          </label>
          <label class="flt">
            <span>{{ $t('daq.k1i8rtqt054') }}</span>
            <select
              v-model="filters.deviceId"
              class="inp-sel"
            >
              <option value="">
                {{ $t('daq.k1bkw4m2055') }}
              </option>
              <option
                v-for="d in boundDevices"
                :key="d.id"
                :value="d.id"
              >
                {{ d.name }}({{ d.count }})
              </option>
              <option value="none">
                {{ $t('daq.k3own4q056') }}
              </option>
            </select>
          </label>
          <label
            class="flt"
            :title="$t('daq.khb8mru009')"
          >
            <span>{{ $t('daq.k1b2tkyv057') }}</span>
            <select
              v-model="filters.lineRun"
              class="inp-sel"
            >
              <option value="">
                {{ $t('daq.k3x4t1058') }}
              </option>
              <option value="on">
                {{ $t('daq.k1nxm3p7059') }}
              </option>
              <option value="off">
                {{ $t('daq.k1ulx34e060') }}
              </option>
            </select>
          </label>
          <label class="flt">
            <span>{{ $t('daq.k1iwdfef061') }}</span>
            <select
              v-model="filters.state"
              class="inp-sel"
            >
              <option value="">
                {{ $t('daq.k3x4t1058') }}
              </option>
              <option value="ok">
                {{ $t('daq.k41k5c062') }}
              </option>
              <option value="warn">
                {{ $t('daq.k49z8v063') }}
              </option>
              <option value="alarm">
                {{ $t('daq.k3xmid064') }}
              </option>
              <option value="offline">
                {{ $t('daq.k44c2n065') }}
              </option>
            </select>
          </label>
          <label class="flt">
            <span>{{ $t('daq.k1flttpl010') }}</span>
            <select
              v-model="filters.template"
              class="inp-sel"
            >
              <option value="">
                {{ $t('daq.k1flttpl011') }}
              </option>
              <option
                v-for="t in templateOptions"
                :key="t.ref"
                :value="t.ref"
              >
                {{ t.label }}({{ t.count }})
              </option>
            </select>
          </label>
          <label class="flt">
            <span>{{ $t('daq.k1fltdrv012') }}</span>
            <select
              v-model="filters.driver"
              class="inp-sel"
            >
              <option value="">
                {{ $t('daq.k1fltdrv013') }}
              </option>
              <option
                v-for="d in driverOptions"
                :key="d.kind"
                :value="d.kind"
              >
                {{ d.label }}({{ d.count }})
              </option>
            </select>
          </label>
          <label
            class="flt"
            :title="$t('daq.k1flttim014')"
          >
            <span>{{ $t('daq.k1flttim015') }}</span>
            <select
              v-model="filters.time"
              class="inp-sel"
            >
              <option value="">
                {{ $t('daq.k1flttim016') }}
              </option>
              <option value="live">
                {{ $t('daq.k1timlv017') }}
              </option>
              <option value="hour">
                {{ $t('daq.k1timhr018') }}
              </option>
              <option value="day">
                {{ $t('daq.k1timdy019') }}
              </option>
              <option value="old">
                {{ $t('daq.k1timld020') }}
              </option>
              <option value="never">
                {{ $t('daq.k1timnv021') }}
              </option>
            </select>
          </label>
          <label class="flt">
            <span>{{ $t('daq.k1fltsrc022') }}</span>
            <input
              v-model="filters.search"
              class="inp-sel flt-search"
              type="search"
              :placeholder="$t('daq.k1fltsph023')"
            >
          </label>
          <button
            v-if="hasFilters"
            class="mini-btn clear-btn"
            @click="emit('clear-filters')"
          >
            {{ $t('daq.k1fygck2066') }}
          </button>
        </div>
        <span class="count mono">{{ filteredCount }} / {{ totalCount }} {{ $t('daq.k45uio067') }}</span>
      </div>
      <!-- 实时告警 + 实时事件:告警 = server 权威未确认报警(WS 直推/可确认);事件 = 全操作摘要轨(详情在日志管理) -->
      <div class="ops-panels">
        <div
          class="ops-panel alarm-panel"
          :class="{ live: alarms.length > 0 }"
        >
          <div class="panel-head">
            <span class="i-tabler-bell-ringing bell" />
            <b>{{ $t('daq.k1alarm141') }}</b>
            <span
              class="mono cnt"
              :class="{ hot: alarms.length > 0 }"
            >{{ alarms.length }}</span>
          </div>
          <div class="panel-body">
            <p
              v-if="alarms.length === 0"
              class="panel-empty"
            >
              {{ $t('daq.k1evt001') }}
            </p>
            <div
              v-for="a in alarms"
              v-else
              :key="a.id"
              class="alarm-row"
            >
              <span class="i-tabler-alert-triangle tri" />
              <b>{{ a.nodeName }}</b>
              <span class="mono dim">{{ a.metric }}</span>
              <span class="mono">{{ a.value }} {{ a.rule === 'lt-min' ? '<' : '>' }} {{ a.threshold }}</span>
              <small
                v-if="a.escalation > 0"
                class="esc mono"
              >+{{ a.escalation }}</small>
              <button
                class="mini-btn ack"
                @click="emit('ack', a.id)"
              >
                {{ $t('daq.k1ack142') }}
              </button>
            </div>
          </div>
        </div>
        <div class="ops-panel event-panel">
          <div class="panel-head">
            <span class="i-tabler-activity" />
            <b>{{ $t('daq.k1evt002') }}</b>
            <NuxtLink
              class="panel-link"
              to="/logs"
            >
              {{ $t('daq.k1evt003') }}<span class="i-tabler-arrow-right" />
            </NuxtLink>
          </div>
          <div class="panel-body">
            <p
              v-if="opsRecent.length === 0"
              class="panel-empty"
            >
              {{ $t('daq.k1evt004') }}
            </p>
            <div
              v-for="(r, i) in opsRecent"
              v-else
              :key="`${r.at}:${r.actor}:${r.action}:${i}`"
              class="evt-row"
            >
              <span class="mono dim t">{{ opsTime(r.at) }}</span>
              <span
                class="src-badge"
                :class="r.actorKind"
              >{{ r.actorKind === 'agent' ? 'Agent' : r.actorKind === 'user' ? $t('logs.src.user') : $t('logs.src.system') }}</span>
              <span
                class="kind-chip"
                :class="r.kind"
              >{{ opsKindLabel(r.kind) }}</span>
              <span
                class="txt"
                :title="r.summary"
              >{{ r.summary }}</span>
            </div>
          </div>
        </div>
      </div>
      <table
        ref="tableEl"
        class="nodes-table"
      >
        <thead>
          <tr>
            <th>{{ $t('daq.k45uio067') }}</th>
            <th>{{ $t('daq.k42w8s068') }}</th>
            <th>{{ $t('daq.k3mv305069') }}</th>
            <th>{{ $t('daq.k1trnd001') }}</th>
            <th>{{ $t('daq.k1l6g2ga070') }}</th>
            <th>{{ $t('daq.k3zi0nf071') }}</th>
            <th>{{ $t('daq.k4a0la072') }}</th>
            <th>{{ $t('daq.k3wj9n051') }}</th>
            <th :title="$t('daq.k1runtipc131')">
              {{ $t('daq.k1b2tkyv057') }}
            </th>
            <th :title="$t('daq.k1prdrtip132')">
              {{ $t('daq.k1prodrc128') }}
            </th>
            <th>{{ $t('daq.k1i8rtqt054') }}</th>
            <th class="right">
              {{ $t('daq.k40aa6073') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <!-- 上占位行:撑起"已滚过"的高度,让滚动条与真实全量列表一致 -->
          <tr
            v-if="padTopPx > 0"
            class="vs-pad"
            aria-hidden="true"
          >
            <td
              :colspan="11"
              :style="{ height: padTopPx + 'px' }"
            />
          </tr>
          <WorkshopDaqNodeRow
            v-for="n in visibleNodes"
            :key="n.id"
            :n="n"
          />
          <!-- 下占位行 -->
          <tr
            v-if="padBottomPx > 0"
            class="vs-pad"
            aria-hidden="true"
          >
            <td
              :colspan="11"
              :style="{ height: padBottomPx + 'px' }"
            />
          </tr>
          <tr v-if="loaded && totalCount === 0">
            <td colspan="11">
              <div
                class="pane-empty"
                style="min-height: 120px;"
              >
                <p class="pe-sub">
                  {{ $t('daq.kvhjyc3075') }}
                </p>
              </div>
            </td>
          </tr>
          <tr v-else-if="loaded && filteredCount === 0">
            <td colspan="11">
              <div
                class="pane-empty"
                style="min-height: 90px;"
              >
                <p class="pe-sub">
                  {{ $t('daq.k1w20qew076') }}
                </p>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </a-spin>
</template>
