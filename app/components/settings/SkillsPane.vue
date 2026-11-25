<script setup lang="ts">
/**
 * 系统设置 · Skill 管理（一方管理面）。
 * - 发现：内置 / 平台受管 / ~/.agent / ~/.agents / XDG / AW_SKILL_ROOTS（只读）
 * - 导入：从发现结果生成不可变受管 revision（默认未启用）
 * - 启停/删除：admin；全部走服务端审计
 * 不做 Skill 执行，不展示 credential/环境变量。
 */
import { message, Modal } from 'ant-design-vue'
import { useUserStore } from '@/app/stores/workshop/user'
import { apiFetch } from '@/app/composables/workshop/apiClient'

defineProps<{ activeTab: string }>()

const { t } = useI18n()
const userStore = useUserStore()

interface Diagnostic { level: 'warn' | 'error', code: string, message: string }
interface ManagedRevision {
  id: string
  name: string
  revision: string
  contentHash: string
  source: string
  sourcePath: string
  enabled: boolean
  importedAt: string
  importedBy: string
  fileCount: number
  totalBytes: number
  diagnostics: Diagnostic[]
}
interface DiscoveredSkill {
  id: string
  name: string
  description: string
  source: string
  sourcePath: string
  contentHash: string
  compatibility?: string
  diagnostics: Diagnostic[]
  fileCount: number
  totalBytes: number
}
const managed = ref<ManagedRevision[]>([])
const discovered = ref<DiscoveredSkill[]>([])
const roots = ref<Array<{ id: string, path: string, source: string, managed: boolean }>>([])
const loading = ref(false)
const busyId = ref<string | null>(null)
const error = ref('')

const canAdmin = computed(() => userStore.isAdmin)
const diagnosticsOf = (item: { diagnostics: Diagnostic[] }): Diagnostic[] => item.diagnostics.filter(d => d.level === 'error' || d.level === 'warn')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [list, found] = await Promise.all([
      apiFetch<{ managed: ManagedRevision[], roots: typeof roots.value }>({ base: '/api/system/skills' }),
      apiFetch<{ discovered: DiscoveredSkill[] }>({ base: '/api/system/skills/discover' }),
    ])
    managed.value = list.managed ?? []
    roots.value = list.roots ?? []
    discovered.value = found.discovered ?? []
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

async function importSkill(item: DiscoveredSkill): Promise<void> {
  if (!canAdmin.value) return
  Modal.confirm({
    title: t('settings.skills.importConfirm'),
    content: `${item.name} · ${item.source}`,
    okText: t('common.confirm'),
    cancelText: t('common.cancel'),
    onOk: async () => {
      busyId.value = item.id
      try {
        const res = await apiFetch<{ revision: ManagedRevision, existing: boolean }>({
          base: '/api/system/skills/import',
          init: { method: 'POST', body: JSON.stringify({ catalogId: item.id }) },
        })
        if (res.revision) message.success(t('settings.skills.imported'))
        await load()
      }
      catch (err) {
        message.error(err instanceof Error ? err.message : String(err))
      }
      finally {
        busyId.value = null
      }
    },
  })
}

async function toggle(item: ManagedRevision, checked: boolean): Promise<void> {
  busyId.value = item.id
  try {
    await apiFetch({
      base: '/api/system/skills',
      path: `/${encodeURIComponent(item.id)}`,
      init: { method: 'PATCH', body: JSON.stringify({ enabled: checked }) },
    })
    message.success(checked ? t('settings.skills.enabledDone') : t('settings.skills.disabledDone'))
    await load()
  }
  catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
  finally {
    busyId.value = null
  }
}

async function removeNow(item: ManagedRevision): Promise<void> {
  busyId.value = item.id
  try {
    await apiFetch({
      base: '/api/system/skills',
      path: `/${encodeURIComponent(item.id)}`,
      init: { method: 'DELETE' },
    })
    message.success(t('settings.skills.removed'))
    await load()
  }
  catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
  finally {
    busyId.value = null
  }
}

onMounted(load)
</script>

