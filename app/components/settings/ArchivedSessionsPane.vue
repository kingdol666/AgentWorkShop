<script setup lang="ts">
/**
 * 系统设置 · 归档对话管理。
 *
 * 只呈现当前用户可见（自己拥有的 Channel / admin 全量）的已归档会话：
 *  - 恢复：清除归档标记，会话以 closed 状态回到普通会话清单；
 *  - 永久删除：二次确认（danger）后由服务端级联清理会话行、clone 成员、消息/
 *    群聊/任务/记忆与节点绑定持久层，不可恢复。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi, type ArchivedSessionDto } from '@/app/composables/workshop/useWorkshopApi'

defineProps<{ activeTab: string }>()

const { t } = useI18n()
const api = useWorkshopApi()

const rows = ref<ArchivedSessionDto[]>([])
const loading = ref(false)
const error = ref('')
const busyId = ref<string | null>(null)
/** 恢复/删除后通知会话侧栏重载（跨页面保持同一 Nuxt 状态）。 */
const sessionListRevision = useState<number>('aw-session-list-revision', () => 0)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await api.listArchivedSessions()
    rows.value = res.data ?? []
  }
  catch (err) {
    error.value = apiErrorMessage(err)
    rows.value = []
  }
  finally {
    loading.value = false
  }
}

onMounted(load)

const fmt = (iso: string | null): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

const statusLabel = (status: ArchivedSessionDto['status']): string =>
  status === 'closed'
    ? t('sessionManage.closed')
    : status === 'closing'
      ? t('settings.archived.statusClosing')
      : t('sessionManage.active')

async function restore(row: ArchivedSessionDto): Promise<void> {
  busyId.value = row.id
  try {
    await api.restoreChannelSession(row.channelId, row.id)
    message.success(t('settings.archived.restoreOk', { p0: row.title }))
    sessionListRevision.value += 1
    await load()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    busyId.value = null
  }
}

async function removeNow(row: ArchivedSessionDto): Promise<void> {
  busyId.value = row.id
  try {
    await api.deleteChannelSession(row.channelId, row.id)
    message.success(t('settings.archived.deleteOk', { p0: row.title }))
    sessionListRevision.value += 1
    await load()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    busyId.value = null
  }
}
</script>

<template>
  <div
    v-show="activeTab === 'archives'"
    data-testid="archived-sessions-pane"
  >
    <h3 class="section-title">
      {{ t('settings.archivesTab') }}
    </h3>
    <p class="section-desc">
      {{ t('settings.archived.desc') }}
    </p>

    <a-alert
      v-if="error"
      type="error"
      show-icon
      :message="error"
      class="ar-notice"
    />

    <div class="ar-toolbar">
      <a-button
        :loading="loading"
        data-testid="archived-refresh"
        @click="load"
      >
        <span class="i-tabler-refresh" /><span>{{ t('settings.archived.refresh') }}</span>
      </a-button>
      <span class="ar-count">{{ rows.length }}</span>
    </div>

    <a-table
      :data-source="rows"
      :pagination="false"
      row-key="id"
      size="small"
      :locale="{ emptyText: t('settings.archived.empty') }"
    >
      <a-table-column
        :title="t('settings.archived.title')"
        data-index="title"
      />
      <a-table-column
        :title="t('settings.archived.channel')"
        data-index="channelName"
        width="200px"
      />
      <a-table-column
        :title="t('settings.archived.status')"
        width="110px"
      >
        <template #default="{ record }">
          <a-tag :color="record.status === 'closed' ? 'default' : 'green'">
            {{ statusLabel(record.status) }}
          </a-tag>
        </template>
      </a-table-column>
      <a-table-column
        :title="t('settings.archived.archivedAt')"
        width="190px"
      >
        <template #default="{ record }">
          <span class="aw-mono">{{ fmt(record.archivedAt) }}</span>
        </template>
      </a-table-column>
      <a-table-column
        :title="t('settings.archived.actions')"
        width="190px"
      >
        <template #default="{ record }">
          <div class="ar-actions">
            <a-button
              type="link"
              size="small"
              :disabled="busyId === record.id"
              :data-testid="`archived-restore-${record.id}`"
              @click="restore(record)"
            >
              <span class="i-tabler-restore" /><span>{{ t('settings.archived.restore') }}</span>
            </a-button>
            <ConfirmPopover
              :title="t('settings.archived.deleteTitle', { p0: record.title })"
              :description="t('settings.archived.deleteDesc')"
              :ok-text="t('settings.archived.delete')"
              :disabled="busyId === record.id"
              @confirm="removeNow(record)"
            >
              <a-button
                danger
                type="link"
                size="small"
                :disabled="busyId === record.id"
                :data-testid="`archived-delete-${record.id}`"
              >
                <span class="i-tabler-trash" /><span>{{ t('settings.archived.delete') }}</span>
              </a-button>
            </ConfirmPopover>
          </div>
        </template>
      </a-table-column>
    </a-table>

    <p
      v-if="!loading && !error && rows.length === 0"
      class="ar-empty-hint"
    >
      {{ t('settings.archived.emptyHint') }}
    </p>
    <p class="ar-foot">
      {{ t('settings.archived.irreversible') }}
    </p>
  </div>
</template>

<style scoped>
.section-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 650;
  color: var(--ink);
}
.section-desc {
  margin: 0 0 14px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-soft);
}
.ar-notice { margin-bottom: 12px; }
.ar-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
}
.ar-count {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--ink-faint);
}
.ar-actions {
  display: inline-flex;
  gap: 2px;
  align-items: center;
}
.ar-actions :deep(.ant-btn) {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding-inline: 4px;
}
.ar-empty-hint {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: var(--ink-faint);
}
.ar-foot {
  margin: 16px 0 0;
  font-size: 11.5px;
  color: var(--ink-faint);
  border-top: 1px solid var(--line);
  padding-top: 10px;
}
</style>
