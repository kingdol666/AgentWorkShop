<script setup lang="ts">
/**
 * 对话页 · 会话宿主（2026-11-26 多会话并入对话页）。
 *
 * - 群聊：默认 ChatTimeline（频道群聊，人类 + Agent 同场）。
 * - 会话：同页内嵌 SessionManageView（隐藏其页头/卡栏），展示选中会话的成员、消息流、
 *   Session Context 与会话 composer；不再存在独立「多会话」页面。
 * - 顶部会话条负责切换（含群聊）、新建会话；会话详情内的改名/归档/关闭仍复用原实现。
 *
 * 选中权归父层（页面 chatSessionId）：侧栏会话列表、顶部会话条、归档后的自动回落
 * 都写同一份状态，避免两份选中副本。
 */
import { useWorkshopApi, type ChannelSessionSummaryDto } from '@/app/composables/workshop/useWorkshopApi'

const props = defineProps<{ channelId: string }>()
const sessionId = defineModel<string | null>('sessionId', { default: null })
const emit = defineEmits<{ (e: 'openAgent', id: string): void }>()

const { t } = useI18n()
const api = useWorkshopApi()
const sessionListRevision = useState<number>('aw-session-list-revision', () => 0)

const sessions = ref<ChannelSessionSummaryDto[]>([])
const loading = ref(false)
const loadError = ref('')
const loaded = ref(false)
const route = useRoute()
let listSeq = 0
let consumedDeepLink = ''
const sessionViewRef = ref<{ openCreate: () => void, refresh: () => Promise<void> } | null>(null)

/** a-select 用稳定哨兵值表示「群聊」，避免 null 与空字符串在组件间反复转换。 */
const GROUP_VALUE = '__channel_chat__'
const scopeValue = computed<string>({
  get: () => sessionId.value ?? GROUP_VALUE,
  set: (value) => {
    sessionId.value = value === GROUP_VALUE ? null : value
  },
})

const selectedSession = computed(() =>
  sessionId.value ? sessions.value.find(s => s.id === sessionId.value) ?? null : null,
)
const activeCount = computed(() => sessions.value.filter(s => s.status === 'active').length)

/** 项目页/通知深链：?session=<id> 在清单到达后选中一次，不覆盖用户后续手动切换。 */
function applyDeepLink(): void {
  const wanted = typeof route.query.session === 'string' ? route.query.session : ''
  if (!wanted || consumedDeepLink === wanted) return
  if (!sessions.value.some(s => s.id === wanted)) return
  sessionId.value = wanted
  consumedDeepLink = wanted
}

async function loadSessions(): Promise<void> {
  const seq = ++listSeq
  const channelId = props.channelId
  loading.value = true
  loadError.value = ''
  try {
    const res = await api.listChannelSessions(channelId)
    if (seq !== listSeq || channelId !== props.channelId) return
    sessions.value = res.data ?? []
    loaded.value = true
    // 选中会话已归档/删除 → 回群聊（只由宿主裁决，详情组件不抢选）。
    if (sessionId.value && !sessions.value.some(s => s.id === sessionId.value)) sessionId.value = null
    applyDeepLink()
  }
  catch (err) {
    if (seq !== listSeq || channelId !== props.channelId) return
    loadError.value = apiErrorMessage(err)
    sessions.value = []
    loaded.value = true
    sessionId.value = null
  }
  finally {
    if (seq === listSeq) loading.value = false
  }
}

const scopeOptions = computed(() => [
  { value: GROUP_VALUE, label: t('chatSessions.groupChat') },
  ...sessions.value.map(s => ({
    value: s.id,
    label: `${s.title}${s.status === 'closed' ? ` · ${t('sessionManage.closed')}` : ''}`,
  })),
])

const statusLabel = computed(() => {
  const status = selectedSession.value?.status
  if (!status) return ''
  return status === 'active' ? t('sessionManage.active') : t('sessionManage.closed')
})

function openCreate(): void {
  sessionViewRef.value?.openCreate()
}

