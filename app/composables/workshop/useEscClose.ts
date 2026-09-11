/**
 * Esc 关闭浮层(模态/抽屉/命令面板)—— 可复用的键盘可达性基线。
 *
 * 为什么需要:页内模态此前只能靠点遮罩或"取消"按钮关闭,Esc 无响应。
 * Esc 关闭是桌面端浮层的**基本约定**(用户会本能地按),缺了它每次都要移动鼠标找按钮。
 *
 * 行为约定:
 *  - 仅在 isOpen 为真时挂监听(不留常驻全局监听器);
 *  - `capture: true`:浮层内的输入框/富文本可能吞掉 keydown,捕获阶段拦更可靠;
 *  - 关闭时 stopPropagation:嵌套浮层只关最内层,不连锁关掉父层。
 *
 * 用法:
 *   const open = ref(false)
 *   useEscClose(open, () => { open.value = false })
 */
import { onScopeDispose, watch } from 'vue'
import type { Ref } from 'vue'

export function useEscClose(isOpen: Ref<boolean>, close: () => void): void {
  let handler: ((e: KeyboardEvent) => void) | null = null

  const detach = (): void => {
    if (!handler) return
    window.removeEventListener('keydown', handler, true)
    handler = null
  }

  const attach = (): void => {
    if (handler) return
    handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', handler, true)
  }

  watch(isOpen, (open) => {
    if (open) attach()
    else detach()
  }, { immediate: true })

  onScopeDispose(detach)
}
