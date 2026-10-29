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

const props = defineProps<{
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

/** 详情 JSON 一键复制(事故报告/工单附件);失败降级选中文本,不再弹层 */
const copiedId = ref<number | null>(null)
async function copyDetail(row: OpsLogRow): Promise<void> {
  try {
    await navigator.clipboard.writeText(pretty(row.detailJson))
    copiedId.value = row.id
    setTimeout(() => {
      if (copiedId.value === row.id) copiedId.value = null
    }, 1600)
  }
  catch { /* 剪贴板不可用(非安全上下文):静默降级,用户仍可手动选择文本 */ }
}

/* 审计账页分页:服务端一次给到 300 条快照,整表直出会形成 2 万像素的
 * 单页文档(实测 scrollHeight=22009),滚动定位与详情展开都失去参照。
 * 25 条/页是扫描密度与翻页成本的折中;换筛选/新查询时回到第 1 页。 */
const PAGE_SIZE = 25
const page = ref(1)
const pagedRows = computed(() =>
  props.rows.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
)
watch(() => props.rows, () => {
  page.value = 1
})
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
          v-for="row in pagedRows"
          :key="row.id"
        >
          <tr
            :class="{ 'is-error': row.level === 'error', 'is-warn': row.level === 'warn' }"
          >
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
              <span
                v-if="row.level === 'error' || row.level === 'warn'"
                class="level-chip"
                :class="row.level"
              >{{ row.level.toUpperCase() }}</span>
              {{ row.summary }}
              <small class="mono dim action">{{ row.action }}</small>
            </td>
            <td class="scope">
              <!-- 名称缺失(产线/配方已删除)时回落到短 id:归属维度不能因为目录缺失而消失 -->
              <span
                v-if="row.lineId"
                class="scope-chip"
                :title="`${$t('logs.fLine')} ${row.lineId}`"
              >{{ lineName(row.lineId) || row.lineId.slice(0, 8) }}</span>
              <span
                v-if="row.productId"
                class="scope-chip"
                :title="`${$t('logs.fProduct')} ${row.productId}`"
              >{{ productName(row.productId) || row.productId.slice(0, 8) }}</span>
              <span
                v-if="row.recipeId"
                class="scope-chip"
                :title="`Recipe ${row.recipeId}`"
              >{{ recipeName(row.recipeId) || row.recipeId.slice(0, 8) }}</span>
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
          <!-- 详情行内展开:紧贴事件行,点击即见(不再沉到表尾);error/warn 行附一键复制 -->
          <tr
            v-if="expandedId === row.id"
            class="log-detail-row"
          >
            <td
              colspan="7"
              class="detail-td"
            >
              <div class="detail-bar">
                <button
                  class="mini-btn"
                  @click="copyDetail(row)"
                >
                  <span :class="copiedId === row.id ? 'i-tabler-check' : 'i-tabler-copy'" />
                  {{ copiedId === row.id ? $t('logs.copied') : $t('logs.copyDetail') }}
                </button>
              </div>
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

    <div
      v-if="rows.length > 0"
      class="table-foot"
    >
      <span class="log-total">{{ $t('logs.totalCount', { n: rows.length }) }}</span>
      <a-pagination
        v-model:current="page"
        :page-size="PAGE_SIZE"
        :total="rows.length"
        :show-size-changer="false"
        :show-less-items="true"
        size="small"
      />
    </div>
  </section>
</template>

<style scoped>
.table-card {
  background: var(--surface-card);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  overflow: hidden;
}
/* 错误条:人工记录弹窗内的同名规则是逐字复制(样式随标记走,不抽公共 css) */
.err { margin: 0; padding: 8px 14px; font-size: 13px; color: var(--tone-danger-dot); }
.log-table { width: 100%; font-size: 13px; border-collapse: collapse; }
.log-table th {
  position: sticky; top: 0; z-index: 1;
  padding: 9px 12px; text-align: left; font-size: 11px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint);
  background: var(--paper-deep);
  border-bottom: 1px solid var(--line-strong);
}
.log-table td {
  max-width: 380px; padding: 8px 12px; color: var(--ink-soft);
  border-bottom: 1px solid var(--divider-hair);
  vertical-align: top;
}
.log-table tbody tr:hover td { background: var(--hover-tint); }
/* 错误/警告行整行着色(生产落地:扫一眼即见故障分布,不用逐行找红标) */
.log-table tbody tr.is-error td { background: color-mix(in srgb, var(--tone-danger-dot) 7%, transparent); }
.log-table tbody tr.is-warn td { background: color-mix(in srgb, var(--tone-warning-dot) 7%, transparent); }
.log-table tbody tr.is-error:hover td { background: color-mix(in srgb, var(--tone-danger-dot) 12%, transparent); }
.log-table tbody tr.is-warn:hover td { background: color-mix(in srgb, var(--tone-warning-dot) 12%, transparent); }
.th-time, .th-src, .th-kind { white-space: nowrap; }
.th-detail { width: 72px; }
.actor { white-space: nowrap; }
/* 动作码跟在摘要后(同一行),不再独占一行把每行撑到 90px */
.summary .action {
  display: inline-block;
  margin-left: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-faint);
}
.scope { display: flex; flex-wrap: wrap; gap: 4px; max-width: 220px; }
.scope-chip {
  padding: 1px 7px; font-size: 11.5px; color: var(--ink-soft);
  background: var(--paper-deep); border-radius: var(--radius-chip); white-space: nowrap;
}
.detail-cell { white-space: nowrap; }
.empty { padding: 22px 0 !important; color: var(--ink-faint); text-align: center; }
/* 账页页脚:总数 + 分页(固定 50 条/页,长账页不再拉成两万像素) */
.table-foot {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-top: 1px solid var(--divider-hair);
}
.log-total {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
}
/* 详情行内展开:紧贴事件行的整行 pre 面板;顶栏放复制等行内动作 */
.detail-td { padding: 0 !important; }
.detail-bar {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 6px 10px 0;
}
.detail-box {
  max-height: 260px; margin: 0; padding: 10px 14px; overflow: auto;
  font-size: 12.5px; color: var(--ink-soft); white-space: pre-wrap; word-break: break-word;
  background: var(--paper-deep); border-top: 1px solid var(--line);
}
.src-badge {
  display: inline-block; padding: 1px 8px; font-size: 11.5px;
  border: 1px solid var(--line); border-radius: var(--radius-chip); color: var(--ink-faint);
}
.src-badge.agent { color: var(--tone-info-dot); border-color: color-mix(in srgb, var(--tone-info-dot) 40%, transparent); }
.src-badge.user { color: var(--tone-success-dot); border-color: color-mix(in srgb, var(--tone-success-dot) 40%, transparent); }
.kind-chip {
  display: inline-block; padding: 1px 7px; font-size: 11.5px;
  color: var(--ink-soft); background: var(--paper-deep); border-radius: var(--radius-chip); white-space: nowrap;
}
.kind-chip.alarm { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.kind-chip.write { color: var(--tone-info-dot); }
.kind-chip.rollback { color: var(--tone-warning-dot); }
.kind-chip.manual { color: var(--tone-success-dot); }
/* 严重级徽标(2026-10-08 ACK 鉴定):error=写入失败 红;warn=仅链路受理未证实 黄 */
.level-chip {
  display: inline-block; padding: 1px 7px; margin-right: 6px; font-size: 11px;
  border-radius: 5px; white-space: nowrap;
}
.level-chip.error { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.level-chip.warn { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }

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
