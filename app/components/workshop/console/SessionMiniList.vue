<script setup lang="ts">
/**
 * 侧栏「会话」分组(ChatGPT 历史语义):聚焦 Channel 的会话清单,
 * active 在前、closed 淡显;点击切到多会话视图(视图状态归页面所有)。
 *
 * 数据自持:仅跟随聚焦 channelId 拉取(轻量 REST,不订阅 WS —— 多会话视图
 * 内已有完整实时流,这里只是导航入口,不需要第二份实时状态)。
 */
import { useWorkshopApi, type ChannelSessionDto } from '@/app/composables/workshop/useWorkshopApi'

const props = defineProps<{ channelId?: string }>()

const emit = defineEmits<{
  (e: 'open', sessionId: string): void
}>()

const api = useWorkshopApi()
const sessions = ref<ChannelSessionDto[]>([])
const loading = ref(false)

const load = async (): Promise<void> => {
  const id = props.channelId
  if (!id) {
    sessions.value = []
    return
  }
  loading.value = true
  try {
    const res = await api.listChannelSessions(id)
    const rows = res.data ?? []
    // active 在前,其余按创建时间倒序(ChatGPT「最近的对话在上」语义)
    sessions.value = [...rows].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1
      return b.createdAt.localeCompare(a.createdAt)
    })
  }
  catch {
    sessions.value = []
  }
  finally {
    loading.value = false
  }
}

watch(() => props.channelId, load, { immediate: true })
defineExpose({ refresh: load })

const onPick = (s: ChannelSessionDto): void => {
  emit('open', s.id)
}
</script>

<template>
  <div class="mini">
    <div
      v-if="loading && sessions.length === 0"
      class="mini-sync"
    >
      {{ $t('common.stateLoading') }}
    </div>
    <template v-else-if="sessions.length > 0">
      <button
        v-for="s in sessions.slice(0, 8)"
        :key="s.id"
        class="mini-row"
        :class="{ closed: s.status === 'closed' }"
        type="button"
        :title="s.title"
        @click="onPick(s)"
      >
        <span
          class="mini-dot"
          :class="{ on: s.status === 'active' }"
        />
        <span class="mini-name">{{ s.title }}</span>
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
.mini-row.closed .mini-name { color: var(--chat-ink-faint); }
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
