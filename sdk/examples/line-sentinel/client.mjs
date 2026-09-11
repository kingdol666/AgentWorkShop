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

  // ctx.on(type) 的 type 是 **scene 事件名本身**(浏览器可见的那一类),内部装到 `event:<type>`。
  // 真实 scene 事件清单见 daq-controller.ts 的 broadcast 调用点:
  //   daq.reading / daq.frame / daq.alarm / daq.alarm.changed / daq.node.changed /
  //   daq.controller / device.updated / error
  // ⚠️ 服务端生命周期钩子(daq:sample / line:start / line:stop)不会过桥到浏览器,
  //    在客户端订阅它们只会得到永不触发的静默空订阅。
  ctx.on('daq.reading', () => {
    n++
    badge.textContent = `🛡 line-sentinel · ${n} 样本 · ${alarms} 告警`
  })

  ctx.on('daq.alarm', () => {
    alarms++
    badge.style.borderColor = '#ff6b6b'
    badge.textContent = `🛡 line-sentinel · ${n} 样本 · ${alarms} 告警`
  })
  ctx.on('daq.alarm.changed', () => {
    badge.style.borderColor = 'rgba(53,224,160,.5)'
  })

  ctx.log.info('哨兵徽标已挂载(右下角)')
}
