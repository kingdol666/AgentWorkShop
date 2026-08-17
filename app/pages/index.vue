<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import ITablerDashboard from '~icons/tabler/layout-dashboard'
import ITablerBolt from '~icons/tabler/bolt'
import ITablerServer from '~icons/tabler/server'

const { t } = useI18n()
const site = useSiteConfig()
const config = useRuntimeConfig().public
const store = useAppStore()

const fields = computed(() => [
  { key: 'name', label: t('home.fields.name'), value: site.name },
  { key: 'version', label: t('home.fields.version'), value: site.version },
  { key: 'mode', label: t('home.fields.mode'), value: site.mode },
  { key: 'dev', label: t('home.fields.devPort'), value: `${config.serverHost}:${config.devPort}  (pnpm dev)` },
  { key: 'prod', label: t('home.fields.prodPort'), value: `${config.serverHost}:${config.prodPort}  (pnpm start)` },
  { key: 'api', label: t('home.fields.apiBase'), value: `${site.apiBase}  (${config.apiTimeout}ms)` },
  { key: 'primary', label: t('home.fields.primary'), value: config.primaryColor as string },
])

// 制图台配色:钴蓝主线 + 朱红误差线 + 灰阶网格
const chartOption = shallowRef<EChartsOption>({
  color: ['#2e51c8', '#c23b2e'],
  tooltip: {
    trigger: 'axis',
    borderWidth: 1,
    borderColor: '#d3ccb8',
    textStyle: { fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 },
  },
  legend: {
    data: ['Requests', 'Errors'],
    top: 6,
    textStyle: { fontFamily: 'IBM Plex Mono, monospace', fontSize: 10.5 },
  },
  grid: { left: 36, right: 16, top: 40, bottom: 28 },
  xAxis: {
    type: 'category',
    data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    axisLine: { lineStyle: { color: '#b9b096' } },
    axisTick: { show: false },
    axisLabel: { fontFamily: 'IBM Plex Mono, monospace', fontSize: 10, color: '#8a8371' },
  },
  yAxis: {
    type: 'value',
    splitLine: { lineStyle: { color: 'rgba(27, 39, 51, 0.08)' } },
    axisLabel: { fontFamily: 'IBM Plex Mono, monospace', fontSize: 10, color: '#8a8371' },
  },
  series: [
    {
      name: 'Requests',
      type: 'line',
      smooth: false,
      symbol: 'rect',
      symbolSize: 6,
      lineStyle: { width: 2 },
      areaStyle: { color: 'rgba(46, 81, 200, 0.07)' },
      data: [120, 200, 150, 80, 70, 110, 130],
    },
    {
      name: 'Errors',
      type: 'line',
      smooth: false,
      symbol: 'rect',
      symbolSize: 6,
      lineStyle: { width: 2, type: 'dashed' },
      data: [5, 8, 3, 2, 1, 4, 6],
    },
  ],
})

// 服务端配置一致性演示:前端 useSiteConfig() 与后端 GET /api/system/config 同源于 config.yml
interface ServerConfigView {
  app: { name: string, title: string, version: string, mode: string }
  server: { host: string, devPort: number, prodPort: number }
  api: { baseURL: string, timeout: number, pageSize: number, maxPageSize: number }
  theme: { primaryColor: string, themeMode: string }
  i18n: { defaultLocale: string }
}

interface ApiEnvelope<T> {
  code: number | string
  message: string
  data: T | null
}

const { data: serverConfig } = await useAsyncData('server-config', () =>
  $fetch<ApiEnvelope<ServerConfigView>>('/api/system/config'),
)

const serverFields = computed(() => {
  const d = serverConfig.value?.data
  if (!d) {
    return []
  }
  return [
    { key: 'name', label: t('home.fields.name'), value: d.app.name },
    { key: 'version', label: t('home.fields.version'), value: d.app.version },
    { key: 'mode', label: t('home.fields.mode'), value: d.app.mode },
    { key: 'dev', label: t('home.fields.devPort'), value: `${d.server.host}:${d.server.devPort}` },
    { key: 'prod', label: t('home.fields.prodPort'), value: `${d.server.host}:${d.server.prodPort}` },
    { key: 'pageSize', label: t('home.serverCard.pageSize'), value: String(d.api.pageSize) },
    { key: 'maxPageSize', label: t('home.serverCard.maxPageSize'), value: String(d.api.maxPageSize) },
  ]
})
</script>

