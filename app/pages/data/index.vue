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
      class="tabs"
      data-test="data-tabs"
    >
      <button
        class="tab"
        :class="{ on: tab === 'mirror' }"
        @click="tab = 'mirror'"
      >
        {{ $t('data.tab.mirror') }}
      </button>
      <button
        class="tab"
        :class="{ on: tab === 'mes' }"
        @click="tab = 'mes'"
      >
        {{ $t('data.tab.mes') }}
      </button>
      <button
        class="tab"
        :class="{ on: tab === 'ledger' }"
        @click="tab = 'ledger'"
      >
        {{ $t('data.tab.ledger') }}
      </button>
    </nav>

    <DataMirrorPanel v-if="tab === 'mirror'" />
    <DataMesPanel v-else-if="tab === 'mes'" />
    <DataLedgerPanel v-else />
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
const tab = ref<'mirror' | 'mes' | 'ledger'>('mirror')
</script>

<style scoped>
.page { display: flex; flex-direction: column; gap: 12px; padding: 16px 20px; }
.head { display: flex; justify-content: space-between; align-items: flex-end; }
.title { font-size: 18px; font-weight: 700; margin: 0; }
.sub { font-size: 12px; color: var(--ink-faint, #888); margin: 2px 0 0; }
.tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--border, rgba(127,127,127,.2)); padding-bottom: 0; }
.tab { border: none; background: transparent; padding: 6px 14px; font-size: 13px; cursor: pointer; color: var(--ink-soft, #666); border-bottom: 2px solid transparent; }
.tab.on { color: var(--ink, #222); font-weight: 600; border-bottom-color: #4a6b57; }
</style>
