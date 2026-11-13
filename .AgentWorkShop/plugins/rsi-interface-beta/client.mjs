/* RSI Beta read-only diagnostics panel. No promote, approve, actuate, or write controls. */
export function setup(ctx) {
  const styleId = 'aw-rsi-beta-styles'
  if (!document.getElementById(styleId)) {
    document.head.append(ctx.el('style', { id: styleId }, [`
      .aw-rsi-beta { display:flex; flex-direction:column; gap:12px; font-size:12px; }
      .aw-rsi-beta-head, .aw-rsi-beta-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .aw-rsi-beta-head { justify-content:space-between; }
      .aw-rsi-beta-status { display:inline-flex; align-items:center; gap:6px; font-weight:600; }
      .aw-rsi-beta-dot { width:8px; height:8px; border-radius:50%; display:inline-block; background:#9aa4ad; }
      .aw-rsi-beta-dot.ok { background:#35a878; }
      .aw-rsi-beta-dot.warn { background:#c9963f; }
      .aw-rsi-beta-dot.bad { background:#c2554a; }
      .aw-rsi-beta-btn { padding:4px 10px; border:1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius:7px; background:transparent; color:inherit; cursor:pointer; }
      .aw-rsi-beta-btn:disabled { opacity:.5; cursor:default; }
      .aw-rsi-beta-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:8px; }
      .aw-rsi-beta-card { min-width:0; padding:9px 10px; border:1px solid color-mix(in srgb, currentColor 13%, transparent); border-radius:8px; }
      .aw-rsi-beta-k { margin-bottom:4px; color:color-mix(in srgb, currentColor 62%, transparent); font-size:11px; }
      .aw-rsi-beta-v { overflow-wrap:anywhere; }
      .aw-rsi-beta-list { display:flex; flex-direction:column; gap:4px; margin:0; padding:0; list-style:none; }
      .aw-rsi-beta-list li { display:flex; gap:8px; align-items:baseline; }
      .aw-rsi-beta-list li::before { content:'•'; opacity:.55; }
      .aw-rsi-beta-mono { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .aw-rsi-beta-muted { color:color-mix(in srgb, currentColor 62%, transparent); }
      .aw-rsi-beta-error { color:#c2554a; }
      .aw-rsi-beta-denied { padding:8px 10px; border:1px dashed color-mix(in srgb, #c9963f 55%, transparent); border-radius:8px; }
      .aw-rsi-beta-provenance { display:flex; flex-direction:column; gap:5px; }
      .aw-rsi-beta-provenance-row { display:grid; grid-template-columns:90px minmax(0, 1fr); gap:8px; }
      @media (max-width:600px) { .aw-rsi-beta-provenance-row { grid-template-columns:1fr; gap:2px; } }
    `]))
  }

  ctx.ui.registerPanel({
    slot: 'plugins.page',
    name: 'beta-status',
    titleKey: 'panel.title',
    order: 5,
    mount(el) {
      const t = key => ctx.t(`panel.${key}`)
      let disposed = false
      let loading = false
      let metadata = null

      const root = ctx.el('div', { class: 'aw-rsi-beta' })
      const head = ctx.el('div', { class: 'aw-rsi-beta-head' })
      const status = ctx.el('div', { class: 'aw-rsi-beta-status' })
      const refreshBtn = ctx.el('button', { class: 'aw-rsi-beta-btn', type: 'button' }, [t('refresh')])
      head.append(status, refreshBtn)
      const message = ctx.el('div', { class: 'aw-rsi-beta-muted' })
      const overview = ctx.el('div', { class: 'aw-rsi-beta-grid' })
      const provenance = ctx.el('div', { class: 'aw-rsi-beta-provenance' })
      const limitations = ctx.el('ul', { class: 'aw-rsi-beta-list' })
      root.append(head, message, overview, provenance, limitations)
      el.append(root)

      function text(value, fallback = '—') {
        return value === undefined || value === null || value === '' ? fallback : String(value)
      }

      function card(label, value, mono = false) {
        return ctx.el('div', { class: 'aw-rsi-beta-card' }, [
          ctx.el('div', { class: 'aw-rsi-beta-k' }, [label]),
          ctx.el('div', { class: `aw-rsi-beta-v${mono ? ' aw-rsi-beta-mono' : ''}` }, [text(value)]),
        ])
      }

      function flagLine(name, value) {
        return ctx.el('span', { class: 'aw-rsi-beta-mono' }, [`${name}=${value ? '1' : '0'}`])
      }

      function render() {
        const m = metadata
        if (!m) {
          status.replaceChildren(ctx.el('span', { class: 'aw-rsi-beta-dot' }), t('loading'))
          message.textContent = ''
          overview.replaceChildren()
          provenance.replaceChildren()
          limitations.replaceChildren()
          return
        }
        const stateClass = m.status === 'ready' ? 'ok' : m.status === 'degraded' ? 'warn' : 'bad'
        status.replaceChildren(
          ctx.el('span', { class: `aw-rsi-beta-dot ${stateClass}` }),
          `${t('status')}: ${t(`state.${m.status}`)}`,
        )
        message.className = m.visible ? 'aw-rsi-beta-muted' : 'aw-rsi-beta-denied'
        message.textContent = m.visible
          ? `${t('code')}: ${text(m.code)}`
          : `${t('denied')}: ${text(m.code)} · ${t('scopeRequired')}: ${(m.requiredScope ?? []).join(', ')}`

        const flags = m.flags ?? {}
        const scope = m.visible && m.scope ? Object.entries(m.scope).map(([key, value]) => `${key}=${text(value)}`).join(' · ') : t('notBound')
        overview.replaceChildren(
          card(t('flags'), (m.requiredFlags ?? []).map(name => flagLine(name, flags[name] === true))),
          card(t('scope'), scope, true),
          card(t('adapter'), `${text(m.adapter?.health)} · ${text(m.adapter?.code)}`),
          card(t('boundary'), m.readOnly === true && m.actuation === false && m.promotion === false ? t('readOnly') : t('reviewRequired')),
          card(t('capabilities'), (m.capabilities ?? []).join(', '), true),
        )

        provenance.replaceChildren(ctx.el('div', { class: 'aw-rsi-beta-k' }, [t('provenance')]))
        for (const [key, value] of Object.entries(m.provenance ?? {})) {
          provenance.append(ctx.el('div', { class: 'aw-rsi-beta-provenance-row' }, [
            ctx.el('span', { class: 'aw-rsi-beta-muted' }, [t(`provenanceKind.${key}`)]),
            ctx.el('span', { class: 'aw-rsi-beta-mono' }, [`${text(value.contract)} · ${text(value.source)}`]),
          ]))
        }

        limitations.replaceChildren()
        for (const item of (m.limitations ?? [])) limitations.append(ctx.el('li', {}, [item]))
      }

      async function refresh() {
        if (loading || disposed) return
        loading = true
        refreshBtn.disabled = true
        refreshBtn.textContent = t('loading')
        try {
          metadata = await ctx.fetch('/api/plugins/rsi-interface-beta/metadata')
          render()
        }
        catch (error) {
          metadata = null
          status.replaceChildren(ctx.el('span', { class: 'aw-rsi-beta-dot bad' }), t('error'))
          message.className = 'aw-rsi-beta-error'
          message.textContent = text(error?.message, t('loadFailed'))
          overview.replaceChildren()
          provenance.replaceChildren()
          limitations.replaceChildren()
        }
        finally {
          loading = false
          refreshBtn.disabled = false
          refreshBtn.textContent = t('refresh')
        }
      }

      refreshBtn.addEventListener('click', () => void refresh())
      const offLocale = ctx.hooks.on('i18n:changed', () => {
        refreshBtn.textContent = loading ? t('loading') : t('refresh')
        render()
      })
      void refresh()
      return () => {
        disposed = true
        offLocale()
        root.remove()
      }
    },
  })
}
