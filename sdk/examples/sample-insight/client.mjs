// sample-insight — 客户端增强(自包含 ESM,无裸导入)
// 右下角徽标实时显示采样计数(事件与 WS 同源)
export function setup(ctx) {
  const badge = ctx.el('div', {
    style: 'padding:6px 10px;border:1px solid var(--line,#1d2a3d);border-radius:8px;color:var(--ink-soft,#b6c3d5);'
      + 'background:var(--mat-float-bg,rgba(13,21,33,.96));font:500 11px/1 var(--font-mono,ui-monospace,monospace);'
      + 'box-shadow:var(--shadow-lift-1,0 1px 2px rgba(0,0,0,.35));letter-spacing:.04em',
  }, ['sample-insight · 0'])

  ctx.root().append(badge)

  let n = 0
  // scene 事件名直传('daq.reading' 是 DAQ 采样对浏览器广播的真实事件名)
  ctx.on('daq.reading', () => {
    n++
    badge.textContent = `sample-insight · ${n} 样本`
  })

  // 生命周期钩子(含 page:change)不走 ctx.on —— 它只装 scene 事件。走 ctx.hooks 直订。
  ctx.hooks.on('page:change', ({ path }) => {
    ctx.log.info('page →', path)
  })

  ctx.log.info('client ready — 右下角徽标已挂载')
}
