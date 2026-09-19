/**
 * serial-bridge 客户端面板 —— 注入 'plugins.page' 插槽。
 * 协议栈可用性、系统串口枚举、连接探针(开串口读一次,不落库)、打开链路与串口节点概览。
 * 与 diag-bridge 同范式:30s 自动刷新健康面,语言切换即重渲染。
 */
export function setup(ctx) {
  const styleId = 'aw-serial-styles'
  if (!document.getElementById(styleId)) {
    document.head.append(ctx.el('style', { id: styleId }, [`
      .aw-serial { display:flex; flex-direction:column; gap:10px; font-size:12px; }
      .aw-serial-badge { display:inline-flex; align-items:center; gap:6px; }
      .aw-serial-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
      .aw-serial-dot-ok { background:#35e0a0; }
      .aw-serial-dot-bad { background:#e05a5a; }
      .aw-serial-toolbar { display:flex; justify-content:flex-end; }
      .aw-serial-btn { padding:4px 12px; border:1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius:7px; background:transparent; color:inherit; cursor:pointer; }
      .aw-serial-table { width:100%; border-collapse:collapse; }
      .aw-serial-table th, .aw-serial-table td { text-align:left; padding:5px 8px; border-bottom:1px solid color-mix(in srgb, currentColor 10%, transparent); }
      .aw-serial-table th { opacity:.65; font-weight:500; }
      .aw-serial-empty { opacity:.6; padding:6px 0; }
      .aw-serial-form { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
      .aw-serial-form .aw-serial-inp { width:110px; padding:3px 8px; border:1px solid color-mix(in srgb, currentColor 24%, transparent); border-radius:7px; background:transparent; color:inherit; font:inherit; }
      .aw-serial-form .aw-serial-inp.grow { flex:1 1 140px; }
      .aw-serial-hint { opacity:.6; }
      .aw-serial-result { white-space:pre-wrap; word-break:break-all; padding:6px 8px; border-radius:7px; }
      .aw-serial-result.ok { background:color-mix(in srgb, #35e0a0 12%, transparent); }
      .aw-serial-result.bad { background:color-mix(in srgb, #e05a5a 12%, transparent); }
      .aw-serial-sec { font-weight:600; opacity:.85; margin-top:2px; }
    `]))
  }

  ctx.ui.registerPanel({
    slot: 'plugins.page',
    name: 'serial-bridge-panel',
    titleKey: 'panel.title',
    order: 30,
    mount(elRoot) {
      const t = k => ctx.t(`panel.${k}`)
      const root = ctx.el('div', { class: 'aw-serial' })
      elRoot.append(root)

      // ---- 状态徽标 + 刷新 ----
      const badge = ctx.el('span', { class: 'aw-serial-badge' })
      const refreshAll = () => {
        void loadHealth()
        void loadPorts()
      }
      const toolbar = ctx.el('div', { class: 'aw-serial-toolbar' }, [
        ctx.el('button', { class: 'aw-serial-btn', onclick: refreshAll }, [t('refresh')]),
      ])
      root.append(ctx.el('div', {}, [badge]), toolbar)

      // ---- 系统串口表 ----
      root.append(ctx.el('div', { class: 'aw-serial-sec' }, [t('ports')]))
      const portsWrap = ctx.el('div')
      root.append(portsWrap)

      // ---- 连接探针 ----
      root.append(ctx.el('div', { class: 'aw-serial-sec' }, [t('probe')]))
      const probeSel = ctx.el('input', { class: 'aw-serial-inp grow', placeholder: 'COM3' })
      const modeSel = ctx.el('select', { class: 'aw-serial-inp' }, [
        ctx.el('option', { value: 'modbus-rtu' }, ['Modbus RTU']),
        ctx.el('option', { value: 'ascii-line' }, ['ASCII']),
      ])
      const baudInp = ctx.el('input', { class: 'aw-serial-inp', type: 'number', value: '9600' })
      const unitInp = ctx.el('input', { class: 'aw-serial-inp', type: 'number', value: '1' })
      const regInp = ctx.el('input', { class: 'aw-serial-inp', type: 'number', placeholder: '40001' })
      const lineInp = ctx.el('input', { class: 'aw-serial-inp grow', placeholder: t('sendLine') })
      const probeBtn = ctx.el('button', { class: 'aw-serial-btn', onclick: () => void runProbe() })
      const result = ctx.el('div', { class: 'aw-serial-hint' }, [t('probe_hint')])
      const form = ctx.el('div', { class: 'aw-serial-form' }, [
        probeSel, modeSel, baudInp, unitInp, regInp, lineInp, probeBtn,
      ])
      root.append(form, result)

      // ---- 打开的链路 + 串口节点 ----
      root.append(ctx.el('div', { class: 'aw-serial-sec' }, [t('links')]))
      const linksWrap = ctx.el('div')
      root.append(linksWrap, ctx.el('div', { class: 'aw-serial-sec' }, [t('nodes')]))
      const nodesWrap = ctx.el('div')
      root.append(nodesWrap)

      let probing = false
      function setBtn(label, disabled) {
        probeBtn.textContent = label
        probeBtn.disabled = disabled
      }

      async function loadHealth() {
        const h = await ctx.fetch('/api/plugins/serial-bridge/health').catch(() => null)
        badge.replaceChildren(
          ctx.el('span', { class: `aw-serial-dot ${h?.available ? 'aw-serial-dot-ok' : 'aw-serial-dot-bad'}` }),
          document.createTextNode(h?.available ? t('available') : t('unavailable')),
        )
        const links = Array.isArray(h?.links) ? h.links : []
        if (!links.length) {
          linksWrap.replaceChildren(ctx.el('div', { class: 'aw-serial-empty' }, [t('nolinks')]))
        }
        else {
          const tbody = ctx.el('tbody')
          for (const l of links) {
            tbody.append(ctx.el('tr', {}, [
              ctx.el('td', {}, [String(l.key ?? '-')]),
              ctx.el('td', {}, [String(l.pending ?? 0)]),
              ctx.el('td', {}, [String(l.errors ?? 0)]),
              ctx.el('td', {}, [l.lastUsedAt ? new Date(l.lastUsedAt).toLocaleTimeString() : '-']),
            ]))
          }
          linksWrap.replaceChildren(ctx.el('table', { class: 'aw-serial-table' }, [
            ctx.el('thead', {}, [ctx.el('tr', {}, [
              ctx.el('th', {}, [t('link')]),
              ctx.el('th', {}, [t('pending')]),
              ctx.el('th', {}, [t('errors')]),
              ctx.el('th', {}, [t('lastUsed')]),
            ])]),
            tbody,
          ]))
        }
        const nodes = Array.isArray(h?.readNodes) ? h.readNodes : []
        nodesWrap.replaceChildren(
          nodes.length
            ? ctx.el('div', {}, [nodes.map(n => `${n.name || n.id} @ ${n.path || '?'}${n.enabled === false ? ' [off]' : ''}`).join(', ')])
            : ctx.el('div', { class: 'aw-serial-empty' }, [t('nonodes')]),
        )
      }

      async function loadPorts() {
        const r = await ctx.fetch('/api/plugins/serial-bridge/ports').catch(() => null)
        const ports = Array.isArray(r?.ports) ? r.ports : []
        if (!ports.length) {
          portsWrap.replaceChildren(ctx.el('div', { class: 'aw-serial-empty' }, [r?.error ?? t('noports')]))
          return
        }
        const tbody = ctx.el('tbody')
        for (const p of ports) {
          const pickPort = () => void (probeSel.value = p.path)
          const row = ctx.el('tr', { style: 'cursor:pointer', title: p.friendlyName ?? '', onclick: pickPort }, [
            ctx.el('td', {}, [String(p.path ?? '-')]),
            ctx.el('td', {}, [String(p.manufacturer ?? '-')]),
            ctx.el('td', {}, [String(p.serialNumber ?? '-')]),
          ])
          tbody.append(row)
        }
        portsWrap.replaceChildren(ctx.el('table', { class: 'aw-serial-table' }, [
          ctx.el('thead', {}, [ctx.el('tr', {}, [
            ctx.el('th', {}, [t('path')]),
            ctx.el('th', {}, [t('manufacturer')]),
            ctx.el('th', {}, [t('serialNumber')]),
          ])]),
          tbody,
        ]))
      }

      async function runProbe() {
        if (probing) return
        const path = String(probeSel.value ?? '').trim()
        if (!path) {
          result.className = 'aw-serial-result bad'
          result.textContent = t('noports')
          return
        }
        probing = true
        setBtn(t('probing'), true)
        try {
          const r = await ctx.fetch('/api/plugins/serial-bridge/probe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              path,
              mode: modeSel.value,
              baudRate: Number(baudInp.value) || 9600,
              unitId: Number(unitInp.value) || 1,
              register: regInp.value === '' ? undefined : Number(regInp.value),
              sendLine: modeSel.value === 'ascii-line' && lineInp.value ? lineInp.value : undefined,
            }),
          })
          const body = r ?? {}
          const ok = body.ok === true
          result.className = `aw-serial-result ${ok ? 'ok' : 'bad'}`
          result.textContent = `${ok ? '✓' : '✗'} ${body.message ?? body.error ?? '-'}${body.latencyMs != null ? ` (${body.latencyMs}ms)` : ''}`
          void loadHealth()
        }
        catch (err) {
          result.className = 'aw-serial-result bad'
          result.textContent = `✗ ${err?.message ?? err}`
        }
        finally {
          probing = false
          setBtn(t('run_probe'), false)
        }
      }

      setBtn(t('run_probe'), false)
      void loadHealth()
      void loadPorts()
      const timer = setInterval(() => void loadHealth(), 30_000)
      const offLocale = ctx.hooks.on('i18n:changed', () => {
        setBtn(t('run_probe'), false)
        result.className = 'aw-serial-hint'
        result.textContent = t('probe_hint')
        void loadHealth()
        void loadPorts()
      })
      return () => {
        clearInterval(timer)
        offLocale()
      }
    },
  })
}
