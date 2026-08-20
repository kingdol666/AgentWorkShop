/**
 * 代码块复制(事件委托单例):mdLite 渲染的 `.code-copy` 按钮点击 →
 * 复制同块 <pre><code> 文本 → 按钮瞬时"已复制"反馈。
 * document 级监听,时间线/lanes/抽屉内任意代码块通用,重复调用幂等。
 */
let installed = false

export function useCodeCopy(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest?.('.code-copy')
    if (!(btn instanceof HTMLElement)) return
    const block = btn.closest('.code-block')
    const code = block?.querySelector('pre code')?.textContent ?? ''
    const done = (): void => {
      const prev = btn.textContent
      btn.textContent = '已复制'
      setTimeout(() => {
        btn.textContent = prev ?? '复制'
      }, 1400)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done, done)
    }
    else {
      done()
    }
  })
}
