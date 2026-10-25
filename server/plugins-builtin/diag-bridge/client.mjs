/**
 * diag-bridge 客户端面板 —— 注入 'plugins.page' 插槽。
 * 连接检测(调 /health,含用户配置 token 的实测三态,结构化渲染) +
 * 诊断记录表(runId/产线/状态/评分/入库/报告),30s 自动刷新,语言切换即重渲染;
 * 已完成诊断可点「报告」在线查看 report md 全文(经 /report 路由代理诊断服务)。
 */
export function setup(ctx) {
  // 同入口挂第二面板:分析结果库(插件页 order 21;宿主只认 setup(ctx))
  setupResults(ctx)
  const styleId = 'aw-diag-styles'
  if (!document.getElementById(styleId)) {
    document.head.append(ctx.el('style', { id: styleId }, [`
      .aw-diag { display:flex; flex-direction:column; gap:8px; font-size:12px; }
      .aw-diag-toolbar { display:flex; justify-content:flex-end; }
      .aw-diag-btn { padding:4px 12px; border:1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius:7px; background:transparent; color:inherit; cursor:pointer; }
      .aw-diag-btn:disabled { opacity:.45; cursor:default; }
      .aw-diag-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .aw-diag-table { width:100%; border-collapse:collapse; min-width:540px; }
      .aw-diag-table th, .aw-diag-table td { text-align:left; padding:5px 8px; border-bottom:1px solid color-mix(in srgb, currentColor 10%, transparent); white-space:nowrap; }
      .aw-diag-table th { opacity:.65; font-weight:500; }
      .aw-diag-st { display:inline-flex; align-items:center; gap:5px; }
      .aw-diag-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
      .aw-diag-dot-running { background:#41c8f4; }
      .aw-diag-dot-completed { background:#35e0a0; }
      .aw-diag-dot-failed, .aw-diag-dot-stopped { background:#e05a5a; }
      .aw-diag-dot-na { background:#9aa4ad; }
      .aw-diag-empty { opacity:.6; padding:8px 0; }
      .aw-diag-status { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
      .aw-diag-check { padding:8px 10px; border:1px dashed color-mix(in srgb, currentColor 20%, transparent); border-radius:8px; display:flex; flex-direction:column; gap:5px; }
      .aw-diag-check-rows { display:flex; flex-direction:column; gap:3px; }
      .aw-diag-check-row { display:flex; gap:6px; align-items:baseline; flex-wrap:wrap; }
      .aw-diag-check-k { opacity:.65; min-width:86px; }
      .aw-diag-check-err { color:#e05a5a; }
      .aw-diag-check-ok { color:#35e0a0; }
      .aw-diag-modal { position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; }
      .aw-diag-modal-box { width:min(860px, 92vw); max-height:84vh; display:flex; flex-direction:column; gap:8px; background:var(--aw-bg, #101826); color:inherit; border:1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius:12px; padding:14px 16px; }
      .aw-diag-modal-head { display:flex; align-items:center; justify-content:space-between; gap:12px; font-weight:600; }
      .aw-diag-report { flex:1; overflow:auto; white-space:pre-wrap; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; line-height:1.6; }
    `]))
  }

  ctx.ui.registerPanel({
    slot: 'plugins.page',
    name: 'diag-runs',
    titleKey: 'panel.title',
    order: 20,
    mount(el) {
      const t = k => ctx.t(`panel.${k}`)
      const timer = setInterval(() => {
        void load()
        void refreshStatus()
      }, 30_000)
      const table = ctx.el('div', { class: 'aw-diag-table-wrap' })

      function dot(ok, na = false) {
        return ctx.el('span', {
          class: `aw-diag-dot ${na ? 'aw-diag-dot-na' : ok ? 'aw-diag-dot-completed' : 'aw-diag-dot-failed'}`,
          title: na ? t('tokenUnknown') : ok ? t('ok') : t('bad'),
        })
      }

      // ---- 连接状态行(30s 轮询) + 「检测连接」显式检测(宿主后端会拿用户配置的 token 实测受保护端点) ----
      const remoteCell = ctx.el('span', { class: 'aw-diag-st' }, [dot(false), ` ${t('remote')}: -`])
      const tokenCell = ctx.el('span', { class: 'aw-diag-st' }, [dot(false, true), ` ${t('tokenCfg')}: -`])
      const engineCell = ctx.el('span', { class: 'aw-diag-st faint' }, [` ${t('engine')}: -`])
      const statusRow = ctx.el('div', { class: 'aw-diag-status' }, [remoteCell, tokenCell, engineCell])

      const checkBtn = ctx.el('button', { class: 'aw-diag-btn' }, [t('checkBtn')])
      const checkRows = ctx.el('div', { class: 'aw-diag-check-rows' })
      const checkBox = ctx.el('div', { class: 'aw-diag-check' }, [checkRows])
      checkBtn.addEventListener('click', () => void runCheck())

      /** 检测明细行:true 绿 / false 红 / null 灰 */
      function checkRow(label, okState, value) {
        const val = ctx.el('span')
        for (const seg of (Array.isArray(value) ? value : [{ text: String(value) }])) {
          val.append(ctx.el('span', { class: seg.cls ?? '' }, [String(seg.text)]))
        }
        return ctx.el('div', { class: 'aw-diag-check-row' }, [
          ctx.el('span', { class: 'aw-diag-check-k' }, [label]),
          dot(okState === true, okState == null),
          val,
        ])
      }

      /** token 三态文案 */
      const tokenText = tk => !tk?.configured
        ? t('tokenNone')
        : tk?.accepted === true ? t('tokenAccepted') : tk?.accepted === false ? t('tokenRejected') : t('tokenUnknown')

      async function runCheck() {
        checkBtn.disabled = true
        checkBtn.textContent = t('checking')
        const t0 = Date.now()
        const h = await ctx.fetch('/api/plugins/diag-bridge/health').catch(() => null)
        const ms = Date.now() - t0
        const rows = []
        if (!h) {
          rows.push(checkRow(t('checkBtn'), false, [{ text: t('checkFail'), cls: 'aw-diag-check-err' }]))
        }
        else {
          const remote = h?.remote ?? {}
          const rOk = remote?.status === 'ok'
          rows.push(checkRow(t('remote'), rOk, [
            { text: `${h?.base ?? '-'} · ${remote?.status ?? '-'}`, cls: rOk ? '' : 'aw-diag-check-err' },
            ...(remote?.auth ? [{ text: ` · auth=${remote.auth}`, cls: /被拒|401|403/.test(String(remote.auth)) ? 'aw-diag-check-err' : '' }] : []),
            ...(remote?.error ? [{ text: ` · ${remote.error}`, cls: 'aw-diag-check-err' }] : []),
          ]))
          const tk = h?.token ?? {}
          rows.push(checkRow(t('tokenCfg'), tk?.configured ? tk?.accepted : null,
            [{ text: tokenText(tk), cls: tk?.accepted === false ? 'aw-diag-check-err' : '' },
              ...(tk?.hint ? [{ text: ` · ${tk.hint}`, cls: 'aw-diag-check-err' }] : []),
              ...(h?.auth ? [{ text: ` · ${h.auth === 'bearer' ? t('bearer') : t('anonymous')}` }] : [])]))
          rows.push(checkRow(t('engine'), true, [{ text: String(h?.harness ?? '-') }]))
          const by = h?.runs?.byStatus ?? {}
          rows.push(checkRow(t('runs'), true, [{ text: `${h?.runs?.total ?? 0} (completed ${by.completed ?? 0} / running ${by.running ?? 0} / failed ${by.failed ?? 0})` }]))
          const allOk = rOk && tk?.accepted !== false
          rows.push(ctx.el('div', { class: 'aw-diag-check-row' }, [
            ctx.el('span', { class: allOk ? 'aw-diag-check-ok' : 'aw-diag-check-err' },
              [allOk ? `✔ ${t('allOk')}` : `✖ ${t('allBad')}`]),
            ctx.el('span', { class: 'faint' }, [` · ${t('latency')} ${ms}ms`]),
          ]))
        }
        checkRows.replaceChildren(...rows)
        checkBtn.disabled = false
        checkBtn.textContent = t('checkBtn')
      }

      async function refreshStatus() {
        const h = await ctx.fetch('/api/plugins/diag-bridge/health').catch(() => null)
        const remote = h?.remote ?? {}
        const rOk = remote?.status === 'ok'
        remoteCell.replaceChildren(dot(rOk), ` ${t('remote')}: ${remote?.status ?? '-'}${remote?.auth ? `(${remote.auth})` : ''}`)
        const tk = h?.token ?? {}
        tokenCell.replaceChildren(dot(tk?.configured ? tk?.accepted === true : false, !tk?.configured), ` ${t('tokenCfg')}: ${tokenText(tk)}`)
        engineCell.replaceChildren(` ${t('engine')}: ${h?.harness ?? '-'}`)
      }

      el.append(ctx.el('div', { class: 'aw-diag' }, [
        statusRow,
        ctx.el('div', { class: 'aw-diag-toolbar' }, [
          checkBtn,
          ctx.el('button', { class: 'aw-diag-btn', onclick: () => void load() }, [t('refresh')]),
        ]),
        checkBox,
        table,
      ]))

      const statusOf = (s) => {
        const key = ['running', 'completed', 'failed', 'stopped'].includes(s) ? s : 'other'
        return ctx.el('span', { class: 'aw-diag-st' }, [
          ctx.el('span', { class: `aw-diag-dot aw-diag-dot-${key}` }),
          t(`st_${key}`),
        ])
      }

      // 报告查看:拉 /report 路由,弹层渲染 report md 全文
      async function showReport(runId, btn) {
        const modal = ctx.el('div', { class: 'aw-diag-modal' }, [
          ctx.el('div', { class: 'aw-diag-modal-box' }, [
            ctx.el('div', { class: 'aw-diag-modal-head' }, [
              ctx.el('span', {}, [`${t('report')} · ${runId}`]),
              ctx.el('button', { class: 'aw-diag-btn', onclick: () => modal.remove() }, [t('close')]),
            ]),
            ctx.el('div', { class: 'aw-diag-report' }, [t('loading')]),
          ]),
        ])
        modal.addEventListener('click', (e) => {
          if (e.target === modal) modal.remove()
        })
        document.body.append(modal)
        const box = modal.querySelector('.aw-diag-report')
        try {
          const r = await ctx.fetch(`/api/plugins/diag-bridge/report?run_id=${encodeURIComponent(runId)}`)
          if (!r?.success) throw new Error(r?.error || `HTTP error(${runId})`)
          const rep = r.report ?? {}
          box.textContent = typeof rep === 'string' ? rep : String(rep.content ?? JSON.stringify(rep, null, 2))
        }
        catch (err) {
          box.textContent = `${t('report_fail')}: ${err?.message ?? err}`
        }
        finally {
          if (btn) btn.disabled = false
        }
      }

      async function load() {
        const r = await ctx.fetch('/api/plugins/diag-bridge/runs').catch(() => null)
        const runs = Array.isArray(r?.runs) ? r.runs.slice(0, 8) : []
        if (!runs.length) {
          table.replaceChildren(ctx.el('div', { class: 'aw-diag-empty' }, [t('none')]))
          return
        }
        const thead = ctx.el('tr', {}, [
          ctx.el('th', {}, [t('run')]),
          ctx.el('th', {}, [t('line')]),
          ctx.el('th', {}, [t('status')]),
          ctx.el('th', {}, [t('score')]),
          ctx.el('th', {}, [t('stored')]),
          ctx.el('th', {}, [t('report')]),
        ])
        const tbody = ctx.el('tbody')
        for (const run of runs) {
          const isDone = String(run.status ?? '') === 'completed'
          const btn = isDone
            ? ctx.el('button', {
                class: 'aw-diag-btn',
                onclick: () => {
                  btn.disabled = true
                  void showReport(String(run.runId), btn)
                },
              }, [t('view')])
            : ctx.el('span', { style: 'opacity:.4' }, ['-'])
          tbody.append(ctx.el('tr', {}, [
            ctx.el('td', { class: 'aw-mono' }, [String(run.runId ?? '-')]),
            ctx.el('td', {}, [String(run.line ?? '-')]),
            ctx.el('td', {}, [statusOf(String(run.status ?? ''))]),
            ctx.el('td', {}, [run.score != null ? String(run.score) : '-']),
            ctx.el('td', {}, [run.stored === true ? t('yes') : t('no')]),
            ctx.el('td', {}, [btn]),
          ]))
        }
        table.replaceChildren(ctx.el('table', { class: 'aw-diag-table' }, [ctx.el('thead', {}, [thead]), tbody]))
      }

      void load()
      void refreshStatus()
      // 语言切换 → 重渲染(标题由插槽响应式解析,表格文案在此重取)
      const offLocale = ctx.hooks.on('i18n:changed', () => {
        void load()
        void refreshStatus()
      })
      return () => {
        clearInterval(timer)
        offLocale()
      }
    },
  })
}

