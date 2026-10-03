/**
 * 泵压闭环寻优曲线(实测点汇总版)
 * 数据源:daq 序列实采(08:26-08:37 基线段) + 编排器轮询实读(审计时刻锚定)
 * 用法:node scripts/render-pressure-curve.mjs <adminToken> [outSvg]
 */
const out = process.argv[3] ?? 'docs/audit/assets/opt-curve-2026-10-03-pressure.svg'
const GOAL = 16.6

// 实测点(+08 时刻,来源:daq 序列实采与编排器轮询,SP 阶段按审计下发时刻归属)
const P = (hhmm, v, phase) => ({ t: Date.parse(`2026-10-03T${hhmm}:00+08:00`), v, phase })
const points = [
  // 基线段(screw=125,daq 序列实采)
  P('08:26', 15.89, 'base'), P('08:27', 15.91, 'base'), P('08:28', 15.93, 'base'),
  P('08:29', 15.89, 'base'), P('08:30', 15.9, 'base'), P('08:31', 15.9, 'base'),
  P('08:32', 15.2, 'base'), P('08:33', 15.09, 'base'), P('08:34', 15.05, 'base'),
  P('08:35', 15.02, 'base'), P('08:36', 15.02, 'base'), P('08:37', 15.07, 'base'),
  // R2 段(screw=131,09:04:38 审批下发,轮询实读)
  P('09:19', 15.755, 'r2'), P('09:29', 15.84, 'r2'), P('09:39', 15.78, 'r2'),
  P('09:49', 15.756, 'r2'), P('09:59', 15.784, 'r2'),
  // R3 段(screw=135,10:10:16 审批下发,轮询实读)
  P('10:21', 16.443, 'r3'), P('10:31', 16.263, 'r3'), P('10:41', 16.344, 'r3'), P('10:51', 16.344, 'r3'),
].sort((a, b) => a.t - b.t)

// 事件(审计核验)
const events = [
  { t: Date.parse('2026-10-03T09:04:38+08:00'), label: 'R2 125→131(HITL)', color: '#41c8f4' },
  { t: Date.parse('2026-10-03T10:10:16+08:00'), label: 'R3 131→135(HITL)', color: '#f4a941' },
  { t: Date.parse('2026-10-03T10:10:33+08:00'), label: 'admin revert v3(交错留痕)', color: '#e06060' },
]

// ScrewSpeedSP 阶跃
const spStep = [
  { t: points[0].t, v: 125 },
  { t: Date.parse('2026-10-03T09:04:38+08:00'), v: 125 },
  { t: Date.parse('2026-10-03T09:04:38+08:00'), v: 131 },
  { t: Date.parse('2026-10-03T10:10:16+08:00'), v: 131 },
  { t: Date.parse('2026-10-03T10:10:16+08:00'), v: 135 },
  { t: points.at(-1).t, v: 135 },
]

const W = 960, H = 430
const ML = 64, MR = 24, MT = 46, MB = 56
const iw = W - ML - MR, ih = H - MT - MB
const tMin = points[0].t, tMax = points.at(-1).t
const vs = points.map(p => p.v)
const spVs = spStep.map(p => p.v)
const vLo = Math.floor(Math.min(...vs, ...spVs, GOAL) - 0.4)
const vHi = Math.ceil(Math.max(...vs, ...spVs, GOAL) + 0.4)
const X = t => ML + ((t - tMin) / (tMax - tMin)) * iw
const Y = v => MT + (1 - (v - vLo) / (vHi - vLo)) * ih

const segColor = { base: '#8899aa', r2: '#3565e0', r3: '#5a3fd4' }
let path = ''
for (let i = 0; i < points.length; i++) {
  path += `${i ? 'L' : 'M'}${X(points[i].t).toFixed(1)},${Y(points[i].v).toFixed(1)} `
}
const spPath = spStep.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ')
const hhmm = (t) => {
  const d = new Date(t + 8 * 3600e3)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
const gridVals = []
for (let v = vLo; v <= vHi; v++) gridVals.push(v)
const grid = gridVals.map(v => `<line x1="${ML}" y1="${Y(v).toFixed(1)}" x2="${W - MR}" y2="${Y(v).toFixed(1)}" stroke="#eee"/><text x="${ML - 8}" y="${(Y(v) + 4).toFixed(1)}" font-size="11" fill="#888" text-anchor="end">${v}</text>`).join('')
const xticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
  const t = tMin + f * (tMax - tMin)
  return `<line x1="${X(t).toFixed(1)}" y1="${MT + ih}" x2="${X(t).toFixed(1)}" y2="${MT + ih + 5}" stroke="#999"/><text x="${X(t).toFixed(1)}" y="${MT + ih + 20}" font-size="11" fill="#888" text-anchor="middle">${hhmm(t)}</text>`
}).join('')
const eventLines = events.map(e => `<line x1="${X(e.t).toFixed(1)}" y1="${MT}" x2="${X(e.t).toFixed(1)}" y2="${MT + ih}" stroke="${e.color}" stroke-dasharray="4 3" opacity="0.8"/><text x="${(X(e.t) + 5).toFixed(1)}" y="${MT + 14}" font-size="11" fill="${e.color}">${e.label}</text>`).join('')
const goalLine = `<line x1="${ML}" y1="${Y(GOAL).toFixed(1)}" x2="${W - MR}" y2="${Y(GOAL).toFixed(1)}" stroke="#35e0a0" stroke-dasharray="8 4" stroke-width="1.2"/><text x="${W - MR - 6}" y="${(Y(GOAL) - 5).toFixed(1)}" font-size="11" fill="#35e0a0" text-anchor="end">GOAL ${GOAL} MPa</text>`
const dots = points.map(p => `<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="2.2" fill="${segColor[p.phase] ?? '#3565e0'}"/>`).join('')
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui,sans-serif">
<rect width="${W}" height="${H}" fill="#fff"/>
<text x="${W / 2}" y="22" font-size="15" font-weight="600" fill="#222" text-anchor="middle">泵压闭环寻优 · OPC UA MeltPressure 响应曲线(2026-10-03,线2 螺杆因子 DOE)</text>
<text x="${W / 2}" y="38" font-size="11" fill="#888" text-anchor="middle">dn-121838ac(opcua)· ${points.length} 个实测点(daq 序列实采 + 审计时刻锚定轮询)· 全程测厚护栏正常</text>
${grid}${xticks}${eventLines}${goalLine}
<path d="${spPath}" stroke="#e06060" stroke-width="1.6" fill="none" stroke-dasharray="6 3"/>
<path d="${path}" stroke="#3565e0" stroke-width="1.2" fill="none" opacity="0.85"/>
${dots}
<rect x="${ML}" y="${H - MB + 26}" width="12" height="3" fill="#3565e0"/><text x="${ML + 18}" y="${H - MB + 30}" font-size="11" fill="#555">泵压 PV(实采/轮询)</text>
<rect x="${ML + 180}" y="${H - MB + 26}" width="12" height="3" fill="#e06060"/><text x="${ML + 198}" y="${H - MB + 30}" font-size="11" fill="#555">ScrewSpeedSP(配方下发阶跃)</text>
<text x="${ML + 430}" y="${H - MB + 30}" font-size="11" fill="#888">R2/R3 均经 HITL 审批由 omp Agent 提案下发 · 全链审计留痕</text>
</svg>`

const { writeFileSync, mkdirSync } = await import('node:fs')
const { dirname } = await import('node:path')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, svg)
console.log('SVG 已生成:', out, `(${svg.length} bytes, ${points.length} 实测点)`)
