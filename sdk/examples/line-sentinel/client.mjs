// line-sentinel — 客户端徽标(实时显示采样计数与告警态)
//
// 视觉契约与平台工业台一致:实心浮层底 + 1px 状态边 + 等宽读数,不用 emoji。
// 徽标由 SDK 插件坞定位(右下角、页脚之上),这里只负责自身形态。
export function setup(ctx) {
  const dot = ctx.el('span', {
    style: 'flex:none;width:6px;height:6px;border-radius:50%;'
      + 'background:var(--tone-success-dot,#45e2a8)',
  })
  const label = ctx.el('span', {}, ['line-sentinel · 待机'])
  const badge = ctx.el('div', {
    id: 'line-sentinel-badge',
    style: 'display:flex;align-items:center;gap:8px;padding:6px 10px;'
      + 'border:1px solid color-mix(in srgb, var(--tone-success-dot,#45e2a8) 42%, transparent);border-radius:8px;'
      + 'background:var(--mat-float-bg,rgba(13,21,33,.96));color:var(--ink-soft,#b6c3d5);'
      + 'font:500 11px/1 var(--font-mono,ui-monospace,monospace);letter-spacing:.04em;'
      + 'box-shadow:var(--shadow-lift-1,0 1px 2px rgba(0,0,0,.35));cursor:default;white-space:nowrap',
  }, [dot, label])

  ctx.root().append(badge)

  let n = 0
  let alarms = 0
  const render = () => {
    // 常驻 HUD 只显示"计数";告警数非零才追加,避免长期占满一行遮挡内容
    label.textContent = alarms > 0
      ? `line-sentinel ${n} · ${alarms} 告警`
      : `line-sentinel ${n}`
    badge.title = `line-sentinel · ${n} 样本 · ${alarms} 告警`
  }

  // ctx.on(type) 的 type 是 **scene 事件名本身**(浏览器可见的那一类),内部装到 `event:<type>`。
  // 真实 scene 事件清单见 daq-controller.ts 的 broadcast 调用点:
  //   daq.reading / daq.frame / daq.alarm / daq.alarm.changed / daq.node.changed /
  //   daq.controller / device.updated / error
  // ⚠️ 服务端生命周期钩子(daq:sample / line:start / line:stop)不会过桥到浏览器,
  //    在客户端订阅它们只会得到永不触发的静默空订阅。
  ctx.on('daq.reading', () => {
    n++
    render()
  })

  ctx.on('daq.alarm', () => {
    alarms++
    dot.style.background = 'var(--tone-danger-dot,#ff8080)'
    badge.style.borderColor = 'color-mix(in srgb, var(--tone-danger-dot,#ff8080) 52%, transparent)'
    render()
  })
  ctx.on('daq.alarm.changed', () => {
    dot.style.background = 'var(--tone-success-dot,#45e2a8)'
    badge.style.borderColor = 'color-mix(in srgb, var(--tone-success-dot,#45e2a8) 42%, transparent)'
  })

  ctx.log.info('哨兵徽标已挂载(右下角)')
}
