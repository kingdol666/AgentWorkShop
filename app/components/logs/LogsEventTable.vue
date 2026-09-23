<script setup lang="ts">
/**
 * 查询结果表:时间/来源/操作者/分类/摘要/归属维度/详情 + 详情行内展开。
 *
 * 行数据是页面持有的 REST 快照,展开态也由页面持有(查询即收起,故不能是组件内部状态)。
 * 归属维度文案与显示格式化走页面私有 composable,与筛选区同一套名称回填口径。
 */
import type { OpsLogRow } from '@/app/composables/workshop/useOpsLog'
import { useLogsFormat } from '@/app/pages/logs/composables/useLogsFormat'
import { useLogsScope } from '@/app/pages/logs/composables/useLogsScope'

defineProps<{
  /** 查询结果快照(REST;与 WS 实时轨互不干扰) */
  rows: OpsLogRow[]
  /** 当前展开详情的行 id(null = 全部收起) */
  expandedId: number | null
  /** 结果集查询中(空态显示"加载中") */
  loading: boolean
  /** 查询失败信息(空串 = 无错误) */
  error: string
}>()

defineEmits<{
  toggle: [row: OpsLogRow]
}>()

const { hasDetail, pretty, fmtTime, srcLabel, kindLabel } = useLogsFormat()
const { lineName, productName, recipeName } = useLogsScope()
</script>

