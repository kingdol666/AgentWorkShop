<script setup lang="ts">
/**
 * 工具管理 —— 全局工具目录透明化(admin)。
 * 内置 + 插件注册工具统一展示:来源、插件、角色、可用性、参数 Schema、被哪些 Channel 停用。
 */
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useWorkshopApi, type GlobalToolDto, type GlobalToolViewDto } from '@/app/composables/workshop/useWorkshopApi'
import { apiErrorMessage } from '@/app/utils/api-error'

const { t } = useI18n()
const api = useWorkshopApi()

const view = ref<GlobalToolViewDto | null>(null)
const loading = ref(false)
const syncing = ref(false)
const query = ref('')
const sourceFilter = ref<'all' | 'builtin' | 'plugin'>('all')
const pluginFilter = ref<string>('')
const availableOnly = ref(false)
const drawerOpen = ref(false)
const selected = ref<GlobalToolDto | null>(null)

const tools = computed(() => view.value?.tools ?? [])
const pluginOptions = computed(() => {
  const names = new Set(tools.value.map(t => t.plugin).filter((x): x is string => Boolean(x)))
  return [{ value: '', label: t('toolsPage.pluginAll') }, ...[...names].sort().map(name => ({ value: name, label: name }))]
})
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return tools.value.filter((tool) => {
    if (sourceFilter.value !== 'all' && tool.source !== sourceFilter.value) return false
    if (pluginFilter.value && tool.plugin !== pluginFilter.value) return false
    if (availableOnly.value && !tool.available) return false
    if (!q) return true
    return `${tool.name} ${tool.label} ${tool.description} ${tool.plugin ?? ''}`.toLowerCase().includes(q)
  })
})

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await api.listTools()
    view.value = res?.data ?? null
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('toolsPage.loadFail')))
  }
  finally {
    loading.value = false
  }
}

async function sync(): Promise<void> {
  if (syncing.value) return
  syncing.value = true
  try {
    const res = await api.syncTools()
    const data = res?.data
    if (data) message.success(t('toolsPage.syncDone', { total: data.total, plugin: data.plugin, unavailable: data.unavailable }))
    await load()
  }
  catch (e) {
    message.error(apiErrorMessage(e, t('toolsPage.syncFail')))
  }
  finally {
    syncing.value = false
  }
}

function openDetail(tool: GlobalToolDto): void {
  selected.value = tool
  drawerOpen.value = true
}

function customRow(record: GlobalToolDto): Record<string, unknown> {
  return { onClick: () => openDetail(record), style: 'cursor: pointer' }
}

function fmtTime(value: string | null | undefined): string {
  return value ? String(value).replace('T', ' ').slice(0, 19) : '—'
}

onMounted(load)
</script>