<template>
  <div v-show="activeTab === 'skills'">
    <h3 class="section-title">
      {{ t('settings.skillsTab') }}
    </h3>
    <p class="section-desc">
      {{ t('settings.skills.desc') }}
    </p>

    <a-alert
      v-if="error"
      type="error"
      show-icon
      :message="error"
      class="sk-notice"
    />
    <a-alert
      v-if="!canAdmin"
      type="info"
      show-icon
      :message="t('settings.skills.adminOnly')"
      class="sk-notice"
    />

    <div class="sk-toolbar">
      <a-button
        :loading="loading"
        @click="load"
      >
        <span class="i-tabler-refresh" /><span>{{ t('settings.skills.refresh') }}</span>
      </a-button>
      <span class="sk-roots">
        <span
          v-for="root in roots"
          :key="root.id"
          class="sk-root"
          :title="root.path"
        >{{ root.source }}</span>
      </span>
    </div>

    <h4 class="sk-subtitle">
      {{ t('settings.skills.managed') }}
    </h4>
    <a-table
      :data-source="managed"
      :pagination="false"
      row-key="id"
      size="small"
      :locale="{ emptyText: t('settings.skills.empty') }"
    >
      <a-table-column
        :title="t('settings.skills.name')"
        data-index="name"
      />
      <a-table-column
        :title="t('settings.skills.source')"
        data-index="source"
        width="110px"
      />
      <a-table-column
        :title="t('settings.skills.revision')"
        width="150px"
      >
        <template #default="{ record }">
          <span class="aw-mono">{{ record.contentHash.slice(0, 12) }}</span>
        </template>
      </a-table-column>
      <a-table-column
        :title="t('settings.skills.enabled')"
        width="110px"
      >
        <template #default="{ record }">
          <a-switch
            :checked="record.enabled"
            :disabled="!canAdmin || busyId === record.id"
            size="small"
            @change="(v: unknown) => toggle(record, v === true)"
          />
        </template>
      </a-table-column>
      <a-table-column
        :title="t('settings.skills.actions')"
        width="100px"
      >
        <template #default="{ record }">
          <ConfirmPopover
            :title="t('settings.skills.removeConfirm')"
            :description="`${record.name}@${record.contentHash.slice(0, 12)}`"
            :ok-text="t('common.delete')"
            :disabled="!canAdmin || busyId === record.id"
            @confirm="removeNow(record)"
          >
            <a-button
              danger
              type="link"
              size="small"
              :disabled="!canAdmin || busyId === record.id"
            >
              {{ t('common.delete') }}
            </a-button>
          </ConfirmPopover>
        </template>
      </a-table-column>
      <template #expandedRowRender="{ record }">
        <div class="sk-diag">
          <span class="aw-mono">{{ record.sourcePath }}</span>
          <span>{{ record.fileCount }} files · {{ record.totalBytes }} B</span>
          <a-tag
            v-for="d in diagnosticsOf(record)"
            :key="`${record.id}-${d.code}`"
            :color="d.level === 'error' ? 'red' : 'orange'"
          >
            {{ d.code }}
          </a-tag>
        </div>
      </template>
    </a-table>

    <h4 class="sk-subtitle">
      {{ t('settings.skills.discovered') }}
    </h4>
    <a-table
      :data-source="discovered"
      :pagination="false"
      row-key="id"
      size="small"
      :locale="{ emptyText: t('settings.skills.empty') }"
    >
      <a-table-column
        :title="t('settings.skills.name')"
        data-index="name"
      />
      <a-table-column
        :title="t('settings.skills.source')"
        data-index="source"
        width="110px"
      />
      <a-table-column
        :title="t('settings.skills.description')"
        data-index="description"
      />
      <a-table-column
        :title="t('settings.skills.actions')"
        width="100px"
      >
        <template #default="{ record }">
          <a-button
            type="link"
            size="small"
            :disabled="!canAdmin || record.source === 'managed' || busyId === record.id"
            @click="importSkill(record)"
          >
            {{ t('settings.skills.import') }}
          </a-button>
        </template>
      </a-table-column>
      <template #expandedRowRender="{ record }">
        <div class="sk-diag">
          <span class="aw-mono">{{ record.sourcePath }}</span>
          <span>{{ record.fileCount }} files · {{ record.totalBytes }} B</span>
          <a-tag
            v-for="d in diagnosticsOf(record)"
            :key="`${record.id}-${d.code}`"
            :color="d.level === 'error' ? 'red' : 'orange'"
          >
            {{ d.code }}
          </a-tag>
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

.sk-notice {
  margin-bottom: 12px;
}

.sk-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}

.sk-roots {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.sk-root {
  padding: 1px 8px;
  font-size: 11px;
  color: var(--ink-faint);
  border: 1px solid var(--line);
  border-radius: 999px;
}

.sk-subtitle {
  margin: 20px 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}

.sk-diag {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: var(--ink-faint);
}
</style>
