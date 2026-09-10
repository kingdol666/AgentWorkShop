/**
 * rag-bridge 客户端面板 —— 经 ctx.ui.registerPanel 注入 'plugins.page' 插槽。
 * 自包含 ESM(零导入);ctx 由宿主 loader 注入(fetch 带鉴权/t 命名空间翻译)。
 * 健康徽标(后端/Web/知识库) + 快捷检索框,30s 自动刷新,返回清理函数供卸载回收。
 */
export function setup(ctx) {
  // 面板样式(自包含注入,幂等;不依赖宿主页面样式表)
  const styleId = 'aw-rb-styles'
  if (!document.getElementById(styleId)) {
    document.head.append(ctx.el('style', { id: styleId }, [`
      .aw-rb { display:flex; flex-direction:column; gap:8px; font-size:12px; }
      .aw-rb-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .aw-rb-cell { display:inline-flex; align-items:center; gap:4px; }
      .aw-rb-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
      .aw-rb-dot-ok { background:#35e0a0; }
      .aw-rb-dot-bad { background:#e05a5a; }
      .aw-rb-input { flex:1; min-width:200px; padding:5px 9px; border:1px solid color-mix(in srgb, currentColor 24%, transparent); border-radius:7px; background:transparent; color:inherit; }
      .aw-rb-btn { padding:5px 13px; border:1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius:7px; background:transparent; color:inherit; cursor:pointer; }
      .aw-rb-btn:disabled { opacity:.5; cursor:default; }
      .aw-rb-results { display:flex; flex-direction:column; gap:6px; }
      .aw-rb-empty { opacity:.6; }
      .aw-rb-hit { padding:6px 8px; border:1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius:7px; }
      .aw-rb-hit-head { font-size:11px; opacity:.85; }
      .aw-rb-hit-brief { opacity:.7; margin-top:2px; }
    `]))
  }

  ctx.ui.registerPanel({
    slot: 'plugins.page',
    name: 'kb-panel',
    titleKey: 'panel.title',
    order: 10,
    mount(el) {
      const t = k => ctx.t(`panel.${k}`)
      const timer = setInterval(refresh, 30_000)

      function dot(ok) {
        return ctx.el('span', {
          class: `aw-rb-dot ${ok ? 'aw-rb-dot-ok' : 'aw-rb-dot-bad'}`,
          title: ok ? t('ok') : t('bad'),
        })
      }

      const backendCell = ctx.el('span', { class: 'aw-rb-cell' }, [dot(false), ` ${t('backend')}`])
      const webCell = ctx.el('span', { class: 'aw-rb-cell' }, [dot(false), ` ${t('web')}`])
      const kbCell = ctx.el('span', { class: 'aw-rb-cell aw-mono' }, [dot(false), ` ${t('kb')}: -`])
      const counterCell = ctx.el('span', { class: 'aw-rb-cell faint' }, [
        `${t('counters')}: ${t('store')} 0 · ${t('index')} 0`,
      ])
      const statusRow = ctx.el('div', { class: 'aw-rb-row' }, [backendCell, webCell, kbCell, counterCell])

      const input = ctx.el('input', {
        class: 'aw-rb-input',
        placeholder: t('searchPlaceholder'),
      })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void runSearch()
      })
      const btn = ctx.el('button', { class: 'aw-rb-btn' }, [t('searchBtn')])
      btn.addEventListener('click', () => void runSearch())
      const results = ctx.el('div', { class: 'aw-rb-results' })

      el.append(
        ctx.el('div', { class: 'aw-rb' }, [
          statusRow,
          ctx.el('div', { class: 'aw-rb-row' }, [input, btn]),
          results,
        ]),
      )

      async function refresh() {
        const h = await ctx.fetch('/api/plugins/rag-bridge/health').catch(() => null)
        backendCell.replaceChildren(dot(Boolean(h?.backend?.ok)), ` ${t('backend')}`)
        webCell.replaceChildren(dot(Boolean(h?.web?.ok)), ` ${t('web')}`)
        kbCell.replaceChildren(dot(Boolean(h?.kb?.id)), ` ${t('kb')}: ${h?.kb?.id ? String(h.kb.id).slice(0, 8) : '-'}(${h?.auth === 'bearer' ? t('bearer') : t('anonymous')})`)
        counterCell.replaceChildren(`${t('counters')}: ${t('store')} ${h?.counters?.store ?? 0} · ${t('index')} ${h?.counters?.index ?? 0}`)
      }

      async function runSearch() {
        const q = String(input.value ?? '').trim()
        if (!q) return
        btn.disabled = true
        btn.textContent = t('searching')
        results.replaceChildren()
        const r = await ctx.fetch(`/api/plugins/rag-bridge/search?q=${encodeURIComponent(q)}&top_k=5`).catch(() => null)
        btn.disabled = false
        btn.textContent = t('searchBtn')
        const items = Array.isArray(r?.results) ? r.results.slice(0, 5) : []
        if (!items.length) {
          results.append(ctx.el('div', { class: 'aw-rb-empty' }, [t('empty')]))
          return
        }
        for (const [i, h] of items.entries()) {
          const brief = String(h?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
          results.append(ctx.el('div', { class: 'aw-rb-hit' }, [
            ctx.el('div', { class: 'aw-rb-hit-head aw-mono' }, [
              `${i + 1}. [${Number(h?.score ?? 0).toFixed(3)}] ${h?.doc_path ?? '-'}`,
            ]),
            ctx.el('div', { class: 'aw-rb-hit-brief' }, [brief]),
          ]))
        }
      }

      void refresh()
      return () => clearInterval(timer)
    },
  })
}
