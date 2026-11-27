<template>
  <div class="page">
    <header class="head">
      <div>
        <h1 class="title">
          {{ $t('data.page.title') }}
        </h1>
        <p class="sub">
          {{ $t('data.page.sub') }}
        </p>
      </div>
    </header>

    <nav
      class="tabs aw-seg"
      :aria-label="$t('data.page.title')"
      data-test="data-tabs"
    >
      <button
        v-for="view in views"
        :key="view"
        type="button"
        class="tab"
        :class="{ on: tab === view }"
        :aria-pressed="tab === view"
        aria-controls="data-view"
        @click="tab = view"
      >
        {{ $t(`data.tab.${view}`) }}
      </button>
    </nav>

    <section
      id="data-view"
      class="view"
      :aria-label="$t(`data.tab.${tab}`)"
    >
      <DataMirrorPanel v-if="tab === 'mirror'" />
      <DataMesPanel v-else-if="tab === 'mes'" />
      <DataLedgerPanel v-else />
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 数据管理台(plan1 M1):产线维度的数据消费面。
 *  - 镜像数据:多节点批量查询(服务端桶聚合)+ 预览 + 自定义导出;
 *  - MES 接口:点位目录 + req→res 调试台(脱敏回显);
 *  - 台账:导出任务 + 批次 run 台账。
 * 与 /daq(监控控制台)分工:/data 面向业务取数与分析准备。
 */
const views = ['mirror', 'mes', 'ledger'] as const
const tab = ref<(typeof views)[number]>('mirror')
</script>

<style scoped>
.page { display: flex; flex-direction: column; gap: var(--gap-block); min-width: 0; padding: 4px; }
.head { display: flex; justify-content: space-between; align-items: flex-end; }
.title { font-size: 24px; font-weight: 650; margin: 0; }
.sub { font-size: 13px; color: var(--ink-soft); margin: 4px 0 0; }
.tabs { align-self: flex-start; display: flex; flex-wrap: wrap; max-width: 100%; }
.tab { min-height: 36px; }
.tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.view { min-width: 0; }
</style>