<template>
  <div class="tools-page">
    <header class="aw-page-head">
      <div>
        <p class="aw-kicker">
          agentworkshop / tools
        </p>
        <h1>{{ $t('toolsPage.title') }}</h1>
        <p class="pg-sub">
          {{ $t('toolsPage.subtitle') }}
        </p>
      </div>
      <div class="tp-actions">
        <a-button
          size="small"
          :loading="loading"
          @click="load"
        >
          {{ $t('toolsPage.refresh') }}
        </a-button>
        <a-button
          size="small"
          type="primary"
          :loading="syncing"
          @click="sync"
        >
          {{ $t('toolsPage.sync') }}
        </a-button>
      </div>
    </header>

    <div
      v-if="view"
      class="tp-stats"
    >
      <div class="tp-stat">
        <span>{{ $t('toolsPage.total') }}</span><b>{{ view.stats.total }}</b>
      </div>
      <div class="tp-stat">
        <span>{{ $t('toolsPage.builtin') }}</span><b>{{ view.stats.builtin }}</b>
      </div>
      <div class="tp-stat">
        <span>{{ $t('toolsPage.plugin') }}</span><b>{{ view.stats.plugin }}</b>
      </div>
      <div class="tp-stat">
        <span>{{ $t('toolsPage.available') }}</span><b>{{ view.stats.available }}</b>
      </div>
      <div class="tp-stat">
        <span>{{ $t('toolsPage.disabledByChannels') }}</span><b>{{ view.stats.disabledByChannels }}</b>
      </div>
      <div class="tp-sync">
        {{ $t('toolsPage.lastSync') }} {{ fmtTime(view.lastSyncedAt) }}
      </div>
    </div>

    <div class="tp-filters">
      <a-input-search
        v-model:value="query"
        allow-clear
        :placeholder="$t('toolsPage.search')"
      />
      <a-select
        v-model:value="sourceFilter"
        style="width: 140px"
        :options="[
          { value: 'all', label: $t('toolsPage.sourceAll') },
          { value: 'builtin', label: $t('toolsPage.sourceBuiltin') },
          { value: 'plugin', label: $t('toolsPage.sourcePlugin') },
        ]"
      />
      <a-select
        v-model:value="pluginFilter"
        style="width: 180px"
        :options="pluginOptions"
      />
      <a-checkbox v-model:checked="availableOnly">
        {{ $t('toolsPage.availableOnly') }}
      </a-checkbox>
    </div>

    <a-table
      :data-source="filtered"
      :loading="loading"
      row-key="name"
      size="small"
      :custom-row="customRow"
      :pagination="{ pageSize: 30, showSizeChanger: false, size: 'small', position: ['bottomRight'] }"
    >
      <a-table-column
        :title="$t('toolsPage.name')"
        data-index="name"
        :width="220"
      >
        <template #default="{ record }">
          <div class="tp-name">
            <span class="aw-mono">{{ record.name }}</span>
            <span class="tp-label">{{ record.label }}</span>
          </div>
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('toolsPage.source')"
        :width="120"
      >
        <template #default="{ record }">
          <a-tag :color="record.source === 'plugin' ? 'purple' : 'default'">
            {{ record.source === 'plugin' ? $t('toolsPage.sourcePlugin') : $t('toolsPage.sourceBuiltin') }}
          </a-tag>
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('toolsPage.pluginCol')"
        :width="150"
      >
        <template #default="{ record }">
          <span
            v-if="record.plugin"
            class="aw-mono"
          >{{ record.plugin }}</span>
          <span v-else>—</span>
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('toolsPage.roles')"
        :width="130"
      >
        <template #default="{ record }">
          <a-tag
            v-for="role in record.roles"
            :key="role"
            :color="role === 'lead' ? 'gold' : 'blue'"
          >
            {{ role }}
          </a-tag>
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('toolsPage.availableCol')"
        :width="100"
      >
        <template #default="{ record }">
          <a-tag :color="record.available ? 'green' : 'red'">
            {{ record.available ? $t('toolsPage.yes') : $t('toolsPage.no') }}
          </a-tag>
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('toolsPage.channels')"
        :width="110"
      >
        <template #default="{ record }">
          <span :class="{ 'tp-bad': record.channels.length > 0 }">{{ record.channels.length }}</span>
        </template>
      </a-table-column>
    </a-table>

    <a-drawer
      v-model:open="drawerOpen"
      :title="selected?.name"
      width="560"
    >
      <template v-if="selected">
        <div class="tp-detail">
          <div class="tp-kv">
            <span>label</span><b>{{ selected.label }}</b>
          </div>
          <div class="tp-kv">
            <span>{{ $t('toolsPage.source') }}</span><b>{{ selected.source }}<template v-if="selected.plugin"> · {{ selected.plugin }}</template></b>
          </div>
          <div class="tp-kv">
            <span>{{ $t('toolsPage.roles') }}</span><b>{{ selected.roles.join(' / ') }}</b>
          </div>
          <div class="tp-kv">
            <span>{{ $t('toolsPage.availableCol') }}</span><b>{{ selected.available ? $t('toolsPage.yes') : $t('toolsPage.no') }}</b>
          </div>
          <div class="tp-kv">
            <span>{{ $t('toolsPage.firstSeen') }}</span><b>{{ fmtTime(selected.firstSeenAt) }}</b>
          </div>
          <div class="tp-kv">
            <span>{{ $t('toolsPage.updated') }}</span><b>{{ fmtTime(selected.updatedAt) }}</b>
          </div>
          <div class="tp-kv">
            <span>hash</span><b class="aw-mono tp-hash">{{ selected.definitionHash }}</b>
          </div>
          <p class="tp-desc">
            {{ selected.description }}
          </p>
          <h4>{{ $t('toolsPage.parameters') }}</h4>
          <pre class="tp-json">{{ JSON.stringify(selected.parameters, null, 2) }}</pre>
          <h4>{{ $t('toolsPage.disabledChannels') }}</h4>
          <div
            v-if="selected.channels.length"
            class="tp-channels"
          >
            <a-tag
              v-for="ch in selected.channels"
              :key="ch.id"
              color="orange"
            >
              {{ ch.name }} · {{ ch.mode }}
            </a-tag>
          </div>
          <p
            v-else
            class="ws-hint"
          >
            {{ $t('toolsPage.noDisabledChannels') }}
          </p>
        </div>
      </template>
    </a-drawer>
  </div>
</template>

<style scoped>
.tools-page {
  padding: 20px 24px 40px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.tp-actions {
  display: flex;
  gap: 8px;
}
.tp-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.tp-stat {
  border: 1px solid var(--border, rgba(128, 128, 128, .2));
  border-radius: 8px;
  padding: 8px 12px;
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
  color: var(--ink-soft);
}
.tp-stat b {
  font-size: 18px;
  color: var(--ink);
}
.tp-sync {
  margin-left: auto;
  font-size: 12px;
  color: var(--ink-faint);
}
.tp-filters {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.tp-filters :deep(.ant-input-search) {
  width: 280px;
}
.tp-name {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tp-label {
  font-size: 11px;
  color: var(--ink-faint);
}
.tp-bad {
  color: #e6a23c;
  font-weight: 600;
}
.tp-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tp-kv {
  display: flex;
  gap: 12px;
  font-size: 12px;
}
.tp-kv span {
  width: 90px;
  flex: 0 0 90px;
  color: var(--ink-faint);
}
.tp-kv b {
  font-weight: 500;
  word-break: break-all;
}
.tp-hash {
  font-size: 10px;
}
.tp-desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-soft);
  white-space: pre-wrap;
}
.tp-json {
  max-height: 320px;
  overflow: auto;
  background: rgba(0, 0, 0, .25);
  border-radius: 8px;
  padding: 10px;
  font-size: 11px;
  line-height: 1.5;
}
.tp-channels {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
