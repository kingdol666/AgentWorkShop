#!/usr/bin/env node
/**
 * 2026-10-29 ralph 全量验收 — 可视化 HTML 报告生成器。
 * 输入: summary.json(手工汇整的套件矩阵)+ 证据目录内的 report.json + screens/*.png
 * 输出: report.html(自包含,内联 CSS/JS,无外部 CDN;截图相对路径引用)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVID = join(HERE, '..')
const S = JSON.parse(readFileSync(join(HERE, 'summary.json'), 'utf8'))

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const badge = ok => ok === true ? '<span class="b pass">PASS</span>' : ok === false ? '<span class="b fail">FAIL</span>' : `<span class="b warn">${esc(ok)}</span>`

const layerTable = (rows) => rows.map(r => `
  <tr><td>${esc(r.suite)}</td><td class="num">${esc(r.count)}</td><td>${badge(r.verdict)}</td><td class="note">${esc(r.note ?? '')}</td><td class="path">${esc(r.evidence ?? '')}</td></tr>`).join('')

const sections = []
for (const layer of S.layers) {
  sections.push(`
  <section>
    <h2>${esc(layer.title)} ${badge(layer.verdict)}</h2>
    ${layer.note ? `<p class="lnote">${esc(layer.note)}</p>` : ''}
    <table>
      <thead><tr><th>套件 / 断言</th><th class="num">计数</th><th>结论</th><th>说明</th><th>证据</th></tr></thead>
      <tbody>${layerTable(layer.rows)}</tbody>
    </table>
  </section>`)
}

const shots = (S.screens ?? []).map(s => `
  <figure><img loading="lazy" src="screens/${esc(s.file)}" alt="${esc(s.title)}"><figcaption>${esc(s.title)}</figcaption></figure>`).join('')

const threeMode = (S.threeMode ?? []).map(m => `
  <tr><td>${esc(m.mode)}</td><td>${badge(m.chain)}</td><td class="note">${esc(m.evidence)}</td></tr>`).join('')

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentWorkShop 三系统全量验收报告 · 2026-10-29</title>
<style>
  :root { --bg:#0f1420; --card:#171e2e; --line:#2a3450; --fg:#e8edf7; --dim:#9aa7c0; --pass:#34d399; --fail:#f87171; --warn:#fbbf24; --acc:#60a5fa; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.65 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; padding:32px 20px 80px; }
  h1 { font-size:26px; margin:0 0 6px; }
  h2 { font-size:19px; margin:34px 0 10px; border-left:4px solid var(--acc); padding-left:10px; }
  .sub { color:var(--dim); margin-bottom:22px; }
  .verdict { font-size:17px; padding:14px 18px; border-radius:10px; background:var(--card); border:1px solid var(--line); margin:18px 0; }
  .verdict b.g { color:var(--pass); } .verdict b.r { color:var(--fail); }
  .kpis { display:flex; gap:12px; flex-wrap:wrap; margin:18px 0; }
  .kpi { flex:1 1 160px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 16px; }
  .kpi .v { font-size:24px; font-weight:700; } .kpi .k { color:var(--dim); font-size:12.5px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border-radius:10px; overflow:hidden; }
  th,td { padding:8px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
  th { background:#1d2740; color:var(--dim); font-weight:600; font-size:13px; }
  td.num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  td.note { color:var(--dim); font-size:13px; }
  td.path { color:#7dd3fc; font-size:12px; word-break:break-all; }
  .b { display:inline-block; padding:1px 10px; border-radius:999px; font-size:12.5px; font-weight:700; }
  .b.pass { background:rgba(52,211,153,.14); color:var(--pass); }
  .b.fail { background:rgba(248,113,113,.14); color:var(--fail); }
  .b.warn { background:rgba(251,191,36,.14); color:var(--warn); }
  .lnote { color:var(--dim); font-size:13.5px; margin:6px 0 10px; }
  .shots { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:14px; }
  .shots figure { margin:0; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .shots img { width:100%; display:block; }
  .shots figcaption { padding:7px 12px; color:var(--dim); font-size:13px; }
  ul.pit { margin:6px 0; padding-left:22px; } ul.pit li { margin:4px 0; }
  .topo { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 18px; font-size:13.5px; color:var(--dim); }
  .topo b { color:var(--fg); }
  footer { margin-top:44px; color:var(--dim); font-size:12.5px; border-top:1px solid var(--line); padding-top:14px; }
</style>
</head>
<body><div class="wrap">
  <h1>AgentWorkShop 三系统全量验收报告</h1>
  <div class="sub">AgentWorkShop v0.8.6 + IDD(industrial-deep-diagnostic)+ RAG(rag-knowledge) · ${esc(S.at)} · harness=omp/USTC-deepseek-flash · 验收执行:ralph 自动化流水</div>

  <div class="verdict">${S.verdictHtml}</div>

  <div class="kpis">
    ${S.kpis.map(k => `<div class="kpi"><div class="v">${esc(k.v)}</div><div class="k">${esc(k.k)}</div></div>`).join('')}
  </div>

  <h2>系统拓扑(本轮重启后)</h2>
  <div class="topo">${S.topology}</div>

  ${sections.join('')}

  <section>
    <h2>Channel 三模式实机演示(omp × USTC/deepseek-flash)</h2>
    <table>
      <thead><tr><th>模式</th><th>控制链判决</th><th>证据摘要</th></tr></thead>
      <tbody>${threeMode}</tbody>
    </table>
    <p class="lnote">${esc(S.threeModeNote ?? '')}</p>
  </section>

  <section>
    <h2>关键页面实机截图(3300 验收实例 · dark)</h2>
    <div class="shots">${shots}</div>
  </section>

  <section>
    <h2>执行坑账(环境/脚本,非平台缺陷)</h2>
    <ul class="pit">${S.pitfalls.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
  </section>

  <section>
    <h2>未覆盖面与边界声明</h2>
    <ul class="pit">${S.gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>
  </section>

  <footer>证据根:docs/audit/evidence/2026-10-29-ralph-full-acceptance/ · 本报告自包含(无外部 CDN);截图相对路径 screens/ 需与本文件同级。Mimosa 安全扫描未在本轮执行,本报告只裁决功能面。</footer>
</div></body></html>`

writeFileSync(join(EVID, 'report.html'), html)
console.log('report.html written,', html.length, 'bytes')
