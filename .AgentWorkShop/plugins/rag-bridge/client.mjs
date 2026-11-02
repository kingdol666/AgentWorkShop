/**
 * rag-bridge 客户端面板 —— 经 ctx.ui.registerPanel 注入 'plugins.page' 插槽。
 * 自包含 ESM(零导入);ctx 由宿主 loader 注入(fetch 带鉴权/t 命名空间翻译)。
 * 健康徽标(后端/Web/知识库,30s 自动刷新) + 「检测连接」显式检测(调 /health,
 * 含用户配置 token 的实测三态,结构化渲染) + 快捷检索框;返回清理函数供卸载回收。
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
      .aw-rb-dot-na { background:#9aa4ad; }
      .aw-rb-btn { padding:5px 13px; border:1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius:7px; background:transparent; color:inherit; cursor:pointer; }
      .aw-rb-btn:disabled { opacity:.5; cursor:default; }
      .aw-rb-input { flex:1; min-width:200px; padding:5px 9px; border:1px solid color-mix(in srgb, currentColor 24%, transparent); border-radius:7px; background:transparent; color:inherit; }
      .aw-rb-results { display:flex; flex-direction:column; gap:6px; }
      .aw-rb-empty { opacity:.6; }
      .aw-rb-hit { padding:6px 8px; border:1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius:7px; }
      .aw-rb-hit-head { font-size:11px; opacity:.85; }
      .aw-rb-hit-brief { opacity:.7; margin-top:2px; }
      .aw-rb-check { padding:8px 10px; border:1px dashed color-mix(in srgb, currentColor 20%, transparent); border-radius:8px; display:flex; flex-direction:column; gap:5px; }
      /* 未检测前不渲染空虚线框(此前是一条 18px 的“未完成”横条) */
      .aw-rb-check:has(> .aw-rb-check-rows:empty) { display:none; }
      .aw-rb-check-rows { display:flex; flex-direction:column; gap:3px; }
      .aw-rb-check-row { display:flex; gap:6px; align-items:baseline; flex-wrap:wrap; }
      .aw-rb-check-k { opacity:.65; min-width:86px; }
      .aw-rb-check-err { color:#e05a5a; }
      .aw-rb-check-ok { color:#35e0a0; }
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

      function dot(ok, na = false) {
        return ctx.el('span', {
          class: `aw-rb-dot ${na ? 'aw-rb-dot-na' : ok ? 'aw-rb-dot-ok' : 'aw-rb-dot-bad'}`,
          title: na ? t('tokenUnknown') : ok ? t('ok') : t('bad'),
        })
      }

      const backendCell = ctx.el('span', { class: 'aw-rb-cell' }, [dot(false), ` ${t('backend')}`])
      const webCell = ctx.el('span', { class: 'aw-rb-cell' }, [dot(false), ` ${t('web')}`])
      const kbCell = ctx.el('span', { class: 'aw-rb-cell aw-mono' }, [dot(false), ` ${t('kb')}: -`])
      const counterCell = ctx.el('span', { class: 'aw-rb-cell faint' }, [
        `${t('counters')}: ${t('store')} 0 · ${t('index')} 0`,
      ])
      const statusRow = ctx.el('div', { class: 'aw-rb-row' }, [backendCell, webCell, kbCell, counterCell])

      // ---- 连接检测:显式动作,调 /health(宿主后端会拿用户配置的 token 实测受保护端点) ----
      const checkBtn = ctx.el('button', { class: 'aw-rb-btn' }, [t('checkBtn')])
      const checkRows = ctx.el('div', { class: 'aw-rb-check-rows' })
      const checkBox = ctx.el('div', { class: 'aw-rb-check' }, [checkRows])
      checkBtn.addEventListener('click', () => void runCheck())

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
          ctx.el('div', { class: 'aw-rb-row' }, [checkBtn]),
          checkBox,
          ctx.el('div', { class: 'aw-rb-row' }, [input, btn]),
          results,
        ]),
      )

      /** 检测明细行:label + 状态点(true 绿/false 红/null 灰) + 值片段 */
      function checkRow(label, okState, value) {
        const val = ctx.el('span')
        for (const seg of (Array.isArray(value) ? value : [{ text: String(value) }])) {
          val.append(ctx.el('span', { class: seg.cls ?? '' }, [String(seg.text)]))
        }
        return ctx.el('div', { class: 'aw-rb-check-row' }, [
          ctx.el('span', { class: 'aw-rb-check-k' }, [label]),
          dot(okState === true, okState == null),
          val,
        ])
      }

      async function runCheck() {
        checkBtn.disabled = true
        checkBtn.textContent = t('checking')
        const t0 = Date.now()
        const h = await ctx.fetch('/api/plugins/rag-bridge/health').catch(() => null)
        const ms = Date.now() - t0
        const rows = []
        if (!h) {
          rows.push(checkRow(t('checkBtn'), false, [{ text: t('checkFail'), cls: 'aw-rb-check-err' }]))
        }
        else {
          const beOk = h?.backend?.ok === true
          rows.push(checkRow(t('backend'), beOk, beOk
            ? [{ text: `${h.backend.url} · ${h.backend.status ?? 'ok'}` }]
            : [{ text: `${h?.backend?.url ?? '-'} · ${h?.backend?.error ?? h?.backend?.status ?? t('bad')}`, cls: 'aw-rb-check-err' }]))
          const webOk = h?.web?.ok === true
          rows.push(checkRow(t('web'), webOk, webOk
            ? [{ text: `${h.web.url} · ${t('webDocs')} ${h.web.knowledgeBases ?? '-'}` }]
            : [{ text: `${h?.web?.url ?? '-'} · ${h?.web?.error ?? t('bad')}`, cls: 'aw-rb-check-err' }]))
          const acc = h?.token?.accepted
          const tokenTxt = !h?.token?.configured
            ? t('tokenNone')
            : acc === true ? t('tokenAccepted') : acc === false ? t('tokenRejected') : t('tokenUnknown')
          rows.push(checkRow(t('tokenCfg'), h?.token?.configured ? acc : null,
            [{ text: tokenTxt, cls: acc === false ? 'aw-rb-check-err' : '' },
              ...(h?.token?.hint ? [{ text: ` · ${h.token.hint}`, cls: 'aw-rb-check-err' }] : []),
              ...(h?.auth ? [{ text: ` · ${h.auth === 'bearer' ? t('bearer') : t('anonymous')}` }] : [])]))
          rows.push(checkRow(t('kb'), Boolean(h?.kb?.id),
            [{ text: `${h?.kb?.name ?? '-'}${h?.kb?.id ? ` · ${String(h.kb.id).slice(0, 8)}` : ''}` }]))
          const allOk = beOk && webOk && acc !== false
          rows.push(ctx.el('div', { class: 'aw-rb-check-row' }, [
            ctx.el('span', { class: allOk ? 'aw-rb-check-ok' : 'aw-rb-check-err' },
              [allOk ? `✔ ${t('allOk')}` : `✖ ${t('allBad')}`]),
            ctx.el('span', { class: 'faint' }, [` · ${t('latency')} ${ms}ms`]),
          ]))
        }
        checkRows.replaceChildren(...rows)
        checkBtn.disabled = false
        checkBtn.textContent = t('checkBtn')
      }

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
      const offLocale = ctx.hooks.on('i18n:changed', () => void refresh())
      return () => {
        clearInterval(timer)
        offLocale()
      }
    },
  })
}
