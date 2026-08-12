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

const chartOption = shallowRef<EChartsOption>({
  tooltip: { trigger: 'axis' },
  legend: { data: ['Requests', 'Errors'] },
  grid: { left: 40, right: 20, top: 40, bottom: 30 },
  xAxis: { type: 'category', data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
  yAxis: { type: 'value' },
  series: [
    { name: 'Requests', type: 'line', smooth: true, data: [120, 200, 150, 80, 70, 110, 130] },
    { name: 'Errors', type: 'line', smooth: true, data: [5, 8, 3, 2, 1, 4, 6] },
  ],
})

// 服务端配置一致性演示：前端 useSiteConfig() 与后端 GET /api/system/config 同源于 config.yml
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
  <a-row :gutter="[16, 16]">
    <a-col :span="24">
      <a-card>
        <template #title>
          <span class="flex items-center gap-2">
            <ITablerDashboard /> {{ t('home.title') }}
          </span>
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
            <span class="font-mono">{{ f.value }}</span>
          </a-descriptions-item>
        </a-descriptions>
      </a-card>
    </a-col>

    <a-col
      :xs="24"
      :md="16"
    >
      <a-card :title="t('home.chart')">
        <AppChart
          class="h-80 w-full"
          :option="chartOption"
        />
      </a-card>
    </a-col>

    <a-col
      :xs="24"
      :md="8"
    >
      <a-card>
        <a-typography-title
          :level="5"
          class="!mb-2 flex items-center gap-2"
        >
          <ITablerBolt /> {{ t('home.paradigm') }}
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
      </a-card>
    </a-col>

    <a-col :span="24">
      <a-card>
        <template #title>
          <span class="flex items-center gap-2">
            <ITablerServer /> {{ t('home.serverCard.title') }}
            <a-tag
              color="success"
              class="ml-1"
            >
              {{ t('home.serverCard.synced') }}
            </a-tag>
          </span>
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
              <span class="font-mono">{{ f.value }}</span>
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
</template>
