// sample-insight — 客户端增强(自包含 ESM,无裸导入)
// 右下角徽标实时显示采样计数(事件与 WS 同源)
export function setup(ctx) {
  const badge = ctx.el('div', {
    style: 'padding:8px 12px;border:1px solid #35e0a0;border-radius:10px;color:#35e0a0;'
      + 'background:rgba(8,20,16,.82);font:600 12px/1 ui-monospace,monospace;'
      + 'box-shadow:0 4px 16px rgba(0,0,0,.35);letter-spacing:.4px',
  }, ['⌁ sample-insight · 0'])

  ctx.root().append(badge)

  let n = 0
  ctx.on('daq:sample', () => {
    n++
    badge.textContent = `⌁ sample-insight · ${n} 样本`
  })

  ctx.on('page:change', ({ path }) => {
    ctx.log.info('page →', path)
  })

  ctx.log.info('client ready — 右下角徽标已挂载')
}