<template>
  <div class="home">
    <!-- 图签头:总览大标题 + 版本印章 -->
    <div class="aw-page-head">
      <div>
        <p class="aw-kicker">
          {{ t('menu.system') }} / overview
        </p>
        <h1>{{ t('home.title') }}</h1>
      </div>
      <span class="aw-stamp">v{{ site.version }}(living document)</span>
    </div>

    <a-row
      :gutter="[16, 16]"
      class="aw-stagger"
    >
      <a-col :span="24">
        <a-card class="aw-panel">
          <template #title>
            <span class="flex items-center gap-2">
              <ITablerDashboard class="text-[15px] opacity-70" />
              {{ t('home.title') }}
            </span>
          </template>
          <template #extra>
            <span class="aw-kicker">identity sheet</span>
          </template>
          <a-descriptions
            bordered
            :column="1"
            size="small"
          >
            <a-descriptions-item
              v-for="f in fields"
              :key="f.key"
              :label="f.label"
            >
              <span class="aw-mono">{{ f.value }}</span>
            </a-descriptions-item>
          </a-descriptions>
        </a-card>
      </a-col>

      <a-col
        :xs="24"
        :md="16"
      >
        <a-card
          class="aw-panel"
          :title="t('home.chart')"
        >
          <template #extra>
            <span class="aw-kicker">7d trace</span>
          </template>
          <AppChart
            class="h-76 w-full"
            :option="chartOption"
          />
        </a-card>
      </a-col>

      <a-col
        :xs="24"
        :md="8"
      >
        <a-card class="aw-panel paradigm-card">
          <a-typography-title
            :level="5"
            class="!mb-2 flex items-center gap-2"
          >
            <ITablerBolt class="text-[15px]" />
            {{ t('home.paradigm') }}
          </a-typography-title>
          <a-typography-paragraph type="secondary">
            {{ t('home.paradigmDesc') }}
          </a-typography-paragraph>
          <a-button
            type="primary"
            @click="store.toggleDark()"
          >
            {{ store.isDark ? t('common.light') : t('common.dark') }}
          </a-button>
          <span class="aw-kicker paradigm-index">06 / paradigm</span>
        </a-card>
      </a-col>

      <a-col :span="24">
        <a-card class="aw-panel">
          <template #title>
            <span class="flex items-center gap-2">
              <ITablerServer class="text-[15px] opacity-70" />
              {{ t('home.serverCard.title') }}
              <a-tag
                color="success"
                class="ml-1"
              >
                {{ t('home.serverCard.synced') }}
              </a-tag>
            </span>
          </template>
          <template #extra>
            <span class="aw-kicker">server ledger</span>
          </template>
          <template v-if="serverFields.length">
            <a-descriptions
              bordered
              :column="1"
              size="small"
            >
              <a-descriptions-item
                v-for="f in serverFields"
                :key="f.key"
                :label="f.label"
              >
                <span class="aw-mono">{{ f.value }}</span>
              </a-descriptions-item>
            </a-descriptions>
            <a-typography-paragraph
              type="secondary"
              class="mt-3 mb-0"
            >
              {{ t('home.serverCard.desc') }}
            </a-typography-paragraph>
          </template>
          <a-skeleton
            v-else
            active
          />
        </a-card>
      </a-col>
    </a-row>
  </div>
</template>

<style scoped>
.home {
  padding: 4px;
}

/* 范式卡内页脚索引 */
.paradigm-card {
  overflow: hidden;
}

.paradigm-index {
  position: absolute;
  right: 12px;
  bottom: 8px;
  opacity: 0.35;
}
</style>
