<script setup lang="ts">
/**
 * 中央列标题条(ChatGPT 会话标题条):频道名为主标题 + 连接态读数 + 右侧图标钮。
 *
 * 2026-11-07 控制台 ChatGPT 化:工作区名移入侧栏头部、品牌移入图标轨、
 * 桌面期视图切换移入图标轨 —— 本条只留「当前频道」的标题语义。
 * 窄屏(≤1023)例外:图标轨不渲染,视图切换条并入本条(独占一行、可横扫)。
 *
 * 状态全部由页面(编排层)经 props/v-model 注入,本组件只做呈现与事件转发,
 * 不持有第二份状态(切换条的双向绑定直接写回页面持有的 view)。
 */
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import type { WsState } from '@/app/stores/workshop/connection'
import type { CenterView } from '@/app/pages/workshop/composables/useWorkspaceShell'

const props = defineProps<{
  /** 工作区名(窄屏标题副行用;桌面期由侧栏承载) */
  wsName?: string
  /** 聚焦 channel;undefined = 无频道(标题与切换条都不出现) */
  channelId?: string
  viewOptions: { value: string, label: string }[]
  /** 窄屏档(≤1023):左侧栏是覆盖式抽屉,视图切换条并入本条 */
  narrow: boolean
  stateColor: string
  connState: WsState
  lastSeq: number
}>()

const view = defineModel<CenterView>('view', { required: true })
const leftOpen = defineModel<boolean>('leftOpen', { required: true })
const rightOpen = defineModel<boolean>('rightOpen', { required: true })

const emit = defineEmits<{
  (e: 'viewKey', ev: KeyboardEvent): void
  (e: 'openA2a' | 'openPalette'): void
}>()

const entities = useEntitiesStore()
/** 标题文字:实体基线未到时退化为 id 前 8 位(可读占位,不是第二个名字来源) */
const channelLabel = computed(() => {
  const id = props.channelId
  if (!id) return ''
  return entities.channels[id]?.name ?? id.slice(0, 8)
})
const toggleRight = (): void => {
  rightOpen.value = !rightOpen.value
}
</script>

<template>
  <div class="topbar">
    <div
      class="left"
      tabindex="-1"
      @keydown="emit('viewKey', $event)"
    >
      <span
        v-if="channelId"
        class="chan-title"
        :title="channelId"
      >
        <span class="chan-hash">#</span>{{ channelLabel }}
      </span>
      <span
        v-else
        class="chan-title placeholder"
      >{{ wsName ?? $t('wsView.unknownWs') }}</span>
    </div>
    <div class="right">
      <!-- 审批待办:裸控制台也保留全局 HITL 入口(否则聊天中收不到审批) -->
      <ClientOnly>
        <HitlBell />
      </ClientOnly>
      <!-- 窄屏:频道会话列表入口(覆盖式抽屉;该页一次只看一区) -->
      <button
        class="pane-toggle im toggle-left-narrow"
        :class="{ off: !leftOpen }"
        :aria-label="$t('wsView.channelListTitle')"
        :aria-pressed="leftOpen"
        :title="$t('wsView.channelListTitle')"
        @click="leftOpen = !leftOpen"
      >
        <span class="i-tabler-list-details im-pop" />
      </button>
      <span
        class="dot"
        :style="{ background: stateColor }"
      />
      <span
        class="ws-state"
        :data-state="connState"
      >{{ connState }}</span>
      <span class="seq">seq {{ lastSeq }}</span>
      <span class="right-rule" />
      <button
        class="pane-toggle im toggle-right-desk"
        :class="{ off: !rightOpen }"
        :aria-label="$t('wsView.k1tx0ppf003')"
        :aria-pressed="rightOpen"
        :title="$t('wsView.k1tx0ppf003')"
        @click="toggleRight"
      >
        <span class="i-tabler-layout-sidebar-right-collapse im-pop" />
      </button>
      <button
        class="pane-toggle im"
        :aria-label="$t('wsView.a2aTitle')"
        :title="$t('wsView.a2aTitle')"
        @click="emit('openA2a')"
      >
        <span class="i-tabler-terminal-2 im-pop" />
      </button>
      <button
        class="pane-toggle im toggle-palette-narrow"
        :aria-label="$t('wsView.k1cvg8sb004')"
        :title="$t('wsView.k1cvg8sb004')"
        @click="emit('openPalette')"
      >
        <span class="i-tabler-command im-pop" />
      </button>
    </div>

    <!-- 窄屏:视图切换条独占一行(桌面期在图标轨,此处不渲染) -->
    <a-segmented
      v-if="narrow && channelId"
      v-model:value="view"
      size="small"
      :options="viewOptions"
      class="view-switch"
      :aria-label="$t('wsView.kqwckjr001')"
      :title="$t('wsView.kqwckjr001')"
      @keydown="emit('viewKey', $event)"
    />
  </div>