async function retry(): Promise<void> {
  await Promise.all([loadSessions(), sessionViewRef.value?.refresh()])
}

async function onSessionsChanged(): Promise<void> {
  await loadSessions()
}

function onSelected(id: string | null): void {
  sessionId.value = id
}

watch(() => props.channelId, () => {
  sessionId.value = null
  loaded.value = false
  consumedDeepLink = ''
  void loadSessions()
}, { immediate: true })
watch(() => route.query.session, () => {
  consumedDeepLink = ''
  applyDeepLink()
})
watch(sessionListRevision, () => {
  void loadSessions()
})
</script>

<template>
  <div
    class="chat-session-host"
    data-testid="chat-session-host"
  >
    <div class="csh-bar">
      <div class="csh-main">
        <span class="csh-eyebrow">
          <span
            class="i-tabler-messages"
            aria-hidden="true"
          />
          {{ t('chatSessions.title') }}
        </span>
        <a-select
          v-model:value="scopeValue"
          class="csh-select"
          size="small"
          show-search
          option-filter-prop="label"
          :loading="loading"
          :options="scopeOptions"
          :aria-label="t('chatSessions.switchLabel')"
          data-testid="chat-session-select"
        />
        <a-tag
          v-if="selectedSession"
          :color="selectedSession.status === 'active' ? 'green' : 'default'"
        >
          {{ statusLabel }}
        </a-tag>
        <span
          v-if="sessions.length"
          class="csh-count"
          :title="t('chatSessions.activeCount', { p0: activeCount, p1: sessions.length })"
        >{{ t('chatSessions.activeCount', { p0: activeCount, p1: sessions.length }) }}</span>
        <span
          v-if="loadError"
          class="csh-error"
          role="alert"
        >{{ loadError }}</span>
      </div>
      <a-button
        v-if="loadError"
        size="small"
        data-testid="chat-session-retry"
        @click="retry"
      >
        <span
          class="i-tabler-refresh"
          aria-hidden="true"
        />
        <span>{{ t('common.stateRetry') }}</span>
      </a-button>
      <a-button
        size="small"
        :disabled="loading || (loaded && !!loadError)"
        data-testid="chat-session-create"
        @click="openCreate"
      >
        <span
          class="i-tabler-plus"
          aria-hidden="true"
        />
        <span>{{ t('chatSessions.new') }}</span>
      </a-button>
    </div>

    <workshop-chat-timeline
      v-if="!sessionId"
      :channel-id="channelId"
    />
    <!-- 会话详情常驻挂载（隐藏时也可通过 openCreate 打开其创建弹窗） -->
    <workshop-session-manage-view
      v-show="!!sessionId"
      ref="sessionViewRef"
      embedded
      :channel-id="channelId"
      :selected-session-id="sessionId"
      @open-agent="emit('openAgent', $event)"
      @select-session="onSelected"
      @sessions-changed="onSessionsChanged"
    />
  </div>
</template>

<style scoped>
.chat-session-host {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--chat-canvas);
}
.csh-bar {
  display: flex;
  flex: 0 0 auto;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 18px;
  border-bottom: 1px solid var(--chat-line);
  background: var(--chat-canvas);
}
.csh-main {
  display: flex;
  flex: 1 1 auto;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.csh-eyebrow {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 5px;
  align-items: center;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--chat-ink-faint);
  text-transform: uppercase;
}
.csh-eyebrow > span[class*="i-tabler"] {
  width: 13px;
  height: 13px;
}
.csh-select { width: min(360px, 42vw); }
.csh-count {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--chat-ink-faint);
}
.csh-error {
  overflow: hidden;
  font-size: 11.5px;
  color: var(--tone-danger-dot);
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 760px) {
  .csh-bar {
    flex-wrap: wrap;
    padding: 8px 12px;
  }
  .csh-main { flex-wrap: wrap; }
  .csh-select { width: 100%; }
  .csh-count { display: none; }
}
</style>
