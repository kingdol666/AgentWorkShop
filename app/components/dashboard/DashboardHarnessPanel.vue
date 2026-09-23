<script setup lang="ts">
/**
 * 仪表盘执行引擎可用性条 —— Harness CLI 环境探测结果清单。
 * 纯呈现:探测结果由页面下发(服务端 30s 缓存,随 5s 兜底节拍刷新);
 * 未安装的引擎灰化,带 homepage 的可跳文档(派工前强校验的另一处出口)。
 */
import type { HarnessMetaDto } from '~/composables/workshop/useWorkshopApi'

defineProps<{
  harnesses: HarnessMetaDto[]
  /** 可用引擎数(面板头 x/y 的分子) */
  okCount: number
}>()

const { t } = useI18n()

/** 已知引擎的服务端 label 前端译名(服务端 label 是中文数据,展示层按 id 映射) */
const harnessLabel = (h: HarnessMetaDto): string => {
  if (h.id === 'mock') return t('agents.hMock')
  if (h.id === 'omp') return t('agents.hOmp')
  return h.label
}
/**
 * 引擎卡片第二行的命令名。
 * 返回空串表示"这一行没有新信息":标签已经以命令名开头时
 * (omp(真实 LLM) / omp、opencode / opencode、codex / codex…),
 * 再写一遍只是把同一件事讲两遍 —— 实测 14 张卡里有 9 张是重复的。
 * 真正有信息量的只有:不可用状态、in-process、以及与标签不同的真实二进制名。
 */
const harnessCmd = (h: HarnessMetaDto): string => {
  if (h.available === false) return t('home.harness.missing')
  if (h.inprocess) return 'in-process'
  const cmd = String(h.command ?? '')
  if (!cmd) return ''
  return h.label.startsWith(cmd) ? '' : cmd
}
</script>

<template>
  <section class="harness aw-bench aw-stagger">
    <header class="aw-bench-hd">
      <h3 class="aw-bench-title">
        {{ t('home.harness.title') }}
      </h3>
      <small class="aw-bench-sub">{{ t('home.harness.sub') }}</small>
      <span class="aw-bench-meta">
        <span><b>{{ okCount }}</b>/{{ harnesses.length }}</span>
      </span>
    </header>
    <div class="harness-row">
      <a
        v-for="h in harnesses"
        :key="h.id"
        class="h-item"
        :class="{ off: h.available === false, link: h.available === false && h.homepage }"
        :href="h.available === false && h.homepage ? h.homepage : undefined"
        target="_blank"
        rel="noopener"
        :title="h.available === false ? (h.error ?? '') : (h.resolvedPath ?? h.command ?? '')"
      >
        <span class="h-dot" />
        <span class="h-name">{{ harnessLabel(h) }}</span>
        <span
          v-if="harnessCmd(h)"
          class="h-cmd mono"
        >{{ harnessCmd(h) }}</span>
        <span
          v-if="h.available === false && h.homepage"
          class="h-go"
        >↗</span>
      </a>
    </div>
  </section>
</template>

<style scoped>
/* 面板题注:一句话说明这张图在看什么;窄屏让位给读数本身
   ⚠️ 此规则与 DashboardTrendPanel / DashboardFleetPanel 的 scoped 块有意重复:
   scoped 样式必须与消费它的标记同处一个组件,不能外移成公共 css(逐字复制,改一处同步三处)。 */
.aw-bench-sub {
  overflow: hidden;
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 1500px) {
  .aw-bench-sub { display: none; }
}
/* ---------- Harness 可用性条:墨色药丸式引擎清单,未安装灰化 ---------- */
.harness {
  margin-bottom: var(--gap-block);
}
.harness-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 2px 0 4px;
}
.h-item {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 5px 12px;
  font-size: 11.5px;
  cursor: default;
  background: color-mix(in srgb, var(--ink) 3%, transparent);
  border: 1px solid var(--divider-hair);
  border-radius: var(--radius-pill);
  transition: border-color 0.15s, background 0.15s;
}
.h-item:hover { border-color: var(--line-strong); }
.h-item.link { cursor: pointer; }
.h-item.link:hover { border-color: var(--accent); color: var(--accent); }
.h-go { flex: none; font-size: 10px; color: var(--ink-faint); }
.h-item.link:hover .h-go { color: var(--accent); }
.h-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tone-success-dot, #4a6b57);
}
.h-item.off { opacity: 0.55; }
.h-item.off .h-dot { background: var(--tone-danger-dot, #c25a4e); }
.h-name { font-weight: 600; color: var(--ink); }
.h-item.off .h-name { color: var(--ink-soft); }
/* 引擎命令名是"铭牌"级信息:桌面 10px 尚可,手持档必须让位给可读性
   * (实测 / 在 390 下稳定报出 54 条 <11px,全部来自这里与 .aw-gauge-label) */
.h-cmd { font-size: 10px; color: var(--ink-faint); }

/* 手持档字号地板:本页所有"铭牌级"微字(引擎命令名、产线状态、产线指标行、
   跳转箭头)统一抬到 11.5px。它们在桌面是仪器铭牌语言,在手机上就是读不了的小字。
   ⚠️ 此块与 DashboardFleetPanel 的 scoped 块有意重复:同一条"页面级字号地板"
   同时管住两个组件的微字,scoped 样式无法共享,只能逐字复制到各自组件
   (改一处必须同步另一处;落在这里的产线选择器在本组件内是空转,刻意保留原文以便对照)。 */
@media (max-width: 900px) {
  .h-cmd,
  .h-go,
  .lc-state,
  .lc-run small,
  .lc-meta,
  .lc-meta span,
  .fleet-all small {
    font-size: 11.5px;
  }
}
</style>
