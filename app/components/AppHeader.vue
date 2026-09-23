<script setup lang="ts">
import { useUserStore } from '@/app/stores/workshop/user'
import { useHitlStore } from '@/app/stores/workshop/hitl'
import { useChatStore } from '@/app/stores/workshop/chat'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import TrailNav from '@/app/components/app-header/TrailNav.vue'
import HitlBell from '@/app/components/app-header/HitlBell.vue'
import HeaderTools from '@/app/components/app-header/HeaderTools.vue'
import UserChip from '@/app/components/app-header/UserChip.vue'

const { t } = useI18n()
const store = useAppStore()
const route = useRoute()
const trail = useRouteTrailStore()
const userStore = useUserStore()
const { metaFor } = useRouteMeta()

// ── HITL 全局待办(omp ask 对话框 + 各引擎原生提问/审批统一徽标;页头保底建连 ——
//    用户定向帧只达已连 peer,不建连的页面收不到提醒;快照兜底刷新前待办) ──
const hitl = useHitlStore()
const chat = useChatStore()
const wsSession = useWorkshopWs()
const ensureHitlLive = () => {
  if (userStore.isLoggedIn) wsSession.ensureConnected()
}
watch(() => userStore.token, (t2) => {
  if (t2) {
    ensureHitlLive()
    void hitl.loadSnapshot()
  }
  else hitl.clear()
}, { immediate: true })

// ===== 权限:能否审批由服务端能力视图决定(owner_only 时非 owner 不给控件) =====
// channelPermissionsOf 是唯一事实源;缺它的 channel 先拉一次(非成员也可调用)
watch(() => hitl.items.map(i => i.channelId).join('|'), (key) => {
  for (const cid of new Set(key.split('|').filter(Boolean))) {
    if (!(cid in chat.permissions)) void chat.loadPermissions(cid)
  }
}, { immediate: true })

/* ── 响应式:窄屏顶栏不是"缩小版顶栏",而是换一套信息优先级 ─────────────
 * 桌面:航迹页签是主角(多页并行来回切)。
 * 窄屏:页签轨与右侧功能簇争抢横向空间 —— 实测 390px 下页签被右侧图标
 *       逐个压过去,最后连用户铭牌都被推出视口(顶栏 overflow:hidden 直接裁掉)。
 *       所以窄屏撤掉页签轨,用**当前页标题**替代:窄屏用户要的是"我在哪",
 *       不是"我刚才还开过哪 5 个页面"。 */
const { isDrawer } = useResponsive()

const navToggleLabel = computed(() =>
  isDrawer.value
    ? (store.mobileNavOpen ? t('header.closeNav') : t('header.openNav'))
    : (store.sidebarCollapsed ? t('header.expand') : t('header.collapse')))

const toggleNav = () => {
  if (isDrawer.value) store.toggleMobileNav()
  else store.toggleSidebar()
}

const currentTitle = computed(() => metaFor(route.path).title)

// ── 航迹导航:路由变化 → 记录航点;切换时进度线扫过 ──
const hydrated = ref(false)
const plotting = ref(false)
let plotTimer: ReturnType<typeof setTimeout> | null = null

watch(() => route.path, () => {
  trail.visit(route.path)
  plotting.value = false
  requestAnimationFrame(() => {
    plotting.value = true
    if (plotTimer) clearTimeout(plotTimer)
    plotTimer = setTimeout(() => {
      plotting.value = false
    }, 620)
  })
}, { immediate: false })

onMounted(() => {
  hydrated.value = true
  trail.visit(route.path)
})

onBeforeUnmount(() => {
  if (plotTimer) clearTimeout(plotTimer)
})
</script>

