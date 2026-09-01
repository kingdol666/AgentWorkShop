/**
 * useVisibleInterval —— 主线程友好的可见性感知轮询。
 *
 * 资源分配契约:前台按 ms 节拍;标签页隐藏时降为 bgMs(null = 暂停,默认 3×);
 * 回前台立即补一拍(数据秒级收敛,无需等下一个周期)。WS 长连不受影响
 * (帧推送是常量成本,合批在 store 层完成),这里只调度「拉」的一半。
 */
export function useVisibleInterval(
  fn: () => void,
  ms: number,
  opts: { bgMs?: number | null } = {},
): void {
  const bgMs = opts.bgMs === undefined ? ms * 3 : opts.bgMs
  let timer: ReturnType<typeof setInterval> | null = null

  function start(interval: number): void {
    stop()
    if (interval > 0) timer = setInterval(fn, interval)
  }
  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
  function onVis(): void {
    if (document.hidden) {
      start(bgMs)
    }
    else {
      start(ms)
      fn()
    }
  }

  start(document.hidden ? bgMs : ms)
  document.addEventListener('visibilitychange', onVis)
  onScopeDispose(() => {
    stop()
    document.removeEventListener('visibilitychange', onVis)
  })
}
