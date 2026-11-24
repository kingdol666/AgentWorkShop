<script setup lang="ts">
/**
 * 系统设置 · 外部 MCP 管理。
 * - admin 登记 https Streamable HTTP server（凭据只填 AW_MCP_* 变量名）
 * - discover 后工具全部 pending；admin 只能批准 shared-safe + read
 * - 启用/停用、删除、重新发现全部走服务端审计
 * 本面板不发起 MCP 连接；连接由服务端 broker 在发现/调用时执行。
 */
import { message, Modal } from 'ant-design-vue'
import { useUserStore } from '@/app/stores/workshop/user'
import { apiFetch } from '@/app/composables/workshop/apiClient'

defineProps<{ activeTab: string }>()

const { t } = useI18n()
const userStore = useUserStore()

interface McpTool {
  id: string
  serverId: string
  upstreamName: string
  exposedName: string
  description: string
  schemaHash: string
  reviewStatus: 'pending' | 'approved' | 'rejected'
  classification: 'read' | 'write'
  reviewedAt?: string
  reviewedBy?: string
}
interface McpServer {
  id: string
  label: string
  endpoint: string
  credentialRef?: string
  hasCredential: boolean
  credentialGeneration: number
  enabled: boolean
  dataSharing: 'shared-safe' | 'project-private' | 'unknown'
  maxDiscoveryAgeMs: number
  tools: McpTool[]
  lastDiscoveredAt?: string
  lastProtocolEra?: string
  lastError?: string
}

const servers = ref<McpServer[]>([])
const loading = ref(false)
const busy = ref<string | null>(null)
const error = ref('')
const canAdmin = computed(() => userStore.isAdmin)

const creating = ref(false)
const form = reactive({ id: '', label: '', endpoint: '', credentialRef: '', dataSharing: 'unknown' as McpServer['dataSharing'] })

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await apiFetch<{ servers: McpServer[] }>({ base: '/api/system/mcp-servers' })
    servers.value = res.servers ?? []
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

