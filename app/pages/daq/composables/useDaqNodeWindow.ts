import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from 'vue'
import type { DaqNodeLive } from '@/app/composables/workshop/useDaqStream'

/* ── 节点表窗口化渲染(virtual window) ────────────────────────────────────────
 * 为什么必须做:节点表是**全量**渲染的,而每一行都带实时读数 + sparkline,
 * 每次读数合批(500ms)都会点亮所有行。实测 498 个节点时:
 *   · DOM 节点 13.5 万
 *   · 主线程每秒 ≈3.8 万次 DOM 变更(其中 99.6% 来自这张表)
 *   · 帧率掉到 24 FPS、92% 的帧超时、单帧最大间隔 361ms、长任务阻塞 936ms
 * 也就是说"数据刷新太频繁导致卡顿"的根因不是刷新频率,而是**离屏行也在被补丁**。
 *
 * 做法:按页面滚动窗口只挂载可见行 + 上下各 OVERSCAN 行,用两条占位 <tr> 撑起
 * 滚动高度。行的实际高度由 contain-intrinsic-size 固定为 42px(见样式),所以
 * 窗口计算不需要测量 DOM。
 *
 * 为什么用**页面滚动**而不是容器滚动:这张表的滚动条是页面的(.table-card 只负责
 * 横向),所以窗口要跟着 window.scrollY 走。
 */
const VS_ROW_H = 42
const VS_OVERSCAN = 8

export interface DaqNodeWindow {
  /** 绑定到 <table> 的模板引用(父页下发) */
  nodesTableRef: Ref<HTMLTableElement | null>
  visibleNodes: ComputedRef<DaqNodeLive[]>
  padTopPx: ComputedRef<number>
  padBottomPx: ComputedRef<number>
  /** 筛选/搜索改变行数后调用:回到顶部并立即重算窗口 */
  resetToTop: () => void
}

export function useDaqNodeWindow(filteredNodes: ComputedRef<DaqNodeLive[]>): DaqNodeWindow {
  const nodesTableRef = ref<HTMLTableElement | null>(null)
  const winStart = ref(0)
  const winEnd = ref(60)

  const visibleNodes = computed<DaqNodeLive[]>(() => {
    const list = filteredNodes.value
    const s = Math.min(winStart.value, Math.max(0, list.length - 1))
    return list.slice(s, winEnd.value)
  })
  const padTopPx = computed(() => winStart.value * VS_ROW_H)
  const padBottomPx = computed(() => Math.max(0, (filteredNodes.value.length - winEnd.value) * VS_ROW_H))

  let winRaf = 0
  function updateNodeWindow(): void {
    const el = nodesTableRef.value
    if (!el) return
    const total = filteredNodes.value.length
    const vh = window.innerHeight || 800
    // 表格顶部相对文档的坐标(表头 40px 也算进"还没到第一行")
    const tableTop = el.getBoundingClientRect().top + window.scrollY + 40
    const firstVisible = Math.floor((window.scrollY - tableTop) / VS_ROW_H)
    const count = Math.ceil(vh / VS_ROW_H) + VS_OVERSCAN * 2
    const s = Math.max(0, Math.min(firstVisible - VS_OVERSCAN, Math.max(0, total - 1)))
    const e = Math.max(s, Math.min(total, s + count))
    if (s !== winStart.value) winStart.value = s
    if (e !== winEnd.value) winEnd.value = e
  }
  function scheduleNodeWindow(): void {
    if (winRaf) return
    winRaf = requestAnimationFrame(() => {
      winRaf = 0
      updateNodeWindow()
    })
  }

  function resetToTop(): void {
    winStart.value = 0
    winEnd.value = Math.min(filteredNodes.value.length, winEnd.value || 60)
    scheduleNodeWindow()
  }

  onMounted(() => {
    updateNodeWindow()
    window.addEventListener('scroll', scheduleNodeWindow, { passive: true })
    window.addEventListener('resize', scheduleNodeWindow, { passive: true })
  })
  onBeforeUnmount(() => {
    window.removeEventListener('scroll', scheduleNodeWindow)
    window.removeEventListener('resize', scheduleNodeWindow)
    if (winRaf) cancelAnimationFrame(winRaf)
  })

  return { nodesTableRef, visibleNodes, padTopPx, padBottomPx, resetToTop }
}
