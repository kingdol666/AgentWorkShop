<script setup lang="ts">
/**
 * 日志页页头:aw-page-head 规范(kicker + 大标题 + 描述)+ 实时轨计数 + 错误/告警快捷筛选 + 导出 + 手动记录入口。
 * 计数取自 WS 实时轨(ops.log 帧的环形缓冲),与结果表的 REST 快照互不干扰。
 * 快捷 chip 点击 → 页面把 level 筛选设为对应级并重查(再次点击同级 = 取消);
 * 导出按钮 → 页面把当前 REST 快照导出为 CSV(事故报告/工单附件的最低成本形态)。
 * 手动记录只上报点击,弹窗开合与提交由页面持有(页头不持有任何状态)。
 */
const props = defineProps<{
  /** 实时轨当前条数(useOpsLog.recent) */
  recentCount: number
  /** 实时轨 error 级条数(红色醒目;点击即筛 error) */
  errorCount: number
  /** 实时轨 warn 级条数 */
  warnCount: number
  /** 当前 level 筛选(空串 = 未筛选;chip 高亮与之联动) */
  activeLevel: string
  /** 导出中(结果集为空时禁用) */
  canExport: boolean
}>()

defineEmits<{
  manual: []
  /** 快捷级别筛选(error/warn;再次点击同级取消) */
  quick: [level: string]
  export: []
}>()

const isActive = (level: string) => props.activeLevel === level
</script>

<template>
  <!-- 页头(aw-page-head 规范:kicker + 大标题 + 描述)+ 快捷筛选 + 手动记录入口 -->
  <header class="aw-page-head">
    <div>
      <p class="aw-kicker">
        agentworkshop / audit log
      </p>
      <h1>{{ $t('logs.title') }}</h1>
      <p class="sub">
        {{ $t('logs.sub') }}
      </p>
    </div>
    <div class="head-actions">
      <span
        class="live-dot"
        :title="$t('logs.liveHint')"
      /><span class="live-txt mono">{{ $t('logs.live') }} {{ recentCount }}</span>
      <button
        class="chip quick-err"
        :class="{ on: isActive('error') }"
        :title="$t('logs.quickErrHint')"
        @click="$emit('quick', 'error')"
      >
        <span class="i-tabler-alert-octagon" />ERROR {{ errorCount }}
      </button>
      <button
        class="chip quick-warn"
        :class="{ on: isActive('warn') }"
        :title="$t('logs.quickWarnHint')"
        @click="$emit('quick', 'warn')"
      >
        <span class="i-tabler-alert-triangle" />WARN {{ warnCount }}
      </button>
      <button
        class="pill-btn"
        :disabled="!canExport"
        :title="$t('logs.exportHint')"
        @click="$emit('export')"
      >
        <span class="i-tabler-download" />
        {{ $t('logs.export') }}
      </button>
      <button
        class="pill-btn"
        @click="$emit('manual')"
      >
        <span class="i-tabler-plus" />
        {{ $t('logs.manual') }}
      </button>
    </div>
  </header>
</template>

<style scoped>
.head-actions { display: flex; gap: 10px; align-items: center; padding-bottom: 4px; flex-wrap: wrap; }
.sub { margin: 8px 0 0; font-size: 13px; color: var(--ink-faint); }
.live-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--tone-success-dot);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone-success-dot) 45%, transparent);
  animation: livePulse 2s ease-out infinite;
}
@keyframes livePulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone-success-dot) 45%, transparent); }
  70% { box-shadow: 0 0 0 8px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.live-txt { font-size: 11.5px; color: var(--ink-faint); }
/* 错误/告警快捷筛选 chip:实时轨计数 + 点击即筛;选中态填充对应级别的警示色 */
.chip {
  display: inline-flex; gap: 5px; align-items: center;
  padding: 3px 10px; font-size: 11.5px; font-family: var(--font-mono);
  border: 1px solid var(--glass-line); border-radius: var(--radius-chip);
  color: var(--ink-faint); background: var(--frost-bg); cursor: pointer;
}
.quick-err { color: var(--tone-danger-dot); border-color: color-mix(in srgb, var(--tone-danger-dot) 38%, transparent); }
.quick-warn { color: var(--tone-warning-dot); border-color: color-mix(in srgb, var(--tone-warning-dot) 38%, transparent); }
.quick-err.on { background: var(--tone-danger-bg); }
.quick-warn.on { background: var(--tone-warning-bg); }

@media (max-width: 899px) {
  /* 手指命中区:表格内的 mini-btn 原始高度只有 ~24px。
     同一组声明(原页面 scoped 块 @media 899 内)按"样式随标记走"的约束
     逐字复制进需要它的每个组件 —— 此处与 LogsEventTable/LogsFilterCard/LogsManualModal
     的对应块是有意重复,不要合并成公共 css。 */
  .head-actions .pill-btn, .head-actions .chip {
    min-height: 40px;
    padding: 8px 14px;
  }
}
</style>
