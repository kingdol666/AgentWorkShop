<script setup lang="ts">
/**
 * ⌘K/Ctrl+K 命令面板(P2):模糊搜索命令——导航/视图切换/Channel 切换/快捷动作。
 * 轻量自绘(不入全局 modal 队列);Esc 关闭,↑↓ 选择,Enter 执行。
 */
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useEventsStore } from '@/app/stores/workshop/events'

const { t } = useI18n()

const props = defineProps<{ wsId: string }>()
const open = defineModel<boolean>('open', { default: false })

const wsStore = useWorkspacesStore()
const entities = useEntitiesStore()
const events = useEventsStore()

const emit = defineEmits<{
  (e: 'setView', v: 'timeline' | 'lanes' | 'board' | 'split'): void
  (e: 'openA2aDebug' | 'compose'): void
}>()

interface Command {
  key: string
  label: string
  hint?: string
  run: () => void
}

const query = ref('')
const selected = ref(0)

const commands = computed<Command[]>(() => {
  const list: Command[] = [
    { key: 'nav-home', label: t('commandPalette.kmxxk3u006'), hint: '/workshop', run: () => navigateTo('/workshop') },
    { key: 'nav-agents', label: t('commandPalette.k4s8e5q007'), hint: '/workshop/agents', run: () => navigateTo('/workshop/agents') },
    { key: 'nav-teams', label: '前往:AgentTeam 编组库', hint: '/workshop/teams', run: () => navigateTo('/workshop/teams') },
    { key: 'nav-channel-templates', label: t('commandPalette.k1ezz11x008'), hint: '/workshop/channel-templates', run: () => navigateTo('/workshop/channel-templates') },
    { key: 'view-timeline', label: t('commandPalette.k143z9bg009'), run: () => { emit('setView', 'timeline') } },
    { key: 'view-lanes', label: '视图:Agent lanes', run: () => { emit('setView', 'lanes') } },
    { key: 'view-board', label: t('commandPalette.k13ztmim010'), run: () => { emit('setView', 'board') } },
    { key: 'view-split', label: t('commandPalette.k21cpnp011'), run: () => { emit('setView', 'split') } },
    { key: 'act-compose', label: t('commandPalette.k1tm54il012'), hint: '⌘I', run: () => { emit('compose') } },
    { key: 'act-a2a', label: '动作:A2A RPC/SSE 调试器', run: () => { emit('openA2aDebug') } },
  ]
  // Channel 切换
  for (const id of wsStore.workspaces.find(w => w.id === props.wsId)?.channelIds ?? []) {
    const name = entities.channels[id]?.name ?? id.slice(0, 8)
    list.push({
      key: `ch-${id}`,
      label: t('commandPalette.k1nz14ux013', { p0: name }),
      hint: id.slice(0, 8),
      run: () => wsStore.setActiveChannel(props.wsId, id),
    })
  }
  // 过滤器切换(当前聚焦 channel)
  const active = wsStore.workspaces.find(w => w.id === props.wsId)?.activeChannelId
  if (active) {
    const cur = events.filters[active] ?? 'all'
    for (const f of ['all', 'messages', 'tasks', 'errors'] as const) {
      if (f !== cur) {
        list.push({ key: `filter-${f}`, label: t('commandPalette.k1d8xtez014', { p0: f }), run: () => events.setFilter(active, f) })
      }
    }
  }
  return list
})

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return commands.value
  return commands.value.filter(c =>
    c.label.toLowerCase().includes(q) || (c.hint ?? '').toLowerCase().includes(q))
})

watch(filtered, () => {
  selected.value = 0
})

const execute = (cmd?: Command): void => {
  const target = cmd ?? filtered.value[selected.value]
  if (!target) return
  target.run()
  open.value = false
  query.value = ''
}

