/**
 * diag-bridge 客户端面板 —— 注入 'plugins.page' 插槽。
 * 诊断记录表(runId/产线/状态/评分/入库/报告),30s 自动刷新,语言切换即重渲染;
 * 已完成诊断可点「报告」在线查看 report md 全文(经 /report 路由代理诊断服务)。
 */
export function setup(ctx) {
  const styleId = 'aw-diag-styles'
  if (!document.getElementById(styleId)) {
    document.head.append(ctx.el('style', { id: styleId }, [`
      .aw-diag { display:flex; flex-direction:column; gap:8px; font-size:12px; }
      .aw-diag-toolbar { display:flex; justify-content:flex-end; }
      .aw-diag-btn { padding:4px 12px; border:1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius:7px; background:transparent; color:inherit; cursor:pointer; }
      .aw-diag-btn:disabled { opacity:.45; cursor:default; }
      .aw-diag-table { width:100%; border-collapse:collapse; }
      .aw-diag-table th, .aw-diag-table td { text-align:left; padding:5px 8px; border-bottom:1px solid color-mix(in srgb, currentColor 10%, transparent); }
      .aw-diag-table th { opacity:.65; font-weight:500; }
      .aw-diag-st { display:inline-flex; align-items:center; gap:5px; }
      .aw-diag-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
      .aw-diag-dot-running { background:#41c8f4; }
      .aw-diag-dot-completed { background:#35e0a0; }
      .aw-diag-dot-failed, .aw-diag-dot-stopped { background:#e05a5a; }
      .aw-diag-empty { opacity:.6; padding:8px 0; }
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
      const timer = setInterval(load, 30_000)
      const table = ctx.el('div', { class: 'aw-diag-table-wrap' })
      el.append(ctx.el('div', { class: 'aw-diag' }, [
        ctx.el('div', { class: 'aw-diag-toolbar' }, [
          ctx.el('button', { class: 'aw-diag-btn', onclick: () => void load() }, [t('refresh')]),
        ]),
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
      // 语言切换 → 重渲染(标题由插槽响应式解析,表格文案在此重取)
      const offLocale = ctx.hooks.on('i18n:changed', () => void load())
      return () => {
        clearInterval(timer)
        offLocale()
      }
    },
  })
}
