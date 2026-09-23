<script setup lang="ts">
/**
 * 仪表盘产线清单 —— 运行中优先的产线卡栅格 + 余量聚合入口。
 * 纯呈现:清单已由页面派生并裁剪(最多 8 卡),组件只负责画。
 */
import type { DashboardFleetLine } from '@/app/pages/composables/useDashboardData'

defineProps<{
  /** 展示用清单(已按运行中 → 打标量排序并截断) */
  lines: DashboardFleetLine[]
  /** 全部产线数(面板头 meta 与空态判据都用它,不是展示条数) */
  total: number
  /** 清单外余量(>0 时出聚合入口卡) */
  overflow: number
}>()

const { t } = useI18n()
</script>

<template>
  <!-- 产线清单(运行中优先,最多 8 卡;余量聚合入口) -->
  <section class="fleet aw-bench aw-stagger">
    <header class="aw-bench-hd">
      <h3 class="aw-bench-title">
        {{ t('home.charts.lines') }}
      </h3>
      <small class="aw-bench-sub">{{ t('home.fleetHint') }}</small>
      <span class="aw-bench-meta">
        <span><b>{{ total }}</b></span>
      </span>
    </header>
    <div class="fleet-grid">
      <NuxtLink
        v-for="l in lines"
        :key="l.id"
        class="line-card"
        :class="{ on: l.active }"
        :style="{ '--lc': l.color }"
        :to="`/dcw/${l.id}`"
      >
        <div class="lc-head">
          <span class="lc-dot" />
          <b>{{ l.name }}</b>
          <span
            class="lc-state"
            :class="{ on: l.active }"
          >{{ l.active ? t('home.runNow') : t('home.standBy') }}</span>
        </div>
        <div
          v-if="l.active"
          class="lc-run mono"
        >
          <span>{{ l.product }} · {{ l.recipe }}</span>
          <small>{{ t('home.batch') }} {{ l.runId?.slice(0, 8) }} · {{ t('home.tagged') }} {{ l.tagged }}</small>
        </div>
        <div class="lc-meta mono">
          <span>{{ t('home.nodesUnit') }} {{ l.dcwCount }}</span>
          <span>{{ t('home.daqUnit') }} {{ l.daqCount }}</span>
        </div>
      </NuxtLink>
      <NuxtLink
        v-if="overflow > 0"
        class="line-card fleet-all im"
        to="/dcw"
      >
        <span class="fa-n mono">+{{ overflow }}</span>
        <span class="fa-label">{{ t('home.fleetAll') }}</span>
        <span class="i-tabler-arrow-right fa-arrow" />
      </NuxtLink>
      <p
        v-if="total === 0"
        class="fleet-empty"
      >
        {{ t('home.noLine') }}
      </p>
    </div>
  </section>
</template>

<style scoped>
/* ---------- 产线清单(基座 = aw-bench) ---------- */
.fleet { margin-bottom: var(--gap-block); }
.fleet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.line-card {
  padding: 13px 15px;
  cursor: pointer;
  background: var(--frost-bg);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel-sm);
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast),
    transform var(--transition-base),
    box-shadow var(--transition-base);
}
@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  .line-card:hover {
    border-color: var(--lc, var(--accent));
    transform: translateY(-1px);
    box-shadow: var(--glass-edge), var(--shadow-float);
  }
}
.line-card.on {
  background: color-mix(in srgb, var(--lc) 7%, var(--paper-deep));
  border-color: color-mix(in srgb, var(--lc) 45%, transparent);
}
.lc-head {
  display: flex;
  gap: 8px;
  align-items: center;
}
.lc-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border: 1.5px solid var(--lc);
  border-radius: 50%;
}
.line-card.on .lc-dot {
  background: var(--lc);
  box-shadow: 0 0 7px color-mix(in srgb, var(--lc) 70%, transparent);
}
.lc-head b { font-size: 13px; color: var(--ink); }
.lc-state {
  margin-left: auto;
  padding: 1px 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.05em;
  color: var(--ink-faint);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}
.lc-state.on {
  color: var(--tone-success-dot);
  border-color: color-mix(in srgb, var(--tone-success-dot) 45%, transparent);
}
.lc-run {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
  font-size: 11.5px;
  color: color-mix(in srgb, var(--lc) 70%, var(--ink));
}
.lc-run small { font-size: 10px; color: var(--ink-faint); }
.lc-meta {
  display: flex;
  gap: 14px;
  margin-top: 9px;
  padding-top: 8px;
  font-size: 10.5px;
  color: var(--ink-faint);
  border-top: 1px solid var(--divider-hair);
}

/* 手持档字号地板:本页所有"铭牌级"微字(引擎命令名、产线状态、产线指标行、
   跳转箭头)统一抬到 11.5px。它们在桌面是仪器铭牌语言,在手机上就是读不了的小字。
   ⚠️ 此块与 DashboardHarnessPanel 的 scoped 块有意重复:同一条"页面级字号地板"
   同时管住两个组件的微字,scoped 样式无法共享,只能逐字复制到各自组件
   (改一处必须同步另一处;落在这里的引擎选择器在本组件内是空转,刻意保留原文以便对照)。 */
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
/* 全部产线入口:虚线幽灵卡,聚合清单外的余量 */
.fleet-all {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  min-height: 86px;
  color: var(--ink-faint);
  background: transparent;
  border-style: dashed;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.fleet-all:hover {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}
.fa-n {
  font-size: 22px;
  line-height: 1;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.fleet-all:hover .fa-n { color: var(--accent); }
.fa-label { font-size: 12px; }
.fa-arrow {
  font-size: 15px;
  transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.fleet-all:hover .fa-arrow { transform: translateX(3px); }
.fleet-empty {
  padding: 18px 0;
  font-size: 12px;
  color: var(--ink-faint);
  text-align: center;
}

/* 面板题注:一句话说明这张图在看什么;窄屏让位给读数本身
   ⚠️ 与 DashboardHarnessPanel / DashboardTrendPanel 的 scoped 块有意重复(同上)。 */
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
</style>
