// line-sentinel — 客户端徽标(实时显示采样计数与告警态)
export function setup(ctx) {
  const badge = ctx.el('div', {
    id: 'line-sentinel-badge',
    style: 'display:flex;align-items:center;gap:8px;padding:8px 12px;'
      + 'border:1px solid rgba(53,224,160,.5);border-radius:10px;'
      + 'background:rgba(6,18,14,.85);color:#35e0a0;'
      + 'font:600 12px/1 ui-monospace,monospace;letter-spacing:.4px;'
      + 'box-shadow:0 4px 18px rgba(0,0,0,.35);cursor:default',
  }, ['🛡 line-sentinel · 待机'])

  ctx.root().append(badge)

  let n = 0
  let alarms = 0

  ctx.on('daq:sample', () => {
    n++
    badge.textContent = `🛡 line-sentinel · ${n} 样本 · ${alarms} 告警`
  })

  // 服务端告警状态变化经 event 桥可见(ops.log 或轮询 stats;此处演示事件订阅)
  ctx.on('event:line.start', () => {
    badge.style.borderColor = '#35e0a0'
  })
  ctx.on('event:line.stop', () => {
    badge.style.borderColor = 'rgba(53,224,160,.35)'
  })

  ctx.log.info('哨兵徽标已挂载(右下角)')
}
