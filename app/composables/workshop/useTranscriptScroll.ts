/**
 * 时间线滚动容器编排:吸底跟随 + 回底动画 + 内容高度增长补滚。
 *
 * 三条补滚路径(缺一条都会让长输出"卡"在中途):
 *  ① 块数变化(新块上屏)
 *  ② 频道 lastSeq 增长(合并帧不推块数时)
 *  ③ 同一流块 delta 打字机让块变高(块数与 seq 都不变 → ResizeObserver 兜底)
 *
 * `stickBottom` 由滚动位置决定(离底 120px 内算贴底):用户离底后新内容不再强制跟随,
 * 由「跳回最新」按钮显式回底。ResizeObserver 以结构化类型声明:绕开 vue-tsc 双 lib.dom
 * 下 Element 类型不兼容问题。
 *
 * 从 TranscriptTimeline 拆出时逻辑逐行未动;`scroller` / `columnEl` 仍是模板 ref
 * (容器模板用 ref="scroller" / ref="columnEl" 绑定),副作用注册与清理成对留在本文件内。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/** 结构化滚动容器(绕开 vue-tsc 双 lib.dom 的 Element 类型不兼容) */
type ScrollBox = { scrollTop: number, scrollHeight: number, clientHeight: number }

/** 补滚触发源:两个都是 getter(watch 按值变化触发) */
export interface TranscriptScrollSources {
  /** 已呈现块数(变化 → 补一次滚底) */
  blockCount: () => number
  /** 频道最新 seq(增长 → 补一次滚底) */
  lastSeq: () => number
}

export function useTranscriptScroll(sources: TranscriptScrollSources) {
  const scroller = ref<HTMLElement | null>(null)
  const stickBottom = ref(true)
  const scrollingDown = ref(false)
  /** 内容列(高度增长的观测目标;模板 ref) */
  const columnEl = ref<HTMLElement | null>(null)
  let contentObserver: { disconnect(): void } | null = null

  const onScroll = (): void => {
    const el = scroller.value
    if (!el) return
    stickBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  // ===== 回底动画(open-tag jump-bottom:800ms ease-out,动画期抑制按钮闪烁) =====
  const animateScroll = (el: ScrollBox, ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.scrollTop = el.scrollHeight
        resolve()
        return
      }
      const from = el.scrollTop
      const delta = el.scrollHeight - el.clientHeight - from
      const t0 = performance.now()
      const step = (t: number): void => {
        const k = Math.min(1, (t - t0) / ms)
        const eased = 1 - (1 - k) ** 3 // ease-out cubic
        el.scrollTop = from + delta * eased
        if (k < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })

  /** 跳回最新:滚底并恢复吸底(用户离开底部后新内容不再自动跟随) */
  const jumpToLatest = async (): Promise<void> => {
    stickBottom.value = true
    const el = scroller.value
    if (!el) return
    scrollingDown.value = true
    try {
      await animateScroll(el, 800)
    }
    finally {
      scrollingDown.value = false
    }
  }

  /** 吸底:新块出现 / seq 增长 / 块内容尺寸变化(可能高增)后滚到底 */
  const scrollToBottom = async (): Promise<void> => {
    if (!stickBottom.value) return
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  }
  watch(sources.blockCount, () => {
    void scrollToBottom()
  })
  watch(sources.lastSeq, () => {
    void scrollToBottom()
  })

  // 内容高度增长吸底:同一流块 delta 打字机让块变高(块数与 seq 不变或合并帧不推 seq),
  // ResizeObserver 观测内容列高度变化补一次滚底 —— 长输出不再"卡"在中途。
  // (观察器以结构化类型声明:绕开 vue-tsc 双 lib.dom 下 Element 类型不兼容问题)
  onMounted(() => {
    const el = scroller.value
    const column = columnEl.value
    if (!el || !column || typeof ResizeObserver === 'undefined') return
    const Observer = ResizeObserver as unknown as
      new (cb: () => void) => { observe(target: unknown): void, disconnect(): void }
    const observer = new Observer(() => {
      if (stickBottom.value) el.scrollTop = el.scrollHeight
    })
    observer.observe(column)
    contentObserver = observer
  })
  onBeforeUnmount(() => {
    contentObserver?.disconnect()
    contentObserver = null
  })

  return { scroller, columnEl, stickBottom, scrollingDown, onScroll, jumpToLatest }
}