</template>

<style scoped>
.topbar {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 6px 8px;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  background: var(--chat-canvas);
  border-bottom: 1px solid var(--chat-line);
}
.left,
.right {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
/* 频道名 = 会话标题(ChatGPT 顶栏语义):15px/600 油墨,mono # 前缀弱化为记号 */
.chan-title {
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--chat-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chan-title.placeholder {
  font-weight: 500;
  color: var(--chat-ink-soft);
}
.chan-hash {
  margin-right: 5px;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--chat-ink-faint);
}

.dot { width: 8px; height: 8px; border-radius: 50%; }
.ws-state {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--chat-ink-faint);
}
.ws-state[data-state='open'] { color: var(--tone-success-dot); }
.ws-state[data-state='connecting'] { color: var(--tone-warning-dot); }
.ws-state[data-state='closed'] { color: var(--tone-danger-dot); }
.seq {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
  opacity: 0.8;
}
.right-rule {
  width: 1px;
  height: 16px;
  margin: 0 2px;
  background: var(--chat-line);
}

/* 幽灵图标钮(ChatGPT 标题条右侧语义) */
.pane-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  font-size: 15px;
  color: var(--chat-ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 8px;
  transition: color var(--transition-fast), background var(--transition-fast), opacity var(--transition-fast);
}
.pane-toggle:hover {
  color: var(--chat-ink);
  background: color-mix(in srgb, var(--chat-ink) 6%, transparent);
}
.pane-toggle.off { opacity: 0.4; }
.pane-toggle.off:hover { opacity: 1; }
.pane-toggle:focus-visible {
  outline: 2px solid var(--chat-accent);
  outline-offset: 1px;
}

/* 窄屏专属入口在桌面不出现(响应式形态差异不用 JS 表达,避免水合抖动) */
.toggle-palette-narrow,
.toggle-left-narrow { display: none; }
.view-switch {
  flex: 1 1 100%;
  overflow-x: auto;
  scrollbar-width: none;
}
.view-switch::-webkit-scrollbar { display: none; }

/* ══════════════════════════════════════════════════════════════════════════
   窄屏形态 · 顶栏部分(≤1023px) —— 完整设计说明见页面
   app/pages/workshop/w/[wsId].vue 的「窄屏形态 · 单通道示波器」样式块:
   切换条独占一行承载全部区、触摸目标 ≥40px。断点数值与 main.css v5 /
   useResponsive.ts 一致(1024 = 三区应用框下限),此处不引入新魔数。
   ══════════════════════════════════════════════════════════════════════════ */
@media (max-width: 1023.98px) {
  .topbar {
    padding: 8px 10px;
  }

  .chan-title { max-width: 52vw; }

  .ws-state,
  .seq { font-size: 11.5px; }

  /* 触摸目标:30px 的幽灵图标钮在手持设备上点不中 */
  .pane-toggle {
    width: 40px;
    height: 40px;
    font-size: 18px;
  }

  .toggle-right-desk { display: none; }

  .toggle-palette-narrow,
  .toggle-left-narrow { display: inline-flex; }
}

/* 手机(≤640):seq 让位(标题优先)。连接态仍可见。 */
@media (max-width: 640px) {
  .seq { display: none; }

  .view-switch {
    -webkit-mask-image: linear-gradient(90deg, #000 0 90%, transparent 100%);
    mask-image: linear-gradient(90deg, #000 0 90%, transparent 100%);
  }
}
</style>
