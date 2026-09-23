/**
 * 通用剪贴板:API 优先,execCommand 兜底。
 *
 * 一次性明文的复制(useTokenCreate.copyCreated)与列表行明文的复制(useTokenReveal.copyRow)
 * 共用同一份实现 —— 剪贴板回退语义只有一处,避免两处漂移。
 */
export function useTokenClipboard() {
  const copyText = async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text)
      return true
    }
    catch {
      // 剪贴板 API 不可用(非安全上下文/权限拒绝)→ execCommand 兜底
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return ok
      }
      catch {
        return false
      }
    }
  }

  return { copyText }
}
