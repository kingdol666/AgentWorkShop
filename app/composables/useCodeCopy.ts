/**
 * 代码块复制(事件委托单例):mdLite 渲染的 `.code-copy` 按钮点击 →
 * 复制同块 <pre><code> 文本 → 按钮瞬时"已复制"反馈。
 * document 级监听,时间线/lanes/抽屉内任意代码块通用,重复调用幂等。
 * 注意:本函数可能在组件 setup 之外被调用,不能使用 useI18n() ——
 * 经全局 i18n 实例在点击时懒取文案(同时保证切换语言后取到新值)。
 */
let installed = false

type GlobalI18n = { global: { t: (key: string) => string } }

function i18nT(key: string): string {
  try {
    const g = useNuxtApp().$i18n as unknown as GlobalI18n | undefined
    return g?.global.t(key) ?? key
  }
  catch {
    return key
  }
}

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
      btn.textContent = i18nT('common.copied')
      setTimeout(() => {
        btn.textContent = prev ?? i18nT('common.copy')
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
