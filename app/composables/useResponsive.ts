/**
 * 视口断点(browser-only,SSR 安全) —— 全站响应式布局的唯一判据。
 *
 * 为什么需要它:CSS 媒体查询能改样式,但改不了**行为**——
 * 窄屏的侧栏不是"收窄的侧栏",而是一个抽屉(开合状态、焦点陷阱、滚动锁定
 * 都是行为)。行为必须由 JS 知道当前处于哪一档。
 *
 * 断点值与 main.css v5 响应式层注释一一对应(那里是数值的唯一出处):
 *   ≥1024 桌面 / 900–1023 图标轨 / 640–899 抽屉 / <640 单列
 *
 * SSR 期间一律返回桌面档:服务端没有视口,猜一个"手机"会让桌面首帧闪一下抽屉。
 * 首帧由 CSS 媒体查询兜住布局,客户端挂载后再由本 composable 接管行为。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

export type ViewportTier = 'desktop' | 'compact' | 'tablet' | 'mobile'

/** 断点常量(唯一出处见 main.css v5 注释) */
export const BREAKPOINTS = {
  /** 三栏仪表台下限 */
  desktop: 1024,
  /** 抽屉导航阈值 */
  drawer: 900,
  /** 单列阈值 */
  single: 640,
} as const

const width = ref(0)
let listeners = 0
let onResize: (() => void) | null = null

function ensureListener() {
  if (typeof window === 'undefined' || onResize) return
  onResize = () => {
    width.value = window.innerWidth
  }
  window.addEventListener('resize', onResize, { passive: true })
  window.addEventListener('orientationchange', onResize, { passive: true })
  width.value = window.innerWidth
}

function releaseListener() {
  if (typeof window === 'undefined' || !onResize) return
  window.removeEventListener('resize', onResize)
  window.removeEventListener('orientationchange', onResize)
  onResize = null
}

export function useResponsive() {
  // 客户端 setup 期就取一次真实视口:不能只等 onMounted ——
  // 依赖方(侧栏/顶栏)的判断会在首帧就求值,晚一拍就会渲染出桌面结构再翻转。
  if (typeof window !== 'undefined' && !width.value) {
    width.value = window.innerWidth
  }

  onMounted(() => {
    listeners += 1
    ensureListener()
  })
  onBeforeUnmount(() => {
    listeners = Math.max(0, listeners - 1)
    if (listeners === 0) releaseListener()
  })

  /** 未挂载(=SSR/首帧)时按桌面档渲染,避免首屏结构抖动 */
  const w = computed(() => (width.value || 1440))

  const isMobile = computed(() => w.value < BREAKPOINTS.single)
  const isDrawer = computed(() => w.value < BREAKPOINTS.drawer)
  const isTablet = computed(() => w.value >= BREAKPOINTS.drawer && w.value < BREAKPOINTS.desktop)
  const isDesktop = computed(() => w.value >= BREAKPOINTS.desktop)

  const tier = computed<ViewportTier>(() => {
    if (isDrawer.value) return isMobile.value ? 'mobile' : 'compact'
    if (isTablet.value) return 'tablet'
    return 'desktop'
  })

  // 把当前档位镜像到 <html data-vp-tier>:E2E 与视觉走查脚本据此断言,
  // 不必反推"这一屏到底该不该有抽屉"。
  if (import.meta.client) {
    watchEffect(() => {
      document.documentElement.dataset.vpTier = tier.value
    })
  }

  return { width: w, tier, isMobile, isTablet, isDesktop, isDrawer }
}
