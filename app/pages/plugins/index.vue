<script setup lang="ts">
/**
 * 插件管理 —— 查看配置根 plugins/ 下全部插件(双作用域)、详情、启停开关。
 * 启停写 plugins-state.json,服务端 fs.watch 热重载(≈1s),浏览器侧 loader
 * 经 WS plugins.reloaded 事件 + 轮询双通道热注入/卸载客户端增强。
 */
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useUserStore } from '~/stores/workshop/user'

const { t } = useI18n()
const userStore = useUserStore()

interface PluginRoute { method: string, path: string }
interface PluginInfo {
  name: string
  version: string
  description: string
  scope: 'project' | 'user'
  enabled: boolean
  hasClient: boolean
  routes: PluginRoute[]
  error?: string | null
}

const plugins = ref<PluginInfo[]>([])
const failures = ref<Array<{ source: string, error: string }>>([])
const loading = ref(false)
const busyName = ref('')
const drawerOpen = ref(false)
const current = ref<PluginInfo | null>(null)

/** 平台 API 鉴权:Bearer token(与全局 $http 拦截器同源) */
function authHeaders(): Record<string, string> {
  const token = (userStore as { token?: string }).token
  return token ? { authorization: `Bearer ${token}` } : {}
}

async function load() {
  loading.value = true
  try {
    const d = await $fetch<{ plugins: PluginInfo[], failures: Array<{ source: string, error: string }> }>('/api/workshop/plugins', { headers: authHeaders() })
    plugins.value = d.plugins ?? []
    failures.value = d.failures ?? []
  }
  catch {
    message.error(t('plugins.enableFail'))
  }
  finally {
    loading.value = false
  }
}

async function toggle(p: PluginInfo) {
  busyName.value = p.name
  try {
    const d = await $fetch<{ enabled: boolean }>(`/api/workshop/plugins/${p.name}/${p.enabled ? 'disable' : 'enable'}`, { method: 'POST', headers: authHeaders() })
    p.enabled = d.enabled
    message.success(`${p.name} · ${d.enabled ? t('plugins.enabled') : t('plugins.disabled')}`)
    setTimeout(load, 800) // 热重载完成后刷新路由/客户端状态
  }
  catch (err) {
    message.error(`${t('plugins.enableFail')}: ${(err as Error)?.message ?? ''}`)
  }
  finally {
    busyName.value = ''
  }
}

const enabledCount = computed(() => plugins.value.filter(p => p.enabled).length)
const clientCount = computed(() => plugins.value.filter(p => p.hasClient).length)

function scopeLabel(scope: string) {
  return scope === 'project' ? t('plugins.scopeProject') : t('plugins.scopeUser')
}

function openDetail(p: PluginInfo) {
  current.value = p
  drawerOpen.value = true
}

onMounted(load)
</script>

