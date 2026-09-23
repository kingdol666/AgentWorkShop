<script setup lang="ts">
/**
 * 概要统计:Channels / Agents / 存活进程(含孤儿)/ 服务进程(PID + 运行时长 + 快照时间)。
 *
 * 纯呈现:四个读数全部由页面从唯一快照切片下发,组件不取数、不订阅。
 */
import type { MonitorSnapshot } from '@/app/pages/monitor/types'
import { useMonitorFormat } from '@/app/pages/monitor/composables/useMonitorFormat'

defineProps<{
  /** 概要计数(快照未到位为 undefined,卡片显示 '–') */
  counts?: MonitorSnapshot['counts']
  serverPid?: number
  uptimeMs?: number
  /** 服务端快照生成时刻(ISO) */
  generatedAt?: string
  /** 本地"最后更新时刻"(页面每次轮询成功后写入) */
  lastUpdated: string
}>()

const { t } = useI18n()
const { uptimeText } = useMonitorFormat()
</script>

<template>
  <!-- 概要统计(CSS grid:antd Grid 样式在部分构建下缺失,col 会退化 100% 宽) -->
  <div class="stat-grid">
    <a-card class="aw-panel stat">
      <p class="stat-label">
        {{ t('monitor.channels') }}
      </p>
      <p class="stat-value aw-mono">
        {{ counts?.channels ?? '–' }}
      </p>
    </a-card>
    <a-card class="aw-panel stat">
      <p class="stat-label">
        {{ t('monitor.agents') }}
      </p>
      <p class="stat-value aw-mono">
        {{ counts?.agents ?? '–' }}
      </p>
    </a-card>
    <a-card class="aw-panel stat">
      <p class="stat-label">
        {{ t('monitor.aliveProcesses') }}
      </p>
      <p class="stat-value aw-mono">
        {{ counts?.aliveProcesses ?? '–' }}
        <span
          v-if="(counts?.orphanProcesses ?? 0) > 0"
          class="orphan-badge"
        >
          +{{ counts?.orphanProcesses }} {{ t('monitor.orphan') }}
        </span>
      </p>
    </a-card>
    <a-card class="aw-panel stat">
      <p class="stat-label">
        {{ t('monitor.server') }}
      </p>
      <p class="stat-value aw-mono small">
        PID {{ serverPid ?? '–' }} · {{ uptimeMs === undefined ? '' : uptimeText(uptimeMs) }}
      </p>
      <p class="stat-updated">
        {{ lastUpdated }} · {{ t('monitor.updated') }} {{ generatedAt ?? '' }}
      </p>
    </a-card>
  </div>
</template>

<style scoped>
/* 前三张是"一个数"的量规;第四张「服务进程」内容是 PID + 时长 + ISO 快照时间,
 * 等宽 4 列时它只有 ~200px,文案折成三行(实测 1440)。给它两列 ——
 * 列宽按**内容长度**分,不是按卡片数量平均分。 */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 16px;
}

.stat-grid > :last-child {
  grid-column: span 2;
}

@media (max-width: 1100px) {
  .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* 窄屏两列:前三张是"一个数"的量规(标签 + 大字),单列会让每张卡
 * 占掉 ~150px 高、四张卡吃掉整整一屏(实测)。第四张「服务进程」内容是长字符串,
 * 让它独自跨两列 —— 这是按**内容**分的列,不是按数量硬凑。 */
@media (max-width: 640px) {
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .stat-grid > :last-child { grid-column: 1 / -1; }
}

.stat {
  height: 100%;
}

.stat-label {
  margin: 0 0 6px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

.stat-value {
  margin: 0;
  font-size: 30px;
  font-weight: 590;
  line-height: 1.1;
}

.stat-value.small {
  font-size: 17px;
}

/* 实测:opacity 0.6 会把 11px 的说明文字压到 4.5:1 之下,
   改为直接使用 ink-faint(两套主题实测均 ≥5.4:1),不再靠透明度降级。 */
.stat-updated {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--ink-faint);
  overflow-wrap: anywhere;
}

.orphan-badge {
  margin-left: 6px;
  padding: 1px 6px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--tone-warning-dot);
  background: rgb(250 140 22 / 12%);
  border-radius: var(--radius-chip);
}

.small {
  font-size: 12.5px;
}

/* 面板间距:四张概要卡在本组件模板里互为相邻兄弟,故规则随标记搬到这里。
   与页面(三张表卡片之间)、MonitorProcessTable 的同类规则是**有意重复**,
   改一处同步所有副本 —— 样式随标记走,不抽公共 css。 */
.aw-panel + .aw-panel {
  margin-top: 16px;
}

/* ══ 窄屏(≤899px)═══════════════════════════════════════════════════════
   概要卡在 ≤640 已是单列(见上方 .stat-grid);这里只处理行内文字的收边:
   说明句长(时间 + 版本)在 375px 会顶到卡片右缘,允许它断行。 */
@media (max-width: 899px) {
  .stat-updated {
    line-height: 1.5;
  }
}
</style>
