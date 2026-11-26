<script setup lang="ts">
/**
 * 会话 runtime 实例面板：列出 session 下每个 runtime 对象（clone agentId）的有效元数据。
 * 编辑在弹窗里完成；保存后仅该 runtime 的下一回合热切换，其他会话/模板不变。
 */
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useWorkshopApi, type SessionRuntimeDto } from '~/composables/workshop/useWorkshopApi'
import { apiErrorMessage } from '@/app/utils/api-error'

const props = defineProps<{
  channelId: string
  sessionId: string | null
}>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const { t } = useI18n()
const api = useWorkshopApi()
const items = ref<SessionRuntimeDto[]>([])
const loading = ref(false)
const error = ref('')
const editorOpen = ref(false)
const editing = ref<SessionRuntimeDto | null>(null)
const rebuildingId = ref('')
let loadSeq = 0

const activeItems = computed(() => items.value)

async function load(): Promise<void> {
  const sid = props.sessionId
  if (!sid) {
    items.value = []
    error.value = ''
    return
  }
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  try {
    const res = await api.listSessionRuntime(props.channelId, sid)
    if (seq !== loadSeq || props.sessionId !== sid) return
    items.value = res.data?.items ?? []
  }
  catch (err) {
    if (seq !== loadSeq || props.sessionId !== sid) return
    items.value = []
    error.value = apiErrorMessage(err)
  }
  finally {
    if (seq === loadSeq && props.sessionId === sid) loading.value = false
  }
}

watch(
  () => [props.channelId, props.sessionId] as const,
  () => { void load() },
  { immediate: true },
)

function edit(runtime: SessionRuntimeDto): void {
  editing.value = runtime
  editorOpen.value = true
}

function onSaved(runtime: SessionRuntimeDto): void {
  const index = items.value.findIndex(item => item.runtimeObjectId === runtime.runtimeObjectId)
  if (index >= 0) items.value[index] = runtime
  // 弹窗以 editing 为 props；同步刷新，409 后的服务端刷新才能回填新 revision。
  if (editing.value?.runtimeObjectId === runtime.runtimeObjectId) editing.value = runtime
  emit('changed')
}

function prefabLabel(runtime: SessionRuntimeDto): string {
  const prefab = runtime.effective.prefab
  if (!prefab) return t('sessionManage.runtime.prefabInherited')
  return `${prefab.name ?? prefab.prefabId} · r${prefab.revision}`
}

async function rebuild(runtime: SessionRuntimeDto): Promise<void> {
  const sid = props.sessionId
  if (!sid) return
  rebuildingId.value = runtime.runtimeObjectId
  try {
    const res = await api.rebuildSessionRuntime(props.channelId, sid, runtime.runtimeObjectId)
    message.success(res.data?.queued ? t('sessionManage.runtime.rebuildQueued') : t('sessionManage.runtime.rebuildAlreadyFresh'))
  }
  catch (err) {
    error.value = apiErrorMessage(err)
  }
  finally {
    rebuildingId.value = ''
  }
}

defineExpose({ refresh: load })
</script>