<template>
  <a-layout-header
    class="app-header app-header-glass"
  >
    <!-- 左侧:折叠 + 航迹标绘轨 -->
    <div class="header-left">
      <button
        class="collapse-btn"
        :aria-label="navToggleLabel"
        :aria-expanded="isDrawer ? store.mobileNavOpen : !store.sidebarCollapsed"
        @click="toggleNav()"
      >
        <span class="i-tabler-menu-2" />
      </button>

      <!-- 窄屏:当前页标题(替代被撤掉的页签轨) -->
      <span class="mobile-title">{{ currentTitle }}</span>

      <span class="rail-mark i-tabler-route" />

      <TrailNav :hydrated="hydrated" />
    </div>

    <!-- 右侧:功能集群 -->
    <div class="header-right">
      <!-- 用户通知铃(@ 提及 / Agent 回复 / 审批;user-scoped 定向推送,补拉走 DB 游标) -->
      <ClientOnly>
        <workshop-notification-center />
      </ClientOnly>
      <!-- HITL 待办铃标(有待办才出现;下拉内联应答,或点条目进入运行时监控) -->
      <ClientOnly>
        <HitlBell />
      </ClientOnly>
      <HeaderTools :hydrated="hydrated" />
      <UserChip />
    </div>

    <!-- 绘图仪进度线:路由切换时自左向右扫过 -->
    <span
      class="plotter-line"
      :class="{ run: plotting }"
      aria-hidden="true"
    />
  </a-layout-header>
</template>

<style scoped>
.app-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--app-header-h, 56px);
  padding: 0 20px 0 10px;
  overflow: hidden;
  border-bottom: 1px solid var(--divider-hair);
  transition: background 0.3s ease, border-color 0.3s ease;
}

/* 顶栏玻璃:透出极光画布;下缘发丝线 + 微暗渐变保对比
 * v4:与侧栏同属壳层材质(同一观察窗),底部内阴影替代原先的顶部渐变 —— 玻璃的"厚度"来自遮蔽而非压暗 */
.app-header-glass {
  position: sticky;
  top: 0;
  z-index: 30;
  background: var(--mat-chrome-bg);
  backdrop-filter: var(--vibrancy-chrome);
  border-bottom: 1px solid var(--glass-line);
  box-shadow: var(--glass-specular);
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

/* ── 航迹标绘轨 ── */
.rail-mark {
  flex: 0 0 auto;
  font-size: 15px;
  color: var(--ink-faint);
}

/* 路由切换进度线:墨色细扫过(替换原天青→蜜桃粉彩渐变,色锁:温灰下仅墨色动线) */
.plotter-line {
  position: absolute;
  bottom: -1px;
  left: 0;
  width: 100%;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--ink-fainter) 30%, var(--accent));
  opacity: 0;
  pointer-events: none;
  transform: scaleX(0);
  transform-origin: left center;
}

.plotter-line.run {
  animation: plot-sweep 0.6s cubic-bezier(0.3, 0.8, 0.4, 1) forwards;
}

@keyframes plot-sweep {
  0% {
    transform: scaleX(0);
    opacity: 0.9;
  }

  70% {
    opacity: 0.9;
  }

  100% {
    transform: scaleX(1);
    opacity: 0;
  }
}

/* 幽灵图标钮:无描边,悬停浮 surface(open-tag tp-close 声部) */
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

/* 移动端当前页标题:桌面不存在(那里有页签轨) */
.mobile-title {
  display: none;
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  color: var(--app-text, var(--ink));
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ══ 顶栏响应式:按信息优先级逐级卸载,而不是让它们互相挤压 ═══════════════
 * 卸载顺序(从最可省到最不可省):页签轨 → 全屏钮 → 用户双行铭牌 → 语言文字。
 * 留下的核心是:HITL 铃标(有待办必须看得见)、连接状态点、主题、语言、身份。 */
@media (max-width: 899px) {
  .rail-mark {
    display: none;
  }

  .mobile-title {
    display: block;
    margin-left: 2px;
  }

  .app-header {
    padding: 0 12px 0 8px;
  }
}

@media (max-width: 639px) {
  .header-left,
  .header-right {
    gap: 4px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .plotter-line.run {
    animation: none;
    opacity: 0;
  }
}
</style>