const onKeydown = (ev: KeyboardEvent): void => {
  if (ev.key === 'ArrowDown') {
    ev.preventDefault()
    selected.value = Math.min(selected.value + 1, filtered.value.length - 1)
  }
  else if (ev.key === 'ArrowUp') {
    ev.preventDefault()
    selected.value = Math.max(selected.value - 1, 0)
  }
  else if (ev.key === 'Enter') {
    ev.preventDefault()
    execute()
  }
  else if (ev.key === 'Escape') {
    open.value = false
  }
}

// 全局 ⌘K/Ctrl+K 唤起
const onGlobalKey = (ev: KeyboardEvent): void => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
    ev.preventDefault()
    open.value = !open.value
    query.value = ''
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))
</script>

<template>
  <teleport to="body">
    <div
      v-if="open"
      class="palette-mask"
      @click.self="open = false"
    >
      <div class="palette">
        <div class="palette-search">
          <span class="i-tabler-search ps-icon" />
          <input
            v-model="query"
            class="palette-input"
            :placeholder="$t('commandPalette.k1nn6i83001')"
            autofocus
            @keydown="onKeydown"
          >
        </div>
        <div class="palette-list">
          <button
            v-for="(c, i) in filtered"
            :key="c.key"
            type="button"
            class="palette-item"
            :class="{ selected: i === selected }"
            @click="execute(c)"
            @mousemove="selected = i"
          >
            <span class="pi-label">{{ c.label }}</span>
            <span
              v-if="c.hint"
              class="pi-hint"
            >{{ c.hint }}</span>
          </button>
          <div
            v-if="filtered.length === 0"
            class="palette-empty"
          >
            {{ $t('commandPalette.ktup4q4002') }}
          </div>
        </div>
        <div class="palette-foot">
          <kbd>↑↓</kbd> {{ $t('commandPalette.k1kvl0fa003') }} <kbd>↵</kbd> {{ $t('commandPalette.k1e3ualj004') }} <kbd>esc</kbd> {{ $t('commandPalette.k3x62t005') }}
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.palette-mask {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  background: var(--scrim, rgb(12 10 9 / 40%));
}
/* open-tag quick switcher 声部:轻量玻璃浮层(悬浮于画布之上,点到为止)。
 * 键盘发起(Ctrl+K)高频操作:不设开启动画,即时呈现 */
.palette {
  display: flex;
  flex-direction: column;
  width: 560px;
  max-width: 92vw;
  overflow: hidden;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-highlight), var(--shadow-float);
}
.palette-search {
  display: flex;
  gap: 9px;
  align-items: center;
  padding: 13px 16px;
  color: var(--ink-faint);
  border-bottom: 1px solid var(--line);
}
.ps-icon { font-size: 15px; flex: none; }
.palette-input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-body);
  font-size: 14px;
  color: var(--ink);
  background: transparent;
  border: none;
  outline: none;
}
.palette-input::placeholder { color: var(--ink-fainter); }
.palette-list {
  max-height: 320px;
  overflow-y: auto;
  padding: 6px;
}
.palette-item {
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 8px 10px;
  font-family: var(--font-body);
  font-size: 13.5px;
  color: var(--ink-soft);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-panel-sm);
}
.palette-item.selected {
  color: var(--ink);
  background: var(--paper-deep);
}
.pi-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pi-hint {
  flex: none;
  padding: 2px 8px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ink-faint);
  background: var(--paper-deep);
  border-radius: var(--radius-pill);
}
.palette-item.selected .pi-hint { background: var(--paper-raised); }
.palette-empty { padding: 18px; font-size: 13px; color: var(--ink-faint); text-align: center; }
.palette-frost,
.palette-foot {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 9px 16px;
  font-size: 11px;
  color: var(--ink-faint);
  border-top: 1px solid var(--line);
  background: var(--frost-bg);
}
.palette-foot kbd {
  padding: 1px 5px;
  font-family: var(--font-body);
  font-size: 10px;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}
</style>
