/**
 * 闭环调优优化曲线生成器 —— 拉取熔体温度全窗口采样,渲染 SVG(SPV 阶跃 + 事件标注)。
 * 用法:node scripts/render-opt-curve.mjs <adminToken> <outSvg>
 */
const BASE = 'http://localhost:3001'
const token = process.argv[2] ?? ''
const out = process.argv[3] ?? 'opt-curve.svg'

const NODE = 'dn-0183240d' // 熔体温度(modbus PV)
const WINDOW_MS = 80 * 60_000
const to = Date.now()
const from = to - WINDOW_MS

const r = await fetch(`${BASE}/api/workshop/daq/${NODE}/samples?from=${from}&to=${to}&bucketMs=15000&limit=400`, {
  headers: { authorization: `Bearer ${token}` },
})
const j = await r.json()
const points = (j.data?.points ?? j.data?.samples ?? j.data ?? [])
  .map(p => ({ t: Number(p.t ?? p.ts ?? p.at), v: Number(p.v ?? p.value ?? p.avg) }))
  .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v))
  .sort((a, b) => a.t - b.t)
if (points.length < 5) {
  console.error('采样不足:', JSON.stringify(j).slice(0, 200))
  process.exit(1)
}
console.log(`采样点: ${points.length}, 窗口 ${new Date(points[0].t).toISOString()} ~ ${new Date(points.at(-1).t).toISOString()}`)

// DOE 阶梯事件(审计核验的审批下发时刻,+08 本地)
const events = [
  { t: Date.parse('2026-10-02T16:46:44Z'), label: 'R1 SP→197', color: '#41c8f4' },
  { t: Date.parse('2026-10-03T01:01:17+08:00'), label: 'R2 SP→200', color: '#f4a941' },
  { t: Date.parse('2026-10-03T01:08:07+08:00'), label: 'R3 SP→205', color: '#e06060' },
  { t: Date.parse('2026-10-03T01:16:49+08:00'), label: 'R4 SP→210', color: '#b58cf0' },
  { t: Date.parse('2026-10-03T01:35:00+08:00'), label: '回基线 193', color: '#35e0a0' },
].filter(e => e.t >= from && e.t <= to)

// SP 阶跃(DOE 五级梯度和回基线;时刻 = 审计下发时刻)
const spStep = [
  { t: points[0].t, v: 195 },
  { t: Date.parse('2026-10-02T16:46:44Z'), v: 195 },
  { t: Date.parse('2026-10-02T16:46:44Z'), v: 197 },
  { t: Date.parse('2026-10-03T01:01:17+08:00'), v: 197 },
  { t: Date.parse('2026-10-03T01:01:17+08:00'), v: 200 },
  { t: Date.parse('2026-10-03T01:08:07+08:00'), v: 200 },
  { t: Date.parse('2026-10-03T01:08:07+08:00'), v: 205 },
  { t: Date.parse('2026-10-03T01:16:49+08:00'), v: 205 },
  { t: Date.parse('2026-10-03T01:16:49+08:00'), v: 210 },
  { t: Date.parse('2026-10-03T01:35:00+08:00'), v: 210 },
  { t: Date.parse('2026-10-03T01:35:00+08:00'), v: 193 },
  { t: points.at(-1).t, v: 193 },
].filter(p => p.t >= from)

// ── SVG 几何 ──
const W = 960, H = 420
const ML = 64, MR = 24, MT = 46, MB = 56
const iw = W - ML - MR, ih = H - MT - MB
const tMin = points[0].t, tMax = points.at(-1).t
const vs = points.map(p => p.v)
const spVs = spStep.map(p => p.v)
const vLo = Math.min(...vs, ...spVs) - 0.4
const vHi = Math.max(...vs, ...spVs) + 0.4
const X = t => ML + ((t - tMin) / (tMax - tMin)) * iw
const Y = v => MT + (1 - (v - vLo) / (vHi - vLo)) * ih

const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ')
const spPath = spStep.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ')
const hhmm = (t) => {
  const d = new Date(t + 8 * 3600e3)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
const gridVals = []
for (let v = Math.ceil(vLo); v <= Math.floor(vHi); v++) gridVals.push(v)
const grid = gridVals.map(v => `<line x1="${ML}" y1="${Y(v).toFixed(1)}" x2="${W - MR}" y2="${Y(v).toFixed(1)}" stroke="#eee"/><text x="${ML - 8}" y="${(Y(v) + 4).toFixed(1)}" font-size="11" fill="#888" text-anchor="end">${v}</text>`).join('')
const xticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
  const t = tMin + f * (tMax - tMin)
  return `<line x1="${X(t).toFixed(1)}" y1="${MT + ih}" x2="${X(t).toFixed(1)}" y2="${MT + ih + 5}" stroke="#999"/><text x="${X(t).toFixed(1)}" y="${MT + ih + 20}" font-size="11" fill="#888" text-anchor="middle">${hhmm(t)}</text>`
}).join('')
const eventLines = events.map(e => `<line x1="${X(e.t).toFixed(1)}" y1="${MT}" x2="${X(e.t).toFixed(1)}" y2="${MT + ih}" stroke="${e.color}" stroke-dasharray="4 3" opacity="0.8"/><text x="${(X(e.t) + 5).toFixed(1)}" y="${MT + 14}" font-size="11" fill="${e.color}">${e.label}</text>`).join('')
const mean = (vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(3)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui,sans-serif">
<rect width="${W}" height="${H}" fill="#fff"/>
<text x="${W / 2}" y="22" font-size="15" font-weight="600" fill="#222" text-anchor="middle">闭环调优实验 · 熔体温度 PV 响应曲线(2026-10-02,混合产线 PLC+MES)</text>
<text x="${W / 2}" y="38" font-size="11" fill="#888" text-anchor="middle">dn-0183240d(modbus-tcp)· ${points.length} 采样点 · 窗口均值 ${mean}℃ · 采样 15s 降采样</text>
${grid}${xticks}${eventLines}
<path d="${spPath}" stroke="#e06060" stroke-width="1.6" fill="none" stroke-dasharray="6 3"/>
<path d="${path}" stroke="#3565e0" stroke-width="1.4" fill="none"/>
<circle cx="${X(points.at(-1).t).toFixed(1)}" cy="${Y(points.at(-1).v).toFixed(1)}" r="3" fill="#3565e0"/>
<rect x="${ML}" y="${H - MB + 26}" width="12" height="3" fill="#3565e0"/><text x="${ML + 18}" y="${H - MB + 30}" font-size="11" fill="#555">熔体温度 PV(daq 实采)</text>
<rect x="${ML + 190}" y="${H - MB + 26}" width="12" height="3" fill="#e06060"/><text x="${ML + 208}" y="${H - MB + 30}" font-size="11" fill="#555">加热区1SP(配方下发阶跃)</text>
<text x="${ML + 420}" y="${H - MB + 30}" font-size="11" fill="#888">DOE 五级梯度 195→197→200→205→210 全经 HITL 审批由 omp Agent 提案下发 · 残差分析:zone1-SP 耦合≈0</text>
</svg>`

const { writeFileSync, mkdirSync } = await import('node:fs')
const { dirname } = await import('node:path')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, svg)
console.log('SVG 已生成:', out, `(${svg.length} bytes)`)
