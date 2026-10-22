// ops-notifier — 客户端通知(最近一次写控 toast)
export function setup(ctx) {
  const toast = ctx.el('div', {
    style: 'display:none;padding:8px 12px;border:1px solid color-mix(in srgb, var(--tone-warning-dot,#f6c453) 55%, transparent);'
      + 'border-radius:8px;background:var(--mat-float-bg,rgba(13,21,33,.96));color:var(--ink-soft,#b6c3d5);'
      + 'font:500 11.5px/1.5 var(--font-mono,ui-monospace,monospace);box-shadow:var(--shadow-lift-1,0 1px 2px rgba(0,0,0,.35))',
  })
  ctx.root().prepend(toast)

  let timer = null
  // scene 事件名是 'dcw.written'(写控 ACK 后对浏览器广播);服务端钩子 'dcw:write'
  // 不过桥到浏览器,在这里订阅它只会得到永不触发的空订阅。
  ctx.on('dcw.written', (w) => {
    // 事件载荷在不同写控链路下字段名不完全一致(name/point/tag);缺字段时给出
    // 可读的兜底,不让 "undefined" 直接出现在 HUD 上。
    const target = w.name ?? w.point ?? w.tag ?? w.nodeName ?? '节点'
    const value = w.eng ?? w.value ?? '—'
    toast.textContent = w.ok
      ? `写入 ${target} → ${value}${w.source ? `(${w.source})` : ''}`
      : `写入失败 ${target}${w.error ? `: ${w.error}` : ''}`
    toast.style.display = 'block'
    clearTimeout(timer)
    timer = setTimeout(() => {
      toast.style.display = 'none'
    }, 4000)
  })

  ctx.log.info('写控通知已就绪')
}
