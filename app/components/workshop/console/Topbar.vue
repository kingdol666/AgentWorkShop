<script setup lang="ts">
/**
 * 控制台顶栏:工作区名 + 聚焦 channel 胶囊 + 视图切换条 + 侧栏/A2A/⌘K 图标钮 +
 * WS 连接态与 seq 读数。
 *
 * 状态全部由页面(编排层)经 props/v-model 注入,本组件只做呈现与事件转发,
 * 不持有第二份状态(切换条的双向绑定直接写回页面持有的 view)。
 * 窄屏形态差异(触摸目标、切换条独占一行)见文末 @media。
 */
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import type { WsState } from '@/app/stores/workshop/connection'
import type { CenterView } from '@/app/pages/workshop/composables/useWorkspaceShell'

const props = defineProps<{
  /** 工作区名(列表未返回时为 undefined,回落到 i18n 的未知态) */
  wsName?: string
  /** 聚焦 channel;undefined = 无频道(胶囊与切换条都不出现) */
  channelId?: string
  viewOptions: { value: string, label: string }[]
  /** 窄屏档(≤1023):左侧栏是覆盖式抽屉,入口钮与桌面版本不同 */
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
/** channel 胶囊文字:实体基线未到时退化为 id 前 8 位(可读占位,不是第二个名字来源) */
const channelLabel = computed(() => {
  const id = props.channelId
  if (!id) return ''
  return entities.channels[id]?.name ?? id.slice(0, 8)
})
const toggleLeft = (): void => {
  leftOpen.value = !leftOpen.value
}
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
      <span class="topbar-mark i-tabler-box" />
      <span class="ws-name">{{ wsName ?? $t('wsView.unknownWs') }}</span>
      <span
        v-if="channelId"
        class="chan-chip"
        :title="channelId"
      >
        <span class="chan-hash">#</span>{{ channelLabel }}
      </span>
      <a-segmented
        v-if="channelId"
        v-model:value="view"
        size="small"
        :options="viewOptions"
        class="view-switch"
        :title="$t('wsView.kqwckjr001')"
        @keydown="emit('viewKey', $event)"
      />
    </div>
    <div class="right">
      <!-- 窄屏:频道会话列表入口(覆盖式抽屉;该页一次只看一区) -->
      <button
        v-if="narrow"
        class="pane-toggle im toggle-left-narrow"
        :class="{ off: !leftOpen }"
        :title="$t('wsView.channelListTitle')"
        @click="toggleLeft"
      >
        <span class="i-tabler-list-details im-pop" />
      </button>
      <button
        class="pane-toggle im toggle-left-desk"
        :class="{ off: !leftOpen }"
        :title="$t('wsView.k1tsy2e4002')"
        @click="toggleLeft"
      >
        <span class="i-tabler-layout-sidebar-left-collapse im-pop" />
      </button>
      <button
        class="pane-toggle im toggle-right-desk"
        :class="{ off: !rightOpen }"
        :title="$t('wsView.k1tx0ppf003')"
        @click="toggleRight"
      >
        <span class="i-tabler-layout-sidebar-right-collapse im-pop" />
      </button>
      <button
        class="pane-toggle im"
        :title="$t('wsView.a2aTitle')"
        @click="emit('openA2a')"
      >
        <span class="i-tabler-terminal-2 im-pop" />
      </button>
      <button
        class="pane-toggle im"
        :title="$t('wsView.k1cvg8sb004')"
        @click="emit('openPalette')"
      >
        <span class="i-tabler-command im-pop" />
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
    </div>
  </div>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  font-size: 13px;
  background: var(--paper-raised);
  border-bottom: 1px solid var(--line);
}
.left,
.right {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.topbar-mark {
  font-size: 15px;
  color: var(--ink-faint);
}
.ws-name {
  max-width: 260px;
  overflow: hidden;
  font-family: var(--font-display);
  font-weight: 400;
  font-size: 17px;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* channel 胶囊:hairline chip + serif # */
.chan-chip {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  max-width: 200px;
  padding: 1px 10px;
  overflow: hidden;
  font-size: 12px;
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}
.chan-hash {
  font-family: var(--font-display);
  color: var(--ink-faint);
}
.view-switch { margin-left: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.ws-state {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}
.ws-state[data-state='open'] { color: var(--tone-success-dot); border-color: color-mix(in srgb, var(--tone-success-dot) 45%, transparent); }
.ws-state[data-state='connecting'] { color: var(--tone-warning-dot); border-color: color-mix(in srgb, var(--tone-warning-dot) 45%, transparent); }
.ws-state[data-state='closed'] { color: var(--tone-danger-dot); border-color: color-mix(in srgb, var(--tone-danger-dot) 45%, transparent); }
.seq {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  color: var(--ink-faint);
}

/* 侧栏折叠开关:幽灵图标钮 */
.pane-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  font-size: 14px;
  color: var(--ink-soft);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-panel-sm);
  transition: color var(--transition-fast), background var(--transition-fast), opacity var(--transition-fast);
}
.pane-toggle:hover {
  color: var(--ink);
  background: var(--paper-deep);
}
.pane-toggle.off {
  opacity: 0.4;
}
.pane-toggle.off:hover {
  opacity: 1;
}

/* ══════════════════════════════════════════════════════════════════════════
   窄屏形态 · 顶栏部分(≤1023px) —— 完整设计说明见页面
   app/pages/workshop/w/[wsId].vue 的「窄屏形态 · 单通道示波器」样式块:
   切换条独占一行承载全部区、触摸目标 ≥40px。断点数值与 main.css v5 /
   useResponsive.ts 一致(1024 = 三栏仪表台下限),此处不引入新魔数。
   ══════════════════════════════════════════════════════════════════════════ */
@media (max-width: 1023.98px) {
  .topbar {
    flex-wrap: wrap;
    gap: 6px 8px;
    padding: 8px 10px;
  }

  .topbar .left {
    row-gap: 8px;
  }

  .ws-name {
    max-width: 40vw;
    font-size: 15px;
  }

  .chan-chip {
    max-width: 34vw;
    font-size: 12px;
  }

  /* 切换条独占一行:五个视图名不再挤掉工作区名(channel 名仍可见) */
  .view-switch {
    flex: 1 1 100%;
    margin-left: 0;
  }

  .ws-state,
  .seq {
    font-size: 11.5px;
  }

  /* 触摸目标:26px 的幽灵图标钮在手持设备上点不中 */
  .pane-toggle {
    width: 40px;
    height: 40px;
    font-size: 18px;
  }

  .toggle-left-desk,
  .toggle-right-desk {
    display: none;
  }
}

/* 窄屏专属入口在桌面不出现(响应式形态差异不用 JS 表达,避免水合抖动) */
.toggle-left-narrow {
  display: none;
}

@media (max-width: 1023.98px) {
  .toggle-left-narrow {
    display: inline-flex;
  }
}
</style>
