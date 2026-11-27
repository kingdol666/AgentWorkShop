<script setup lang="ts">
/**
 * 控制台左栏(ChatGPT 侧栏):Channel 会话侧栏(可滚动)+ 底部实时代理活动条。
 * 宽度由页面注入(拖拽分隔条住在页面那一层,宽度状态因此不在此组件);
 * 窄屏时本栏退化成覆盖式抽屉(见文末 @media:绝对定位 + pane-in 动画)。
 */
defineProps<{
  wsId: string
  /** 聚焦 channel(透传给侧栏的会话分组;undefined = 未聚焦) */
  channelId?: string
  /** 对话页当前选中会话(null=群聊)，侧栏会话高亮 */
  activeSessionId?: string | null
  leftWidth: number
  /** 窄屏档(≤1023):宽度不再由拖拽决定,改为抽屉定宽 */
  narrow: boolean
}>()

const emit = defineEmits<{
  (e: 'openAgent', target: { channelId: string, agentId: string }): void
  (e: 'openPalette' | 'close'): void
  (e: 'openSession', sessionId: string | null): void
}>()

const pane = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)

function focusDrawer(): void {
  closeButton.value?.focus({ preventScroll: true })
}

function onDrawerKey(ev: KeyboardEvent): void {
  const el = pane.value
  if (!el || ev.defaultPrevented || ev.isComposing || ev.keyCode === 229) return
  const target = ev.target
  // Teleported modals/select menus own their keyboard events, even if opened from this pane.
  if (target instanceof Node && target !== document.body && !el.contains(target)) return
  if (ev.key === 'Escape') {
    if (target instanceof Element && target.closest('[role="combobox"][aria-expanded="true"]')) return
    ev.preventDefault()
    emit('close')
  }
  else if (ev.key === 'Tab') {
    const stops = [...el.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]')]
      .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert], [aria-hidden="true"]')
        && node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible')
    const active = document.activeElement
    const edge = ev.shiftKey ? stops[stops.length - 1] : stops[0]
    if (!stops.some(node => node === active) || active === (ev.shiftKey ? stops[0] : stops[stops.length - 1])) {
      ev.preventDefault()
      const next = edge ?? el
      next.focus()
    }
  }
}

defineExpose({ focusDrawer, onDrawerKey })
</script>

<template>
  <div
    id="workspace-channel-drawer"
    ref="pane"
    class="left-pane"
    :style="{ flexBasis: narrow ? 'auto' : `${leftWidth}px` }"
    :role="narrow ? 'dialog' : undefined"
    :aria-modal="narrow ? 'true' : undefined"
    :aria-labelledby="narrow ? 'workspace-channel-drawer-title' : undefined"
    :tabindex="narrow ? -1 : undefined"
  >
    <div
      v-if="narrow"
      class="drawer-head"
    >
      <h2 id="workspace-channel-drawer-title">
        {{ $t('wsView.channelListTitle') }}
      </h2>
      <button
        ref="closeButton"
        class="drawer-close"
        type="button"
        :aria-label="$t('common.close')"
        @click="emit('close')"
      >
        <span
          class="i-tabler-x"
          aria-hidden="true"
        />
      </button>
    </div>
    <div class="left-scroll">
      <workshop-channel-session-list
        :ws-id="wsId"
        :channel-id="channelId"
        :active-session-id="activeSessionId"
        @open-session="emit('openSession', $event)"
        @open-palette="emit('openPalette')"
      />
    </div>
    <workshop-live-agent-bar
      :ws-id="wsId"
      @open-agent="emit('openAgent', $event)"
    />
  </div>
</template>

<style scoped>
.left-pane {
  display: flex;
  flex: 0 0 auto; /* 宽度由拖拽分隔条驱动(inline flexBasis) */
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--chat-surface-raised);
}
.left-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden auto;
  overscroll-behavior: contain;
}
.drawer-head {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px 5px 16px;
  border-bottom: 1px solid var(--chat-line);
}
.drawer-head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
  color: var(--chat-ink);
}
.drawer-close {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 40px;
  height: 40px;
  font-size: 19px;
  color: var(--chat-ink);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 8px;
}
.drawer-close:hover { background: var(--chat-surface); }
.drawer-close:focus-visible { outline: 2px solid var(--chat-accent); }

/* ══════════════════════════════════════════════════════════════════════════
   窄屏形态 · 左栏部分(≤1023px) —— 完整设计说明见页面
   app/pages/workshop/w/[wsId].vue 的「窄屏形态 · 单通道示波器」样式块:
   会话列表不再占位,收成覆盖式抽屉(点遮罩/Esc/选中频道收起)。
   断点数值与 main.css v5 / useResponsive.ts 一致,不引入新魔数。
   ══════════════════════════════════════════════════════════════════════════ */
@media (max-width: 1023.98px) {
  .left-pane {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 30;
    width: min(86vw, 320px);
    border-right: 1px solid var(--chat-line);
    box-shadow: var(--chat-shadow);
    animation: pane-in 0.18s cubic-bezier(0.22, 1, 0.36, 1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .left-pane {
    animation: none;
  }
}

@keyframes pane-in {
  from {
    opacity: 0.5;
    transform: translateX(-16px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}
</style>