// ══ 第二面板:分析结果库(§16;经插件路由代理,同源同开关) ══════════════════════
export function setupResults(ctx) {
  ctx.ui.registerPanel({
    slot: 'plugins.page',
    name: 'diag-results',
    titleKey: 'panel_results.title',
    order: 21,
    mount(el) {
      const t = k => ctx.t(`panel_results.${k}`)
      const box = ctx.el('div', { class: 'aw-diag' })
      const state = { list: null, total: 0, detail: null, editing: false, error: '', canAnnotate: false }

      const searchInput = ctx.el('input', { type: 'search', placeholder: t('search'), style: 'min-width:220px;padding:4px 8px;border-radius:7px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:transparent;color:inherit' })
      const intentSel = ctx.el('select', { style: 'padding:4px;border-radius:7px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:transparent;color:inherit' }, [
        ctx.el('option', { value: '' }, [t('allIntents')]),
        ...['deep-diagnosis', 'stability-report', 'quick-screen', 'doe-analysis', 'experience-mining', 'optimizer-campaign'].map(v => ctx.el('option', { value: v }, [v])),
      ])
      const searchBtn = ctx.el('button', { class: 'aw-diag-btn' }, [t('searchBtn')])
      const statusLine = ctx.el('div', { class: 'aw-diag-empty' })
      const listWrap = ctx.el('div', { class: 'aw-diag-table-wrap' })
      box.append(
        ctx.el('div', { class: 'aw-diag-toolbar', style: 'justify-content:flex-start;gap:8px;flex-wrap:wrap' }, [searchInput, intentSel, searchBtn]),
        statusLine,
        listWrap,
      )

      function setError(msg) {
        statusLine.textContent = ''
        listWrap.replaceChildren(ctx.el('div', { class: 'aw-diag-empty' }, [msg]))
      }

      async function load() {
        const qs = new URLSearchParams({ brief: 'false', limit: '20' })
        const q = String(searchInput.value ?? '').trim()
        if (q) qs.set('q', q)
        const intent = String(intentSel.value ?? '')
        if (intent) qs.set('intent', intent)
        const r = await ctx.fetch(`/api/plugins/diag-bridge/results?${qs.toString()}`).catch(err => ({ __err: String(err?.message ?? err) }))
        if (r?.__err) {
          setError(`${t('loadFail')}: ${r.__err}`)
          return
        }
        if (r?.success === false) {
          setError(String(r?.error ?? t('loadFail')))
          return
        }
        const d = r?.data ?? {}
        state.list = d.results ?? []
        state.total = d.total ?? 0
        statusLine.textContent = t('total').replace('{n}', String(state.total))
        renderList()
        // annotate 能力探测:设置不可见,尝试 PATCH 一个非法体(400 即代表开放)
      }

      function renderList() {
        if (!state.list?.length) {
          listWrap.replaceChildren(ctx.el('div', { class: 'aw-diag-empty' }, [t('empty')]))
          return
        }
        const table = ctx.el('table', { class: 'aw-diag-table' })
        table.append(ctx.el('tr', {}, [t('colId'), t('colTitle'), t('colIntent'), t('colScore'), t('colVerdict'), t('colCreated'), t('colTags')].map(h => ctx.el('th', {}, [h]))))
        for (const c of state.list) {
          const tr = ctx.el('tr', { style: 'cursor:pointer' })
          for (const text of [c.result_id, c.title, c.intent, String(c.score ?? '-'), String(c.verdict ?? '-'), String(c.completed_at ?? c.created_at ?? '-'), (c.tags ?? []).join(',')]) {
            tr.append(ctx.el('td', {}, [String(text)]))
          }
          tr.addEventListener('click', () => void openDetail(String(c.result_id)))
          table.append(tr)
        }
        listWrap.replaceChildren(table)
      }

      async function openDetail(id) {
        const r = await ctx.fetch(`/api/plugins/diag-bridge/results/detail?id=${encodeURIComponent(id)}&include_md=true`).catch(() => null)
        if (!r || r?.success === false) {
          setError(String(r?.error ?? t('loadFail')))
          return
        }
        state.detail = r.data
        renderDetail()
      }

      function renderDetail() {
        const d = state.detail
        if (!d) return
        const closeBtn = ctx.el('button', { class: 'aw-diag-btn' }, [t('close')])
        closeBtn.addEventListener('click', () => {
          state.detail = null
          state.editing = false
          renderList()
        })
        const boxD = ctx.el('div', { class: 'aw-diag', style: 'gap:10px' })
        const head = ctx.el('div', { class: 'aw-diag-modal-head' }, [`${d.result_id} · ${d.title ?? ''} · ${d.intent ?? ''} · ${d.score ?? '-'}分 ${d.verdict ?? ''}`, closeBtn])
        const summary = ctx.el('div', { style: 'white-space:pre-wrap;max-height:120px;overflow:auto' }, [String(d.summary ?? '')])
        const kn = d.summary_json?.key_numbers ? ctx.el('div', { class: 'aw-diag-check-row' }, [ctx.el('span', { class: 'aw-diag-check-k' }, [t('keyNumbers')]), JSON.stringify(d.summary_json.key_numbers)]) : null
        const htmlLinks = ctx.el('div', { class: 'aw-diag-check-row' }, [ctx.el('span', { class: 'aw-diag-check-k' }, [t('htmlReports')]),
          ...(d.files?.html ?? []).slice(0, 6).map(h => ctx.el('a', { href: h.url, target: '_blank', style: 'margin-right:10px' }, [String(h.path ?? 'html')]))])
        const md = ctx.el('details', {}, [ctx.el('summary', {}, [t('reportMd')]), ctx.el('div', { class: 'aw-diag-report', style: 'max-height:280px' }, [String(d.report_md ?? '(include_md 未开启或无内容)')])])
        boxD.append(head, summary)
        if (kn) boxD.append(kn)
        boxD.append(htmlLinks, md)
        // 编辑区(仅当尝试 annotate 成功可见;失败显示只读)
        const descInput = ctx.el('textarea', { rows: 3, style: 'width:100%;border-radius:7px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:transparent;color:inherit' })
        descInput.value = String(d.description ?? '')
        const tagsInput = ctx.el('input', { type: 'text', style: 'width:100%;padding:4px 8px;border-radius:7px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:transparent;color:inherit' })
        tagsInput.value = (d.tags ?? []).join(',')
        const saveBtn = ctx.el('button', { class: 'aw-diag-btn' }, [t('save')])
        const saveMsg = ctx.el('span', { class: 'aw-diag-empty' })
        saveBtn.addEventListener('click', async () => {
          saveBtn.disabled = true
          saveMsg.textContent = t('loading')
          const tags = String(tagsInput.value).split(',').map(s => s.trim()).filter(Boolean)
          const r = await ctx.fetch(`/api/plugins/diag-bridge/results/edit?id=${encodeURIComponent(d.result_id)}`, {
            method: 'PATCH',
            body: { description: descInput.value, tags },
          }).catch(err => ({ success: false, error: String(err?.message ?? err) }))
          saveBtn.disabled = false
          if (r?.success) {
            saveMsg.textContent = t('saved')
            state.detail = r.data
            renderDetail()
            void load()
          }
          else {
            saveMsg.textContent = `${t('saveFail')}: ${String(r?.error ?? '')}`
            if (String(r?.error ?? '').includes('未开放')) state.canAnnotate = false
          }
        })
        const editBox = ctx.el('div', { class: 'aw-diag-check' }, [
          ctx.el('div', {}, [t('edit')]),
          ctx.el('label', { style: 'display:block;margin:4px 0' }, [t('editDesc')]),
          descInput,
          ctx.el('label', { style: 'display:block;margin:6px 0 4px' }, [t('editTags')]),
          tagsInput,
          ctx.el('div', { style: 'margin-top:8px;display:flex;gap:8px;align-items:center' }, [saveBtn, saveMsg]),
        ])
        boxD.append(editBox)
        listWrap.replaceChildren(boxD)
      }

      searchBtn.addEventListener('click', () => void load())
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void load()
      })
      el.append(box)
      void load()
      return () => {}
    },
  })
}
