<script setup lang="ts">
/**
 * 网关总控条 —— 控制器全局启停 + 在线节点/写总量/写失败量 + 模板与添加节点入口。
 * 指标由页面下发(server 权威),动作一律回抛页面。
 */
defineProps<{
  running: boolean
  nodesOnline: number
  nodesTotal: number
  writesTotal: number
  writesFailed: number
}>()

const emit = defineEmits<{
  'toggle': [action: 'pause' | 'resume']
  'open-templates': []
  'open-add': []
}>()
</script>

<template>
  <section class="aw-tile ctrl-card">
    <div class="ctrl-left">
      <button
        class="aw-pill"
        :class="{ running: running }"
        :title="$t('dcwDetail.k1snap154')"
        @click="emit('toggle', running ? 'pause' : 'resume')"
      >
        <span :class="running ? 'i-tabler-player-pause' : 'i-tabler-player-play'" />
        {{ running ? $t('dcwDetail.kplrsg153') : $t('dcwDetail.knxgni9169') }}
      </button>
    </div>
    <div class="ctrl-right">
      <span class="ctrl-metrics mono">
        <span>{{ $t('dcwDetail.k45uio082') }} {{ nodesOnline }}/{{ nodesTotal }}</span>
        <span class="sep">·</span>
        <span :title="$t('dcwDetail.kd3ygmn001')">{{ $t('dcwDetail.k3wtib138') }} {{ writesTotal }}</span>
        <span class="sep">·</span>
        <span
          :class="{ warn: writesFailed > 0 }"
          :title="$t('dcwDetail.kd3znl0002')"
        >{{ $t('dcwDetail.k3yit7139') }} {{ writesFailed }}</span>
      </span>
      <button
        class="aw-pill outline"
        :title="$t('dcwDetail.kc4ixly003')"
        @click="emit('open-templates')"
      >
        <span class="i-tabler-template" />
        {{ $t('dcwDetail.k1972dx9020') }}
      </button>
      <button
        class="aw-pill add-btn"
        @click="emit('open-add')"
      >
        <span class="i-tabler-plus" />
        {{ $t('dcwDetail.k1976uns021') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/.modal-mask/.banner/.nodes-table/.sec-label/.st-pill 等)
   在此各持一份逐字相同的副本,以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */

.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

.ctrl-card { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between; padding: 14px 18px; margin-bottom: 14px; }
.ctrl-left { display: flex; gap: 14px; align-items: center; }
.aw-pill.running { background: var(--accent); }
.ctrl-right { display: flex; gap: 12px; align-items: center; }
.ctrl-metrics { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; font-size: 11.5px; color: var(--ink-soft); }
.ctrl-metrics .sep { opacity: 0.4; }
.ctrl-metrics .warn { color: var(--tone-warning-dot); }
.add-btn { padding: 8px 16px; font-size: 13px; }

.aw-pill.outline { color: var(--ink); background: var(--paper-raised); border-color: var(--line-strong); }

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖,≤640 单列)════════════════════════════
   375px 下本页的三类实测缺陷:网关总控条右侧三件套不换行(整块顶出画布)、
   运行控制行的两个 150px 选择器 + 按钮并排超宽、微标签 9~10.5px。 */
  .ctrl-card { gap: 12px; padding: 12px; }
  .ctrl-right { flex-wrap: wrap; gap: 8px 10px; width: 100%; }
  .ctrl-metrics { width: 100%; }
  /* 触摸目标:手持命中区 ≥40px(main.css 只在 pointer:coarse 下兜底) */
  .aw-pill {
    min-height: 40px;
  }
}
</style>
