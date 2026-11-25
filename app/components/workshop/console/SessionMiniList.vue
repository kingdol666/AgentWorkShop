<script setup lang="ts">
/**
 * 侧栏「会话」分组(ChatGPT 历史语义):群聊 + 聚焦 Channel 的会话清单。
 * active 在前、closed 淡显；点击只在同一对话页切换作用域（null=群聊），不再跳独立页面。
 */
import { useWorkshopApi, type ChannelSessionSummaryDto } from '@/app/composables/workshop/useWorkshopApi'

const props = defineProps<{
  channelId?: string
  /** 当前对话页选中的会话；null = 群聊（由页面持有唯一选中） */
  activeSessionId?: string | null
}>()

const emit = defineEmits<{
  (e: 'open', sessionId: string | null): void
}>()

const api = useWorkshopApi()
const sessions = ref<ChannelSessionSummaryDto[]>([])
const loading = ref(false)
/** 多会话视图内的新建/改名/归档/关闭会 bump 该版本号，侧栏随之重载（无需整页刷新）。 */
const listRevision = useState<number>('aw-session-list-revision', () => 0)
let loadSeq = 0

const load = async (): Promise<void> => {
  const seq = ++loadSeq
  const id = props.channelId
  if (!id) {
    sessions.value = []
    loading.value = false
    return
  }
  loading.value = true
  try {
    const res = await api.listChannelSessions(id)
    if (seq !== loadSeq || id !== props.channelId) return
    const rows = res.data ?? []
    // active 在前,其余按创建时间倒序(ChatGPT「最近的对话在上」语义)
    sessions.value = [...rows].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1
      return b.createdAt.localeCompare(a.createdAt)
    })
  }
  catch {
    if (seq === loadSeq && id === props.channelId) sessions.value = []
  }
  finally {
    if (seq === loadSeq) loading.value = false
  }
}

watch([() => props.channelId, listRevision], load, { immediate: true })
defineExpose({ refresh: load })

const onPick = (s: ChannelSessionSummaryDto): void => {
  emit('open', s.id)
}
</script>

<template>
  <div class="mini">
    <button
      type="button"
      class="mini-row"
      :class="{ active: activeSessionId == null }"
      :title="$t('chatSessions.groupChat')"
      data-testid="session-mini-group"
      @click="emit('open', null)"
    >
      <span class="i-tabler-messages mini-group-icon" />
      <span class="mini-name">{{ $t('chatSessions.groupChat') }}</span>
    </button>

    <div
      v-if="loading && sessions.length === 0"
      class="mini-sync"
    >
      {{ $t('common.stateLoading') }}
    </div>
    <template v-else>
      <button
        v-for="s in sessions"
        :key="s.id"
        class="mini-row"
        :class="{ closed: s.status === 'closed', active: activeSessionId === s.id }"
        type="button"
        :title="s.title"
        :data-testid="`session-mini-${s.id}`"
        @click="onPick(s)"
      >
        <span
          class="mini-dot"
          :class="{ on: s.status === 'active' }"
        />
        <span class="mini-name">{{ s.title }}</span>
        <span class="mini-tag">{{ $t(s.channelMode === 'production_line_integrated' ? 'channelSessionList.modeIntegrated' : 'channelSessionList.modeGeneric') }}</span>
        <span
          v-if="s.instanceKind === 'task'"
          class="mini-tag"
        >
          <span class="i-tabler-flag" />
        </span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.mini {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.mini-sync {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--chat-ink-faint);
  opacity: 0.7;
}
.mini-row {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 7px 10px;
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 10px;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.mini-row:hover { background: color-mix(in srgb, var(--chat-ink) 6%, transparent); }
.mini-row.active { background: color-mix(in srgb, var(--chat-ink) 9%, transparent); }
.mini-row.active .mini-name {
  font-weight: 600;
  color: var(--chat-ink);
}
.mini-row.closed .mini-name { color: var(--chat-ink-faint); }
.mini-group-icon {
  flex: 0 0 auto;
  width: 13px;
  height: 13px;
  color: var(--chat-accent);
}
.mini-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  background: var(--chat-line-strong);
  border-radius: 50%;
}
.mini-dot.on {
  background: var(--chat-accent);
  box-shadow: 0 0 0 3px var(--chat-accent-soft);
}
.mini-name {
  flex: 1 1 auto;
  overflow: hidden;
  font-size: 12.5px;
  color: var(--chat-ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mini-row:hover .mini-name { color: var(--chat-ink); }
/* 任务会话标记:橙色小旗(与项目页任务会话徽标同一语义族) */
.mini-tag {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--chat-accent);
  font-size: 12px;
  opacity: 0.9;
}
.mini-row:focus-visible {
  outline: 2px solid var(--chat-accent);
  outline-offset: 1px;
}
</style>