<template>
  <!-- 结果表:时间/来源/操作者/分类/摘要/归属维度/详情 -->
  <section class="table-card">
    <p
      v-if="error"
      class="err"
    >
      {{ error }}
    </p>
    <table class="log-table">
      <thead>
        <tr>
          <th class="th-time">
            {{ $t('logs.thTime') }}
          </th>
          <th class="th-src">
            {{ $t('logs.fSource') }}
          </th>
          <th>{{ $t('logs.thActor') }}</th>
          <th class="th-kind">
            {{ $t('logs.fKind') }}
          </th>
          <th>{{ $t('logs.thSummary') }}</th>
          <th class="th-scope">
            {{ $t('logs.thScope') }}
          </th>
          <th class="th-detail">
            {{ $t('logs.thDetail') }}
          </th>
        </tr>
      </thead>
      <tbody>
        <template
          v-for="row in rows"
          :key="row.id"
        >
          <tr>
            <td class="mono dim">
              {{ fmtTime(row.at) }}
            </td>
            <td>
              <span
                class="src-badge"
                :class="row.actorKind"
              >{{ srcLabel(row.actorKind) }}</span>
            </td>
            <td class="actor">
              {{ row.actorName || row.actor || '—' }}
            </td>
            <td>
              <span
                class="kind-chip"
                :class="row.kind"
              >{{ kindLabel(row.kind) }}</span>
            </td>
            <td class="summary">
              {{ row.summary }}
              <small class="mono dim action">{{ row.action }}</small>
            </td>
            <td class="scope">
              <span
                v-if="lineName(row.lineId)"
                class="scope-chip"
                :title="$t('logs.fLine')"
              >{{ lineName(row.lineId) }}</span>
              <span
                v-if="productName(row.productId)"
                class="scope-chip"
                :title="$t('logs.fProduct')"
              >{{ productName(row.productId) }}</span>
              <span
                v-if="recipeName(row.recipeId)"
                class="scope-chip"
                :title="'Recipe'"
              >{{ recipeName(row.recipeId) }}</span>
              <span
                v-if="!row.lineId && !row.productId && !row.recipeId"
                class="dim"
              >—</span>
            </td>
            <td class="detail-cell">
              <button
                v-if="hasDetail(row)"
                class="mini-btn"
                @click="$emit('toggle', row)"
              >
                {{ expandedId === row.id ? $t('logs.fold') : $t('logs.expand') }}
              </button>
              <span
                v-else
                class="dim"
              >{{ $t('logs.noDetail') }}</span>
            </td>
          </tr>
          <!-- 详情行内展开:紧贴事件行,点击即见(不再沉到表尾) -->
          <tr
            v-if="expandedId === row.id"
            class="log-detail-row"
          >
            <td
              colspan="7"
              class="detail-td"
            >
              <pre class="detail-box mono">{{ pretty(row.detailJson) }}</pre>
            </td>
          </tr>
        </template>
        <tr class="log-empty-row">
          <td
            v-if="rows.length === 0"
            colspan="7"
            class="empty"
          >
            <template v-if="loading">
              {{ $t('logs.loading') }}
            </template>
            <template v-else>
              {{ $t('logs.empty') }}
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.table-card {
  background: var(--surface-glass);
  border: 1px solid var(--glass-line);
  border-radius: 10px;
  overflow: hidden;
  backdrop-filter: var(--aurora-blur) saturate(1.15);
}
/* 错误条:人工记录弹窗内的同名规则是逐字复制(样式随标记走,不抽公共 css) */
.err { margin: 0; padding: 8px 14px; font-size: 13px; color: var(--tone-danger-dot); }
.log-table { width: 100%; font-size: 13px; border-collapse: collapse; }
.log-table th {
  position: sticky; top: 0; z-index: 1;
  padding: 8px 10px; text-align: left; font-weight: 600; color: var(--ink-soft);
  background: var(--frost-bg);
  border-bottom: 1px solid var(--glass-line);
}
.log-table td {
  max-width: 380px; padding: 7px 10px; color: var(--ink-soft);
  border-bottom: 1px solid color-mix(in srgb, var(--glass-line) 55%, transparent);
  vertical-align: top;
}
.th-time, .th-src, .th-kind { white-space: nowrap; }
.th-detail { width: 72px; }
.actor { white-space: nowrap; }
.summary .action { display: block; font-size: 11.5px; color: var(--ink-faint); }
.scope { display: flex; flex-wrap: wrap; gap: 4px; max-width: 220px; }
.scope-chip {
  padding: 1px 7px; font-size: 11.5px; color: var(--ink-soft);
  background: var(--frost-bg); border-radius: 99px; white-space: nowrap;
}
.detail-cell { white-space: nowrap; }
.empty { padding: 22px 0 !important; color: var(--ink-faint); text-align: center; }
/* 详情行内展开:紧贴事件行的整行 pre 面板 */
.detail-td { padding: 0 !important; }
.detail-box {
  max-height: 260px; margin: 0; padding: 10px 14px; overflow: auto;
  font-size: 12.5px; color: var(--ink-soft); white-space: pre-wrap; word-break: break-word;
  background: var(--paper-deep); border-top: 1px solid var(--glass-line);
}
.src-badge {
  display: inline-block; padding: 1px 8px; font-size: 11.5px;
  border: 1px solid var(--glass-line); border-radius: 99px; color: var(--ink-faint);
}
.src-badge.agent { color: var(--tone-info-dot); border-color: color-mix(in srgb, var(--tone-info-dot) 40%, transparent); }
.src-badge.user { color: var(--tone-success-dot); border-color: color-mix(in srgb, var(--tone-success-dot) 40%, transparent); }
.kind-chip {
  display: inline-block; padding: 1px 7px; font-size: 11.5px;
  color: var(--ink-soft); background: var(--frost-bg); border-radius: 5px; white-space: nowrap;
}
.kind-chip.alarm { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.kind-chip.write { color: var(--tone-info-dot); }
.kind-chip.rollback { color: var(--tone-warning-dot); }
.kind-chip.manual { color: var(--tone-success-dot); }

/* ══ 窄屏(≤899px):7 列表格在 375px 上被卡片裁掉四列(实测只剩"时间/来源/操作者"),
   每行高达 154px,字号被压到 10px。窄屏不再横向拖动"账页",
   而是把每行折成一张事件卡 —— 三段堆叠,一条日志一眼读完:
     ① 时间戳 · 来源徽标 · 分类 chip · [展开]
     ② 消息摘要(整行,可换行,13px)
     ③ 操作者 + 归属维度(产线/产品/Recipe)
   表格语义(thead)在窄屏隐藏,列身份由"位置 + chip 颜色"承担。 */
@media (max-width: 899px) {
  .log-table {
    display: block;
    font-size: 13px;
  }

  .log-table thead {
    display: none;
  }

  .log-table tbody {
    display: block;
  }

  .log-table tr {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--glass-line) 55%, transparent);
  }

  .log-table td {
    display: block;
    max-width: 100%;
    padding: 0;
    border-bottom: 0;
  }

  .log-table td.mono.dim {
    order: 1;
    font-size: 11.5px;
  }

  .log-table td:nth-child(2) { order: 2; }

  .log-table td:nth-child(4) { order: 3; }

  .log-table td.actor {
    order: 4;
    font-size: 11.5px;
    color: var(--ink-faint);
  }

  .log-table td.detail-cell {
    order: 5;
    margin-left: auto;
    white-space: normal;
  }

  .log-table td.summary {
    order: 6;
    flex: 1 1 100%;
    font-size: 13px;
    line-height: 1.5;
  }

  .log-table td.scope {
    order: 7;
    flex: 1 1 100%;
    max-width: 100%;
  }

  /* 详情行 / 空态行不参与"事件卡"排布 */
  .log-table tr.log-detail-row {
    display: block;
    padding: 0;
  }

  .log-table tr.log-detail-row td {
    display: block;
  }

  .log-table tr.log-empty-row td,
  .log-table td.empty {
    flex: 1 1 100%;
    width: 100%;
    text-align: center;
  }

  /* 手指命中区:表格内的 mini-btn 原始高度只有 ~24px。
     同一组声明(原页面 scoped 块 @media 899 内)按"样式随标记走"的约束
     逐字复制进需要它的每个组件 —— 此处与 LogsPageHead/LogsFilterCard/LogsManualModal
     的对应块是有意重复,不要合并成公共 css。 */
  .log-table .mini-btn {
    min-height: 40px;
    padding: 8px 14px;
  }
}
</style>
