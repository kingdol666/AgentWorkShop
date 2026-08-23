<script setup lang="ts">
import ITablerDashboard from '~icons/tabler/layout-dashboard'
import ITablerServer from '~icons/tabler/server'
import { useUserStore } from '@/app/stores/workshop/user'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'

const { t } = useI18n()
const site = useSiteConfig()
const config = useRuntimeConfig().public
const userStore = useUserStore()

const fields = computed(() => [
  { key: 'name', label: t('home.fields.name'), value: site.name },
  { key: 'version', label: t('home.fields.version'), value: site.version },
  { key: 'mode', label: t('home.fields.mode'), value: site.mode },
  { key: 'dev', label: t('home.fields.devPort'), value: `${config.serverHost}:${config.devPort}  (pnpm dev)` },
  { key: 'prod', label: t('home.fields.prodPort'), value: `${config.serverHost}:${config.prodPort}  (pnpm start)` },
  { key: 'api', label: t('home.fields.apiBase'), value: `${site.apiBase}  (${config.apiTimeout}ms)` },
  { key: 'primary', label: t('home.fields.primary'), value: config.primaryColor as string },
])

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

// 业务鉴权:system/config 需用户 token;未登录/过期 → 静默降级(卡片显示登录提示)
const { data: serverConfig } = await useAsyncData('server-config', () =>
  $fetch<ApiEnvelope<ServerConfigView>>('/api/system/config', {
    headers: userStore.token ? { authorization: `Bearer ${userStore.token}` } : {},
  }).catch(() => null),
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

// ── 运行时实况(真实数据,替换旧演示图表):workspace / 活跃 channel / 在线 agent 实例 ──
const wsStore = useWorkspacesStore()
interface RuntimeView { wiredAgents: string[], activeChannels: string[] }
const runtimeStats = ref<RuntimeView | null>(null)

if (userStore.isLoggedIn) {
  if (!wsStore.loaded) wsStore.load().catch(() => {})
  $fetch<ApiEnvelope<RuntimeView>>('/api/workshop/runtime', {
    headers: { authorization: `Bearer ${userStore.token}` },
  })
    .then(res => (runtimeStats.value = res.data ?? null))
    .catch(() => {})
}

const stats = computed(() => [
  { key: 'ws', icon: 'i-tabler-box', label: t('home.stats.workspaces'), value: userStore.isLoggedIn ? String(wsStore.workspaces.length) : '-' },
  { key: 'channels', icon: 'i-tabler-messages', label: t('home.stats.activeChannels'), value: runtimeStats.value ? String(runtimeStats.value.activeChannels.length) : '-' },
  { key: 'agents', icon: 'i-tabler-users-group', label: t('home.stats.wiredAgents'), value: runtimeStats.value ? String(runtimeStats.value.wiredAgents.length) : '-' },
  { key: 'version', icon: 'i-tabler-tag', label: t('home.fields.version'), value: `v${site.version}` },
])
</script>

<template>
  <div class="home">
    <!-- Hero:暖纸画布 + 粉彩光斑 + 衬线大标题(open-tag warm-editorial 声部) -->
    <section class="hero aw-orbs aw-stagger">
      <div class="hero-body">
        <p class="aw-kicker">
          {{ t('menu.system') }} · {{ site.mode }}
        </p>
        <h1 class="hero-title">
          {{ t('home.heroTitle') }}
          <span class="aw-serif-accent-italic">{{ t('home.heroAccent') }}</span>
        </h1>
        <p class="hero-sub">
          {{ t('home.heroSub') }}
        </p>
        <div class="hero-acts">
          <button
            class="aw-pill im"
            @click="navigateTo('/workshop')"
          >
            <span class="i-tabler-box im-pop" />
            {{ t('home.ctaWorkshop') }}
          </button>
          <button
            class="aw-pill outline im"
            @click="navigateTo('/town')"
          >
            <span class="i-tabler-map-2 im-pop" />
            {{ t('menu.town') }}
          </button>
        </div>
      </div>
    </section>

    <!-- 实况统计:serif 数字(editorial stat numerals) -->
    <div class="stat-row aw-stagger">
      <div
        v-for="s in stats"
        :key="s.key"
        class="stat-card"
      >
        <span
          class="stat-icon"
          :class="s.icon"
        />
        <div class="stat-text">
          <span class="stat-value aw-serif-accent">{{ s.value }}</span>
          <span class="stat-label">{{ s.label }}</span>
        </div>
      </div>
    </div>

    <a-row
      :gutter="[16, 16]"
      class="aw-stagger"
    >
      <a-col
        :xs="24"
        :md="14"
      >
        <a-card class="aw-panel">
          <template #title>
            <span class="flex items-center gap-2">
              <ITablerDashboard class="text-[15px] opacity-70" />
              {{ t('home.title') }}
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
              <span class="aw-mono">{{ f.value }}</span>
            </a-descriptions-item>
          </a-descriptions>
        </a-card>
      </a-col>

      <a-col
        :xs="24"
        :md="10"
      >
        <a-card class="aw-panel paradigm-card">
          <a-typography-title
            :level="5"
            class="!mb-2"
          >
            {{ t('home.paradigm') }}
          </a-typography-title>
          <a-typography-paragraph type="secondary">
            {{ t('home.paradigmDesc') }}
          </a-typography-paragraph>
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
          <!-- 未登录/401:静默降级为登录提示 -->
          <div
            v-else-if="!userStore.isLoggedIn"
            class="config-gate"
          >
            <span class="i-tabler-lock" />
            <p>{{ t('home.serverCard.gate') }}</p>
            <button
              class="aw-pill"
              @click="navigateTo('/workshop')"
            >
              {{ t('home.ctaWorkshop') }}
            </button>
          </div>
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

/* Hero:暖纸画布 + 光斑氛围;文字层级 kicker/serif 大标/副行/药丸 CTA */
.hero {
  position: relative;
  margin-bottom: 16px;
  padding: 44px 40px 40px;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}

.hero-body {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
  max-width: 640px;
}

.hero-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 40px;
  font-weight: 400;
  line-height: 1.1;
  letter-spacing: -0.015em;
  color: var(--ink);
}

.hero-sub {
  max-width: 52ch;
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink-faint);
}

.hero-acts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
}

/* 实况统计行:白卡 + serif 数字 + 小标 */
.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.stat-card {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 18px 20px;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  transition: border-color var(--transition-base);
}

.stat-card:hover {
  border-color: var(--line-strong);
}

.stat-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  font-size: 19px;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border-radius: var(--radius-panel-sm);
}

.stat-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.stat-value {
  font-size: 26px;
  line-height: 1.15;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}

.stat-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-fainter);
}

.config-gate {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  padding: 22px 0;
  color: var(--ink-faint);
}

.config-gate > .i-tabler-lock { font-size: 22px; }

.config-gate p { margin: 0; font-size: 12.5px; }

@media (max-width: 640px) {
  .hero { padding: 30px 22px; }
  .hero-title { font-size: 30px; }
}
</style>
