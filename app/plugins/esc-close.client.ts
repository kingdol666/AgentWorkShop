/**
 * Esc 关闭最上层浮层(客户端插件)。
 *
 * 为什么用"派发遮罩点击"而不是逐个模态接线:
 *  全站 15 处浮层(.modal-mask)统一遵守同一约定 —— `@click.self="xxxOpen = false"`。
 *  即"点遮罩空白处 = 关闭"已经是既定契约,而 Esc 只是它的键盘等价物。
 *  因此这里找出**最上层**的 .modal-mask 并派发一次落在遮罩自身的点击:
 *  走的还是那条已经被验证过的关闭路径(状态置 false + Transition 退场),
 *  不需要在 15 个地方各加一遍 keydown,也不会出现"某处漏接线"。
 *
 * 取最上层(last):嵌套浮层时 Esc 只关最内层,符合桌面端直觉。
 * 无浮层时不做任何事 —— 不 preventDefault,避免吞掉页面其它 Esc 语义(如取消行内编辑)。
 */
export default defineNuxtPlugin(() => {
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    const masks = document.querySelectorAll<HTMLElement>('.modal-mask')
    const top = masks[masks.length - 1]
    if (!top) return
    e.preventDefault()
    // 合成点击落在遮罩自身 → 命中 @click.self(冒泡到遮罩但 target 就是遮罩)
    top.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }

  window.addEventListener('keydown', onKeydown)

  // HMR:重载插件模块时摘掉旧监听器,避免叠加
  if (import.meta.hot) {
    import.meta.hot.dispose(() => window.removeEventListener('keydown', onKeydown))
  }
})
