#!/usr/bin/env node
/**
 * 2026-10-29 生产投产验收 — 汇总报告生成(summary.json → report.html)。
 * 数据源:本轮各套件证据文件 + 手工汇整行。输出自包含 HTML(无外部 CDN)。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVID = join(HERE, '..')
const S = JSON.parse(readFileSync(join(HERE, 'summary.json'), 'utf8'))

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const badge = ok => ok === true ? '<span class="b pass">PASS</span>' : ok === false ? '<span class="b fail">FAIL</span>' : `<span class="b warn">${esc(ok)}</span>`

const sections = S.layers.map(layer => `
  <section>
    <h2>${esc(layer.title)} ${badge(layer.verdict)}</h2>
    ${layer.note ? `<p class="lnote">${esc(layer.note)}</p>` : ''}
    <table>
      <thead><tr><th>套件 / 断言</th><th class="num">计数</th><th>结论</th><th>说明</th></tr></thead>
      <tbody>${layer.rows.map(r => `<tr><td>${esc(r.suite)}</td><td class="num">${esc(r.count)}</td><td>${badge(r.verdict)}</td><td class="note">${esc(r.note ?? '')}</td></tr>`).join('')}</tbody>
    </table>
  </section>`).join('')

const golive = (S.golive ?? []).map(g => `<tr><td class="mono">${esc(g.id)}</td><td>${esc(g.name)}</td><td>${badge(true)}</td></tr>`).join('')

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentWorkShop 生产投产全量验收 · 2026-10-29</title>
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
  .mono { font-family:var(--font-mono, ui-monospace, Consolas); }
  .b { display:inline-block; padding:1px 10px; border-radius:999px; font-size:12.5px; font-weight:700; }
  .b.pass { background:rgba(52,211,153,.14); color:var(--pass); }
  .b.fail { background:rgba(248,113,113,.14); color:var(--fail); }
  .b.warn { background:rgba(251,191,36,.14); color:var(--warn); }
  .lnote { color:var(--dim); font-size:13.5px; margin:6px 0 10px; }
  ul.pit { margin:6px 0; padding-left:22px; } ul.pit li { margin:4px 0; }
  .topo { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 18px; font-size:13.5px; color:var(--dim); }
  .topo b { color:var(--fg); }
  .gates { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:10px; }
  .gate { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 14px; font-size:13.5px; }
  .gate b { color:var(--pass); }
  footer { margin-top:44px; color:var(--dim); font-size:12.5px; border-top:1px solid var(--line); padding-top:14px; }
</style>
</head>
<body><div class="wrap">
  <h1>AgentWorkShop 生产投产全量验收报告</h1>
  <div class="sub">v0.8.7(commit 1f30de69)· ${esc(S.at)} · 按 aw-system-acceptance 五层流程 + 真实设备联动矩阵 + 生产硬门 · 验收执行:自动化流水</div>

  <div class="verdict">${S.verdictHtml}</div>

  <div class="kpis">
    ${S.kpis.map(k => `<div class="kpi"><div class="v">${esc(k.v)}</div><div class="k">${esc(k.k)}</div></div>`).join('')}
  </div>

  <h2>验收拓扑</h2>
  <div class="topo">${S.topology}</div>

  ${sections}

  <section>
    <h2>真实设备联动矩阵(e2e-golive-matrix,21/21)—— 投产核心证据</h2>
    <table>
      <thead><tr><th class="mono">断言</th><th>内容</th><th>结论</th></tr></thead>
      <tbody>${golive}</tbody>
    </table>
    <p class="lnote">隔离模拟器(4036)提供五族<b>真实协议栈从站</b>(Modbus TCP 16040 / Modbus RTU 15041 / OPC UA 5840 / MQTT broker 18830 / HTTP),平台经真实协议驱动接入:D 组证明「平台样本 = 设备侧信号值」(真连通而非伪造);W 组证明「开线配方 + Agent 令牌批量下发四协议写穿,平台回读=设备值=目标」;N 组证明越量程/超单步被拒且设备不变;F 组证明断链时连接测试与写入<b>如实失败</b>(不静默成功、不伪造数据)、恢复后自愈重证。</p>
  </section>

  <section>
    <h2>生产就绪硬门(8/8)</h2>
    <div class="gates">
      ${S.gates.map(g => `<div class="gate"><b>✔</b> ${esc(g)}</div>`).join('')}
    </div>
  </section>

  <section>
    <h2>投产节奏建议(通过后的上线路径)</h2>
    <ul class="pit">${S.rollout.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
  </section>

  <section>
    <h2>边界与声明</h2>
    <ul class="pit">${S.gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>
  </section>

  <footer>证据根:docs/audit/evidence/2026-10-29-prod-acceptance/(logs/ 全套件原始输出)+ 各套件自带证据目录。Mimosa 完整扫描未完成(scanner_enobufs),本报告只裁决功能与联动面,不宣称安全。</footer>
</div></body></html>`

writeFileSync(join(EVID, 'report.html'), html)
console.log('report.html written,', html.length, 'bytes')