<template>
  <div class="plugins-page">
    <header class="pg-head">
      <div>
        <h1 class="pg-title">
          {{ $t('plugins.title') }}
        </h1>
        <p class="pg-sub">
          {{ $t('plugins.subtitle') }}
        </p>
      </div>
      <div class="pg-stats">
        <span class="stat">{{ $t('plugins.enabled') }} <b>{{ enabledCount }}</b></span>
        <span class="stat">{{ $t('plugins.hasClient') }} <b>{{ clientCount }}</b></span>
        <span class="stat">{{ $t('plugins.routes') }} <b>{{ plugins.reduce((s, p) => s + p.routes.length, 0) }}</b></span>
        <a-button
          size="small"
          :loading="loading"
          @click="load"
        >
          {{ $t('plugins.refresh') }}
        </a-button>
      </div>
    </header>

    <a-alert
      v-if="failures.length"
      type="error"
      show-icon
      class="pg-failures"
      :message="$t('plugins.loadFailures', { n: failures.length })"
    >
      <template #description>
        <div
          v-for="f in failures"
          :key="f.source"
          class="fail-line"
        >
          {{ f.source }} — {{ f.error }}
        </div>
      </template>
    </a-alert>

    <div
      v-if="!plugins.length && !loading"
      class="pg-empty"
    >
      {{ $t('plugins.empty') }}
    </div>

    <div class="pg-grid">
      <article
        v-for="p in plugins"
        :key="`${p.scope}:${p.name}`"
        class="pg-card"
        :class="{ 'is-off': !p.enabled }"
        @click="openDetail(p)"
      >
        <div class="card-head">
          <span class="card-name">{{ p.name }}</span>
          <span class="card-ver">{{ p.version }}</span>
          <a-switch
            :checked="p.enabled"
            :loading="busyName === p.name"
            size="small"
            @click.stop
            @change="toggle(p)"
          />
        </div>
        <p class="card-desc">
          {{ p.description || '—' }}
        </p>
        <div class="card-tags">
          <span
            class="tag"
            :class="p.scope"
          >{{ scopeLabel(p.scope) }}</span>
          <span
            class="tag"
            :class="p.enabled ? 'on' : 'off'"
          >{{ p.enabled ? $t('plugins.enabled') : $t('plugins.disabled') }}</span>
          <span
            v-if="p.hasClient"
            class="tag client"
          >{{ $t('plugins.hasClient') }}</span>
        </div>
        <div
          v-if="p.routes.length"
          class="card-routes"
        >
          <code
            v-for="r in p.routes"
            :key="r.method + r.path"
          >{{ r.method }} {{ r.path }}</code>
        </div>
      </article>
    </div>

    <a-drawer
      v-model:open="drawerOpen"
      :title="current?.name"
      width="460"
    >
      <template v-if="current">
        <dl class="detail">
          <dt>version</dt><dd>{{ current.version }}</dd>
          <dt>scope</dt><dd>{{ scopeLabel(current.scope) }}</dd>
          <dt>enabled</dt><dd>{{ current.enabled }}</dd>
          <dt>client</dt><dd>{{ current.hasClient ? '✓' : '—' }}</dd>
          <dt v-if="current.error">
            error
          </dt>
          <dd
            v-if="current.error"
            style="color:#ff6b6b"
          >
            {{ current.error }}
          </dd>
        </dl>
        <h4>{{ $t('plugins.routes') }}</h4>
        <code
          v-for="r in current.routes"
          :key="r.method + r.path"
          class="detail-route"
        >
          {{ r.method }} /api/plugins/{{ current.name }}{{ r.path }}
        </code>
        <p
          v-if="!current.routes.length"
          class="dim"
        >
          —
        </p>
      </template>
    </a-drawer>
  </div>
</template>

<style scoped lang="css">
.plugins-page { max-width: 1080px; margin: 0 auto; padding: 24px 20px 48px; }
.pg-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.pg-title { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: .5px; }
.pg-sub { margin: 4px 0 0; opacity: .6; font-size: 12px; }
.pg-stats { display: flex; align-items: center; gap: 14px; font-size: 12px; opacity: .85; }
.pg-stats b { font-size: 15px; }
.pg-failures { margin-bottom: 16px; }
.fail-line { font-family: ui-monospace, monospace; font-size: 11px; }
.pg-empty { padding: 48px 0; text-align: center; opacity: .55; }
.pg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.pg-card { position: relative; padding: 14px 16px; border: 1px solid var(--aw-border, rgba(128, 152, 199, .25));
  border-radius: 12px; background: var(--aw-card, rgba(255, 255, 255, .04)); cursor: pointer;
  transition: border-color .2s, transform .2s; }
.pg-card:hover { border-color: var(--aw-accent, #35e0a0); transform: translateY(-1px); }
.pg-card.is-off { opacity: .55; }
.card-head { display: flex; align-items: center; gap: 10px; }
.card-name { font-weight: 700; font-size: 15px; }
.card-ver { color: inherit; opacity: .5; font-family: ui-monospace, monospace; font-size: 11px; }
.card-head .a-switch { margin-left: auto; }
.card-desc { margin: 8px 0; font-size: 12px; opacity: .75; min-height: 18px; }
.card-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.tag { padding: 2px 8px; border-radius: 999px; font-size: 10px; border: 1px solid rgba(128, 152, 199, .3); }
.tag.project { border-color: rgba(53, 224, 160, .5); color: #35e0a0; }
.tag.user { border-color: rgba(65, 200, 244, .5); color: #41c8f4; }
.tag.on { border-color: rgba(53, 224, 160, .5); color: #35e0a0; }
.tag.off { border-color: rgba(255, 107, 107, .4); color: #ff6b6b; }
.tag.client { border-color: rgba(181, 140, 255, .5); color: #b58cff; }
.card-routes { display: flex; flex-direction: column; gap: 2px; }
.card-routes code { font-size: 10px; opacity: .65; }
.detail dt { margin-top: 10px; font-size: 11px; opacity: .5; }
.detail dd { margin: 2px 0 0; font-family: ui-monospace, monospace; font-size: 12px; }
.detail-route { display: block; font-size: 11px; opacity: .8; margin-bottom: 4px; }
h4 { margin: 16px 0 6px; }
.dim { opacity: .45; }
</style>
