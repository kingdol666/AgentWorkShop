/**
 * diag-bridge 客户端面板 —— 注入 'plugins.page' 插槽。
 * 诊断记录表(runId/产线/状态/评分/入库),30s 自动刷新,语言切换即重渲染。
 */
export function setup(ctx) {
  const styleId = 'aw-diag-styles'
  if (!document.getElementById(styleId)) {
    document.head.append(ctx.el('style', { id: styleId }, [`
      .aw-diag { display:flex; flex-direction:column; gap:8px; font-size:12px; }
      .aw-diag-toolbar { display:flex; justify-content:flex-end; }
      .aw-diag-btn { padding:4px 12px; border:1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius:7px; background:transparent; color:inherit; cursor:pointer; }
      .aw-diag-table { width:100%; border-collapse:collapse; }
      .aw-diag-table th, .aw-diag-table td { text-align:left; padding:5px 8px; border-bottom:1px solid color-mix(in srgb, currentColor 10%, transparent); }
      .aw-diag-table th { opacity:.65; font-weight:500; }
      .aw-diag-st { display:inline-flex; align-items:center; gap:5px; }
      .aw-diag-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
      .aw-diag-dot-running { background:#41c8f4; }
      .aw-diag-dot-completed { background:#35e0a0; }
      .aw-diag-dot-failed, .aw-diag-dot-stopped { background:#e05a5a; }
      .aw-diag-empty { opacity:.6; padding:8px 0; }
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
        ])
        const tbody = ctx.el('tbody')
        for (const run of runs) {
          tbody.append(ctx.el('tr', {}, [
            ctx.el('td', { class: 'aw-mono' }, [String(run.runId ?? '-')]),
            ctx.el('td', {}, [String(run.line ?? '-')]),
            ctx.el('td', {}, [statusOf(String(run.status ?? ''))]),
            ctx.el('td', {}, [run.score != null ? String(run.score) : '-']),
            ctx.el('td', {}, [run.stored === true ? t('yes') : t('no')]),
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
