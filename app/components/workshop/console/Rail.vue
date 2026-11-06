<script setup lang="ts">
/**
 * 控制台图标轨(ChatGPT 式 rail,56px 常驻左缘):
 *   顶部 侧栏开合 → 品牌(回总览) → ⌘K →
 *   中部 七个视图位(对话/时间线/泳道/任务板/同屏/小镇/多会话;tooltip+active 填充态)
 *   → A2A 调试器 →
 *   底部 头像(回总览;登录态逃生口)。
 *
 * 视图语义与数字快捷键/⌘K/深链同一份状态(页面持有的 view),本组件只做呈现与上抛。
 * 窄屏(≤1023)不渲染本轨(页面层 v-if)——切换条仍由顶栏承载。
 */
import { useUserStore } from '@/app/stores/workshop/user'
import type { CenterView } from '@/app/pages/workshop/composables/useWorkspaceShell'

defineProps<{
  /** 聚焦 channel;undefined = 无频道(视图位禁用,仅品牌/侧栏/⌘K/A2A 可用) */
  channelId?: string
}>()

const view = defineModel<CenterView>('view', { required: true })
const leftOpen = defineModel<boolean>('leftOpen', { required: true })

const emit = defineEmits<{
  (e: 'openA2a' | 'openPalette'): void
}>()

const userStore = useUserStore()

const items: Array<{ value: CenterView, icon: string, key: string }> = [
  { value: 'chat', icon: 'i-tabler-messages', key: 'wsView.chat' },
  { value: 'timeline', icon: 'i-tabler-activity', key: 'wsView.k3otu32010' },
  { value: 'lanes', icon: 'i-tabler-route', key: 'wsView.lanes' },
  { value: 'board', icon: 'i-tabler-list-check', key: 'wsView.k3ko7a8011' },
  { value: 'split', icon: 'i-tabler-layout-2', key: 'wsView.k3xbmo012' },
  { value: 'town', icon: 'i-tabler-map-2', key: 'wsView.k1cz0pbw013' },
  { value: 'sessions', icon: 'i-tabler-stack-2', key: 'wsView.sessions' },
]

/** 头像字母(邮箱首字符;未登录时回退站标) */
const avatarLetter = computed(() => (userStore.user?.email?.trim()?.[0] ?? 'A').toUpperCase())
const goOverview = (): void => {
  navigateTo('/workshop')
}
</script>

<template>
  <nav
    class="rail"
    aria-label="Console rail"
  >
    <div class="rail-group">
      <button
        class="rail-btn"
        :class="{ off: !leftOpen }"
        type="button"
        :title="$t('wsView.k1tsy2e4002')"
        @click="leftOpen = !leftOpen"
      >
        <span class="i-tabler-layout-sidebar-left-collapse im-pop" />
      </button>
      <button
        class="rail-btn rail-brand"
        type="button"
        title="AgentWorkShop"
        @click="goOverview"
      >
        <span class="i-tabler-box im-pop" />
      </button>
      <button
        class="rail-btn"
        type="button"
        :title="$t('wsView.k1cvg8sb004')"
        @click="emit('openPalette')"
      >
        <span class="i-tabler-command im-pop" />
      </button>
    </div>

    <div class="rail-rule" />

    <div class="rail-group rail-views">
      <button
        v-for="it in items"
        :key="it.value"
        class="rail-btn"
        :class="{ active: view === it.value, dim: !channelId }"
        type="button"
        :disabled="!channelId"
        :title="$t(it.key)"
        :aria-label="$t(it.key)"
        @click="view = it.value"
      >
        <span :class="[it.icon, 'im-pop']" />
      </button>
    </div>

    <div class="rail-rule" />

    <div class="rail-group">
      <button
        class="rail-btn"
        type="button"
        :title="$t('wsView.a2aTitle')"
        @click="emit('openA2a')"
      >
        <span class="i-tabler-terminal-2 im-pop" />
      </button>
    </div>

    <div class="rail-foot">
      <button
        class="rail-avatar"
        type="button"
        :title="userStore.user?.email ?? 'owner'"
        @click="goOverview"
      >
        {{ avatarLetter }}
      </button>
    </div>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  flex: 0 0 56px;
  flex-direction: column;
  align-items: center;
  min-height: 0;
  padding: 10px 0 12px;
  background: var(--chat-surface-raised);
  border-right: 1px solid var(--chat-line);
}
.rail-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: center;
}
.rail-views { margin-top: 2px; }
.rail-rule {
  width: 28px;
  height: 1px;
  margin: 8px 0;
  background: var(--chat-line);
}

/* ChatGPT rail 按钮:幽灵圆角方块;active=填充态(不用橙,靠灰阶+油墨表达) */
.rail-btn {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  font-size: 17px;
  color: var(--chat-ink-soft);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 10px;
  transition: color var(--transition-fast), background var(--transition-fast);
}
.rail-btn:hover {
  color: var(--chat-ink);
  background: color-mix(in srgb, var(--chat-ink) 6%, transparent);
}
.rail-btn.active {
  color: var(--chat-ink);
  background: color-mix(in srgb, var(--chat-ink) 10%, transparent);
}
.rail-btn.dim,
.rail-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.rail-btn.dim:hover,
.rail-btn:disabled:hover {
  color: var(--chat-ink-soft);
  background: transparent;
}
.rail-brand { color: var(--chat-ink); }
.rail-brand .im-pop { font-size: 19px; }
.rail-btn.off { opacity: 0.5; }
.rail-btn.off:hover { opacity: 1; }
.rail-btn:focus-visible {
  outline: 2px solid var(--chat-accent);
  outline-offset: 1px;
}

.rail-foot {
  display: flex;
  align-items: center;
  justify-content: center;
  padding-top: 10px;
  margin-top: auto;
}
/* 头像:油墨圆片(白字首字母,与全站 --av 语义一致) */
.rail-avatar {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  font-size: 13px;
  font-weight: 650;
  color: var(--on-av, #fff);
  cursor: pointer;
  background: var(--av-fallback, #57534e);
  border: 0;
  border-radius: 50%;
  transition: filter var(--transition-fast);
}
.rail-avatar:hover { filter: brightness(1.12); }

@media (max-width: 1023.98px) {
  .rail { display: none; }
}
</style>
