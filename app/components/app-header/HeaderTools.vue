<script setup lang="ts">
import type { SelectProps } from 'ant-design-vue'
import { useWsConnectionStore } from '@/app/stores/workshop/connection'

defineProps<{
  /** 连接状态点只在客户端挂载后出现(SSR 没有 WS 会话可指示) */
  hydrated: boolean
}>()

const { t, locale, locales, setLocale } = useI18n()
const store = useAppStore()
const { isMobile } = useResponsive()

/* 语言选择器在窄屏显示"短名":完整语言名(简体中文=56px @14px)配上
 * antd 给箭头预留的 24px 内距,92px 的选择器只剩 46px 文本位 ——
 * 实测被截成「简 体…」,这是每页都出现的破相。
 * 窄屏用 2 字标签,桌面保留完整语言名。 */
const localeOptions = computed(() =>
  (locales.value as Array<{ code: string, name: string }>).map(l => ({
    label: isMobile.value ? l.code.split('-')[0]!.toUpperCase() : l.name,
    value: l.code,
  })),
)

const switchLocale: SelectProps['onChange'] = (value) => {
  if (value != null) {
    // 持久化 + 强刷:setup 期求值的词条(脚本常量)只有重载才能整体切换
    // cookie 参与 SSR 首帧(locale-cookie.global.ts);localStorage 保留为插件回退
    useCookie('aw.locale', { maxAge: 60 * 60 * 24 * 365 }).value = String(value)
    localStorage.setItem('aw.locale', String(value))
    setLocale(String(value) as 'zh-CN' | 'en')
    window.location.reload()
  }
}

// ── 实时连接状态点(全局 WS 单例的诚实在线指示;断连不假装在线) ──
const conn = useWsConnectionStore()
const wsVisible = computed(() => conn.state !== 'closed' || conn.lastDataAt > 0)
const wsClass = computed(() => {
  if (conn.state === 'open') return conn.pendingReplay ? 'syncing' : 'live'
  if (conn.state === 'connecting') return 'syncing'
  return 'down'
})
const wsLabel = computed(() => {
  if (conn.state === 'open') return conn.pendingReplay ? t('appHeader.kwsdot0002') : t('appHeader.kwsdot0001')
  if (conn.state === 'connecting') return t('appHeader.kwsdot0003')
  return t('appHeader.kwsdot0004')
})

const isFullscreen = ref(false)

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen()
    isFullscreen.value = true
  }
  else {
    document.exitFullscreen()
    isFullscreen.value = false
  }
}
</script>

<template>
  <!-- 实时连接状态点(WS 会话全局单例;未用过 WS 的会话不显示) -->
  <span
    v-if="hydrated && wsVisible"
    class="ws-dot"
    :class="wsClass"
    :title="wsLabel"
  />
  <a-tooltip :title="t('header.fullscreen')">
    <button
      class="icon-btn hdr-fullscreen"
      @click="toggleFullscreen"
    >
      <span
        class="i-tabler-arrows-maximize"
        :class="{ hidden: isFullscreen }"
      />
      <span
        class="i-tabler-arrows-minimize"
        :class="{ hidden: !isFullscreen }"
      />
    </button>
  </a-tooltip>

  <a-select
    id="hdr-locale"
    :value="locale"
    size="middle"
    :options="localeOptions"
    class="lang-select"
    @change="switchLocale"
  />

  <a-tooltip :title="store.isDark ? t('common.light') : t('common.dark')">
    <button
      class="icon-btn"
      @click="store.toggleDark()"
    >
      <span
        class="i-tabler-sun-high"
        :class="{ hidden: store.isDark }"
      />
      <span
        class="i-tabler-moon-stars"
        :class="{ hidden: !store.isDark }"
      />
    </button>
  </a-tooltip>
</template>

<style scoped>
/* 幽灵图标钮:无描边,悬停浮 surface(open-tag tp-close 声部) */
/* 本组件是 Fragment 根(状态点 + 两个 tooltip + 选择器),AppHeader 的 scoped
 * 选择器按 scope id 单根继承的规则到不了这里,故与父组件同一组规则在此原样重述;
 * CSS 声明逐字未改,只是同一份样式在两个作用域各自落地(否则这两个钮会掉回
 * 浏览器默认按钮样式)。 */
.collapse-btn,
.icon-btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  font-size: 16px;
  color: var(--app-text, var(--ink-soft));
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-panel-sm);
  transition:
    background var(--transition-fast),
    color var(--transition-fast),
    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}

.collapse-btn:hover,
.icon-btn:hover {
  color: var(--ink);
  background: var(--paper-deep);
}

.collapse-btn:active,
.icon-btn:active {
  transform: scale(0.94);
}

.lang-select {
  width: 118px;
}

/* 语言选择器:令牌驱动(主题失配时 antd 兜底色会露白,这里显式钉死) */
.lang-select :deep(.ant-select-selector) {
  color: var(--app-text, var(--ink));
  background: transparent !important;
  border-color: var(--app-border, var(--line)) !important;
}

.lang-select :deep(.ant-select-arrow) {
  color: var(--app-text-secondary, var(--ink-faint));
}

@media (max-width: 639px) {
  .hdr-fullscreen {
    display: none;
  }

  /* 窄屏标签已换成 2 字符(ZH / EN),选择器只需容纳标签 + 箭头 + 内距 */
  .lang-select {
    width: 76px;
  }

  .lang-select :deep(.ant-select-selection-item) {
    padding-inline-end: 16px;
    font-size: 12.5px;
  }
}

.hidden {
  display: none;
}

/* 实时连接状态点(诚实在线:open=绿/syncing=琥珀呼吸/closed=红;reduced-motion 全局收敛) */
.ws-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin: 0 2px;
  border-radius: 50%;
  background: var(--tone-success-dot);
  box-shadow: 0 0 6px color-mix(in srgb, var(--tone-success-dot) 55%, transparent);
}
.ws-dot.syncing {
  background: var(--tone-warning-dot);
  box-shadow: 0 0 6px color-mix(in srgb, var(--tone-warning-dot) 55%, transparent);
  animation: ws-pulse 1.2s ease-in-out infinite;
}
.ws-dot.down {
  background: var(--tone-danger-dot);
  box-shadow: 0 0 6px color-mix(in srgb, var(--tone-danger-dot) 55%, transparent);
}
@keyframes ws-pulse {
  50% { opacity: 0.45; }
}
</style>