async function createServer(): Promise<void> {
  if (!canAdmin.value) return
  try {
    await apiFetch({
      base: '/api/system/mcp-servers',
      init: {
        method: 'POST',
        body: JSON.stringify({
          id: form.id.trim(),
          label: form.label.trim(),
          endpoint: form.endpoint.trim(),
          credentialRef: form.credentialRef.trim() || undefined,
          dataSharing: form.dataSharing,
        }),
      },
    })
    message.success(t('settings.mcp.created'))
    creating.value = false
    form.id = ''
    form.label = ''
    form.endpoint = ''
    form.credentialRef = ''
    form.dataSharing = 'unknown'
    await load()
  }
  catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function toggle(server: McpServer, checked: boolean): Promise<void> {
  busy.value = server.id
  try {
    await apiFetch({
      base: '/api/system/mcp-servers',
      path: `/${encodeURIComponent(server.id)}`,
      init: { method: 'PATCH', body: JSON.stringify({ enabled: checked }) },
    })
    await load()
  }
  catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
  finally {
    busy.value = null
  }
}

async function discover(server: McpServer): Promise<void> {
  busy.value = server.id
  try {
    await apiFetch({
      base: '/api/system/mcp-servers',
      path: `/${encodeURIComponent(server.id)}/discover`,
      init: { method: 'POST' },
    })
    message.success(t('settings.mcp.discovered'))
    await load()
  }
  catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
  finally {
    busy.value = null
  }
}

async function review(serverId: string, tool: McpTool, status: 'approved' | 'rejected'): Promise<void> {
  busy.value = `${serverId}:${tool.id}`
  try {
    await apiFetch({
      base: '/api/system/mcp-servers',
      path: `/${encodeURIComponent(serverId)}/review`,
      init: { method: 'POST', body: JSON.stringify({ toolId: tool.id, status, classification: status === 'approved' ? 'read' : undefined }) },
    })
    message.success(status === 'approved' ? t('settings.mcp.approved') : t('settings.mcp.rejected'))
    await load()
  }
  catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
  finally {
    busy.value = null
  }
}

function remove(server: McpServer): void {
  Modal.confirm({
    title: t('settings.mcp.removeConfirm'),
    content: server.id,
    okText: t('common.delete'),
    okType: 'danger',
    cancelText: t('common.cancel'),
    onOk: async () => {
      busy.value = server.id
      try {
        await apiFetch({
          base: '/api/system/mcp-servers',
          path: `/${encodeURIComponent(server.id)}`,
          init: { method: 'DELETE' },
        })
        message.success(t('settings.mcp.removed'))
        await load()
      }
      catch (err) {
        message.error(err instanceof Error ? err.message : String(err))
      }
      finally {
        busy.value = null
      }
    },
  })
}

onMounted(load)
</script>

<template>
  <div v-show="activeTab === 'mcp'">
    <h3 class="section-title">
      {{ t('settings.mcpTab') }}
    </h3>
    <p class="section-desc">
      {{ t('settings.mcp.desc') }}
    </p>

    <a-alert
      v-if="error"
      type="error"
      show-icon
      :message="error"
      class="mc-notice"
    />
    <a-alert
      v-if="!canAdmin"
      type="info"
      show-icon
      :message="t('settings.mcp.adminOnly')"
      class="mc-notice"
    />

    <div class="mc-toolbar">
      <a-button
        :loading="loading"
        @click="load"
      >
        <span class="i-tabler-refresh" /><span>{{ t('settings.mcp.refresh') }}</span>
      </a-button>
      <a-button
        v-if="canAdmin"
        type="primary"
        @click="creating = !creating"
      >
        <span class="i-tabler-plus" /><span>{{ t('settings.mcp.add') }}</span>
      </a-button>
    </div>

    <a-card
      v-if="creating && canAdmin"
      size="small"
      class="mc-form"
    >
      <div class="mc-grid">
        <a-input
          v-model:value="form.id"
          :placeholder="t('settings.mcp.idPlaceholder')"
        />
        <a-input
          v-model:value="form.label"
          :placeholder="t('settings.mcp.labelPlaceholder')"
        />
        <a-input
          v-model:value="form.endpoint"
          :placeholder="t('settings.mcp.endpointPlaceholder')"
        />
        <a-input
          v-model:value="form.credentialRef"
          :placeholder="t('settings.mcp.credentialPlaceholder')"
        />
        <a-select
          v-model:value="form.dataSharing"
          :options="[
            { value: 'shared-safe', label: 'shared-safe' },
            { value: 'project-private', label: 'project-private' },
            { value: 'unknown', label: 'unknown' },
          ]"
        />
        <a-button
          type="primary"
          @click="createServer"
        >
          {{ t('common.create') }}
        </a-button>
      </div>
    </a-card>

    <a-table
      :data-source="servers"
      :pagination="false"
      row-key="id"
      size="small"
      :locale="{ emptyText: t('settings.mcp.empty') }"
    >
      <a-table-column
        :title="t('settings.mcp.label')"
        data-index="label"
      />
      <a-table-column
        :title="t('settings.mcp.endpoint')"
        data-index="endpoint"
      />
      <a-table-column
        :title="t('settings.mcp.dataSharing')"
        width="120px"
      >
        <template #default="{ record }">
          <a-tag :color="record.dataSharing === 'shared-safe' ? 'green' : 'orange'">
            {{ record.dataSharing }}
          </a-tag>
        </template>
      </a-table-column>
      <a-table-column
        :title="t('settings.mcp.enabled')"
        width="100px"
      >
        <template #default="{ record }">
          <a-switch
            :checked="record.enabled"
            :disabled="!canAdmin || busy === record.id"
            size="small"
            @change="(v: unknown) => toggle(record, v === true)"
          />
        </template>
      </a-table-column>
      <a-table-column
        :title="t('settings.mcp.actions')"
        width="220px"
      >
        <template #default="{ record }">
          <a-button
            type="link"
            size="small"
            :loading="busy === record.id"
            :disabled="!canAdmin"
            @click="discover(record)"
          >
            {{ t('settings.mcp.discover') }}
          </a-button>
          <a-button
            danger
            type="link"
            size="small"
            :disabled="!canAdmin"
            @click="remove(record)"
          >
            {{ t('common.delete') }}
          </a-button>
        </template>
      </a-table-column>
      <template #expandedRowRender="{ record }">
        <div class="mc-detail">
          <div class="mc-meta">
            <span class="aw-mono">{{ record.endpoint }}</span>
            <span>{{ t('settings.mcp.credential') }}: {{ record.credentialRef || '-' }}</span>
            <span>gen {{ record.credentialGeneration }}</span>
            <span v-if="record.lastProtocolEra">{{ record.lastProtocolEra }}</span>
            <span v-if="record.lastDiscoveredAt">{{ record.lastDiscoveredAt }}</span>
            <a-tag
              v-if="record.lastError"
              color="red"
            >
              {{ record.lastError }}
            </a-tag>
          </div>
          <a-table
            :data-source="record.tools"
            :pagination="false"
            row-key="id"
            size="small"
          >
            <a-table-column
              :title="t('settings.mcp.tool')"
              data-index="exposedName"
            />
            <a-table-column
              :title="t('settings.mcp.classification')"
              width="100px"
            >
              <template #default="{ record: tool }">
                <a-tag :color="tool.classification === 'read' ? 'green' : 'red'">
                  {{ tool.classification }}
                </a-tag>
              </template>
            </a-table-column>
            <a-table-column
              :title="t('settings.mcp.review')"
              width="110px"
            >
              <template #default="{ record: tool }">
                <a-tag :color="tool.reviewStatus === 'approved' ? 'green' : tool.reviewStatus === 'rejected' ? 'red' : 'orange'">
                  {{ tool.reviewStatus }}
                </a-tag>
              </template>
            </a-table-column>
            <a-table-column
              :title="t('settings.mcp.actions')"
              width="170px"
            >
              <template #default="{ record: tool }">
                <a-button
                  type="link"
                  size="small"
                  :disabled="!canAdmin || busy === `${tool.serverId}:${tool.id}`"
                  @click="review(tool.serverId, tool, 'approved')"
                >
                  {{ t('settings.mcp.approve') }}
                </a-button>
                <a-button
                  danger
                  type="link"
                  size="small"
                  :disabled="!canAdmin || busy === `${tool.serverId}:${tool.id}`"
                  @click="review(tool.serverId, tool, 'rejected')"
                >
                  {{ t('settings.mcp.reject') }}
                </a-button>
              </template>
            </a-table-column>
          </a-table>
        </div>
      </template>
    </a-table>
  </div>
</template>

<style scoped>
.section-title {
  margin: 0 0 4px;
  font-family: var(--font-body);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.section-desc {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-faint);
}

.mc-notice {
  margin-bottom: 12px;
}

.mc-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}

.mc-form {
  margin-bottom: 12px;
}

.mc-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.mc-detail {
  padding: 4px 0;
}

.mc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--ink-faint);
}

@media (max-width: 899px) {
  .mc-grid {
    grid-template-columns: 1fr;
  }
}
</style>
