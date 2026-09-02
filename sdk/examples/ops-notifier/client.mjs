// ops-notifier — 客户端通知(最近一次写控 toast)
export function setup(ctx) {
  const toast = ctx.el('div', {
    style: 'display:none;padding:10px 14px;border:1px solid rgba(244,197,66,.6);'
      + 'border-radius:10px;background:rgba(20,16,4,.88);color:#f4c542;'
      + 'font:600 12px/1.5 ui-monospace,monospace;box-shadow:0 4px 18px rgba(0,0,0,.35)',
  })
  ctx.root().prepend(toast)

  let timer = null
  ctx.on('dcw:write', (w) => {
    toast.textContent = w.ok
      ? `✔ 写入 ${w.name} → ${w.eng}${w.source ? `(${w.source})` : ''}`
      : `✖ 写入失败 ${w.name}`
    toast.style.display = 'block'
    clearTimeout(timer)
    timer = setTimeout(() => {
      toast.style.display = 'none'
    }, 4000)
  })

  ctx.log.info('写控通知已就绪')
}