<template>
  <section
    class="srt-panel"
    data-testid="session-runtime-panel"
  >
    <header class="srt-head">
      <div>
        <h4>{{ t('sessionManage.runtime.title') }}</h4>
        <p>{{ t('sessionManage.runtime.hint') }}</p>
      </div>
      <button
        type="button"
        class="srt-refresh"
        :disabled="loading || !sessionId"
        data-testid="session-runtime-refresh"
        @click="load"
      >
        {{ t('sessionManage.runtime.refresh') }}
      </button>
    </header>

    <a-alert
      v-if="error"
      type="error"
      show-icon
      :message="error"
      class="srt-error"
    >
      <template #action>
        <a-button
          size="small"
          @click="load"
        >
          {{ t('sessionManage.runtime.retry') }}
        </a-button>
      </template>
    </a-alert>

    <div
      v-if="loading"
      class="srt-loading"
      role="status"
    >
      <a-spin size="small" />
      <span>{{ t('sessionManage.runtime.loading') }}</span>
    </div>

    <div
      v-else-if="activeItems.length === 0"
      class="srt-empty"
    >
      {{ t('sessionManage.runtime.empty') }}
    </div>

    <div
      v-else
      class="srt-table-wrap"
    >
      <table class="srt-table">
        <thead>
          <tr>
            <th>{{ t('sessionManage.runtime.objectId') }}</th>
            <th>{{ t('sessionManage.runtime.agent') }}</th>
            <th>{{ t('sessionManage.runtime.harness') }}</th>
            <th>{{ t('sessionManage.runtime.model') }}</th>
            <th>{{ t('sessionManage.runtime.prefab') }}</th>
            <th>{{ t('sessionManage.runtime.revision') }}</th>
            <th>{{ t('sessionManage.runtime.state') }}</th>
            <th>{{ t('sessionManage.runtime.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="runtime in activeItems"
            :key="runtime.runtimeObjectId"
            :data-testid="`session-runtime-row-${runtime.runtimeObjectId}`"
          >
            <td class="mono srt-id">
              <a-typography-text copyable>
                {{ runtime.runtimeObjectId }}
              </a-typography-text>
            </td>
            <td>
              {{ runtime.name }}
            </td>
            <td class="mono">
              {{ runtime.harness }}
              <a-tag
                v-if="runtime.harness !== runtime.baseHarness"
                color="gold"
                class="srt-custom-tag"
                :title="`${t('sessionManage.runtime.baseHarness')}: ${runtime.baseHarness}`"
              >
                {{ t('sessionManage.runtime.harnessOverridden') }}
              </a-tag>
            </td>
            <td class="mono">
              <template v-if="runtime.effective.model || runtime.effective.provider">
                {{ runtime.effective.provider ? `${runtime.effective.provider}/` : '' }}{{ runtime.effective.model ?? '—' }}
              </template>
              <template v-else>
                —
              </template>
              <span
                v-if="runtime.effective.effort"
                class="srt-effort"
              >· {{ runtime.effective.effort }}</span>
            </td>
            <td>{{ prefabLabel(runtime) }}</td>
            <td class="mono">
              {{ runtime.revision }}
              <a-tag
                :color="runtime.customized ? 'gold' : 'default'"
                class="srt-custom-tag"
              >
                {{ runtime.customized ? t('sessionManage.runtime.customized') : t('sessionManage.runtime.inherited') }}
              </a-tag>
            </td>
            <td>
              <a-tag :color="runtime.active ? (runtime.enabled === 1 ? 'green' : 'red') : 'default'">
                {{ runtime.active ? (runtime.enabled === 1 ? t('sessionManage.runtime.active') : t('sessionManage.runtime.disabled')) : t('sessionManage.runtime.closed') }}
              </a-tag>
            </td>
            <td>
              <div
                v-if="runtime.manageable && runtime.active && runtime.enabled === 1"
                class="srt-actions"
              >
                <a-button
                  size="small"
                  type="link"
                  :data-testid="`session-runtime-edit-${runtime.runtimeObjectId}`"
                  @click="edit(runtime)"
                >
                  {{ t('sessionManage.runtime.edit') }}
                </a-button>
                <ConfirmPopover
                  :title="t('sessionManage.runtime.rebuildTitle')"
                  :description="t('sessionManage.runtime.rebuildDesc')"
                  :ok-text="t('sessionManage.runtime.rebuild')"
                  @confirm="rebuild(runtime)"
                >
                  <a-button
                    size="small"
                    type="link"
                    :loading="rebuildingId === runtime.runtimeObjectId"
                    :data-testid="`session-runtime-rebuild-${runtime.runtimeObjectId}`"
                  >
                    {{ t('sessionManage.runtime.rebuild') }}
                  </a-button>
                </ConfirmPopover>
              </div>
              <span
                v-else
                class="muted small"
              >{{ runtime.manageable ? t('sessionManage.runtime.readonly') : t('sessionManage.runtime.managed') }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <workshop-session-runtime-edit-modal
      v-if="editing && sessionId"
      v-model:open="editorOpen"
      :channel-id="channelId"
      :session-id="sessionId"
      :runtime="editing"
      @saved="onSaved"
    />
  </section>
</template>

<style scoped>
.srt-panel {
  margin: 18px 0;
  padding: 14px 16px;
  border: 1px solid var(--line, #e5e7eb);
  border-radius: 6px;
  background: var(--surface-card, #fff);
}
.srt-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}
.srt-head h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.srt-head p {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--ink-soft, #6b7280);
}
.srt-refresh {
  border: 1px solid var(--line-strong, #d1d5db);
  background: transparent;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.srt-error {
  margin-top: 10px;
}
.srt-loading,
.srt-empty {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 18px 4px;
  font-size: 13px;
  color: var(--ink-soft, #6b7280);
}
.srt-table-wrap {
  margin-top: 10px;
  overflow-x: auto;
}
.srt-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.srt-table th,
.srt-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--line, #eef0f2);
  text-align: left;
  vertical-align: middle;
}
.srt-table th {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink-soft, #6b7280);
  font-weight: 600;
}
.srt-table tr:last-child td {
  border-bottom: none;
}
.srt-id {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.srt-effort {
  margin-left: 4px;
  color: var(--ink-soft, #6b7280);
}
.srt-custom-tag {
  margin-left: 6px;
}
.srt-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.mono {
  font-family: var(--font-mono, ui-monospace, monospace);
}
.muted {
  color: var(--ink-soft, #6b7280);
}
.small {
  font-size: 12px;
}
@media (max-width: 760px) {
  .srt-panel {
    padding: 12px;
  }
  .srt-table {
    min-width: 720px;
  }
}
</style>
