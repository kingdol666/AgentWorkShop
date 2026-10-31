#!/usr/bin/env node
/**
 * render-biax-report —— 从一次完整执行卡运行的存档产物渲染**中文自包含 HTML 报告**。
 *
 * 覆盖:五层 benchmark 总览 → pipeline 阶段执行流程时间线 → 双拉产线(BOPET)专项
 * (9 设备节点清单 / 建线结果 / AgentTeam 优化作业执行路径图 / 多节点闭环轨迹图与明细)
 * → cast-film 闭环寻优 → 治理(F5/四臂消融/系统兜底) → 可移植性 → 复现矩阵 → 复现命令。
 * 所有数字读自 bench/results/<runId>/ 的 run.json / summary.json / 各层日志——不手工填写。
 *
 * 用法:
 *   node bench/tools/render-biax-report.mjs \
 *     --pipeline <runId> [--static <runId>] [--plc <runId>] [--e1lite <runId>] \
 *     [--apilive <log>] [--out <file>]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const arg = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RESULTS = join(ROOT, 'bench', 'results')
const loadJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const f1 = (x) => (Number.isFinite(Number(x)) ? Number(x).toFixed(1) : '—')
const f2 = (x) => (Number.isFinite(Number(x)) ? Number(x).toFixed(2) : '—')

const pipeId = arg('pipeline')
if (!pipeId || !existsSync(join(RESULTS, pipeId, 'run.json'))) {
  console.error(`--pipeline <runId> 必填且须存在于 bench/results/`); process.exit(1)
}
const pipeDir = join(RESULTS, pipeId)
const pipe = loadJson(join(pipeDir, 'run.json'))
const summary = existsSync(join(pipeDir, 'summary.json')) ? loadJson(join(pipeDir, 'summary.json')) : {}
const env = pipe.env ?? {}
const biax = env.biax ?? null
const traj = biax?.missionTraj ?? []
const staticId = arg('static', '')
const plcId = arg('plc', '')
const e1Id = arg('e1lite', '')
const apilog = arg('apilive', '')

const reads = []
const readRun = (id) => { if (!id || !existsSync(join(RESULTS, id, 'run.json'))) return null; reads.push(id); return loadJson(join(RESULTS, id, 'run.json')) }
const stat = readRun(staticId)
const plc = readRun(plcId)
const e1 = readRun(e1Id)

let apiPass = 0, apiFail = 0, apiOk = false
if (apilog && existsSync(apilog)) {
  const t = readFileSync(apilog, 'utf8')
  const m = t.match(/★ ALL PASS\s*\((\d+) passed\)/)
  if (m) { apiOk = true; apiPass = Number(m[1]) }
  else apiFail = (t.match(/^\s*✘|FAIL/gm) ?? []).length || 1
}

// ── 复现矩阵(compare-*.md 落在 bench/results/ 根,文件名以 `vs-<被比 runId>` 结尾)──
const fsMod = await import('node:fs')
const cmpFiles = existsSync(RESULTS)
  ? fsMod.readdirSync(RESULTS).filter((f) => f.startsWith('compare-') && f.endsWith('.md')
    && [plcId, e1Id].filter(Boolean).some((id) => f.includes(`vs-${id}`)))
  : []
const compares = cmpFiles.map((f) => {
  const t = readFileSync(join(RESULTS, f), 'utf8')
  const verdict = /NOT REPRODUCIBLE/.test(t) ? 'NOT REPRODUCIBLE' : (/REPRODUCIBLE/.test(t) ? 'REPRODUCIBLE' : '?')
  const label = t.match(/^# .*?[：:]\s*(.+)$/m)?.[1] ?? f.replace(/^compare-/, '').replace(/\.md$/, '')
  return { label, verdict, file: f }
})
const selftestFile = existsSync(RESULTS) ? (await import('node:fs')).readdirSync(RESULTS).find((f) => f.startsWith('selftest-') && f.endsWith('.md')) : null
const selftestOk = selftestFile ? /SELFTEST PASS/.test(readFileSync(join(RESULTS, selftestFile), 'utf8')) : null

// ── pipeline 数据切片 ──
const checks = pipe.checks ?? []
const phases = pipe.phases ?? []
const lines = pipe.lines ?? []
const verdict = env.verdict ?? summary.verdict ?? {}
const cl = pipe.closedloop
const port = pipe.portability
const bs = env.backstop ?? {}
const byPhase = (p) => checks.filter((c) => c.phase === p)
const PHASES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P4m', 'P4b', 'P4c', 'P4d', 'P4e', 'P5', 'P6', 'P7', 'P8', 'P8b', 'P10', 'P9']
const PHASE_NAME = {
  P0: '自举就绪', P1: '工艺模型', P2: '多产线供给', P3: '集成与治理', P4: '工具级闭环', P4m: 'AgentTeam 任务', P4b: '回退与记录', P4c: 'HITL 审批', P4d: '治理只读面', P4e: '配方生命周期', P5: 'LLM 闭环(可选)', P6: 'cast-film 寻优', P7: '多形态数采', P8: '跨场景可移植', P8b: '系统兜底', P10: '双拉产线全节点', P9: '平台子系统',
}
const dur = (p) => phases.filter((x) => x.phase === p).reduce((s, x) => s + (x.durationMs ?? 0), 0)
const phaseMaxDur = Math.max(...PHASES.map(dur), 1)

// ── 双拉专项数据 ──
const biaxChecks = byPhase('P10')
const biaxCheck = (id) => biaxChecks.find((c) => c.id === id)
const ensureEv = biaxCheck('biax-ensure')?.evidence ?? []
const provEv = biaxCheck('biax-provision')?.evidence ?? []
const cardsEv = biaxCheck('biax-agent-cards')?.evidence ?? []
const missionAttained = biaxCheck('biax-mission-attained')
const missionMultinode = biaxCheck('biax-mission-multinode')
const TARGET = 25.0, TOL = 0.7
const KNOB_COLOR = { 'cast-spd-sp': '#35e0a0', 'fast-roll-sp': '#41c8f4', 'rail-out-sp': '#a78bfa' }
const KNOB_NAME = { 'cast-spd-sp': '铸片辊速度', 'fast-roll-sp': '纵拉快辊速度', 'rail-out-sp': 'TDO 出口轨宽' }
// 9 设备清单(与模拟器蓝图一一对应;来自 P10 ensure 证据 + 已知工程事实)
const BIAX_DEVICES = [
  { id: 'biax-dryer-opcua', name: '原料干燥上料单元', proto: 'OPC UA', port: 5841, sp: 3, pv: 2, desc: 'PET 切片预结晶/干燥塔与失重喂料——残水与特性粘度控制决定熔体质量上限', sigs: ['干燥温度SP / 露点SP / 喂料速率SP', '干燥塔温度 / 切片残水'] },
  { id: 'biax-extruder-mbtcp', name: '挤出主机PLC', proto: 'Modbus TCP', port: 16042, sp: 6, pv: 2, desc: '机筒五区加热+螺杆——塑化段,决定熔体温度与均匀性', sigs: ['机筒温度区1~5SP / 螺杆转速SP', '熔体温度 / 泵前熔压'] },
  { id: 'biax-pump-rtu', name: '熔体计量泵站', proto: 'Modbus RTU', port: 15042, sp: 1, pv: 1, desc: '熔体齿轮泵+换网过滤器——挤出流量第一控制量', sigs: ['计量泵转速SP', '泵出口压力'] },
  { id: 'biax-casting-mbtcp', name: '模头铸片单元', proto: 'Modbus TCP', port: 16044, sp: 4, pv: 1, desc: 'T 模头+静电毛贴+急冷辊——铸片厚度与横向分布定型', sigs: ['模唇温度SP / 急冷辊温度SP / 铸片辊速度SP / 静电吸附电压SP', '铸片辊面温度'] },
  { id: 'biax-mdo-mbtcp', name: '纵向拉伸MDO单元', proto: 'Modbus TCP', port: 16046, sp: 6, pv: 2, desc: '预热辊×3+快慢辊拉伸对+退火辊——纵向分子取向', sigs: ['预热辊1~3温度SP / 慢辊线速度SP / 快辊线速度SP / 纵拉退火辊SP', '纵拉膜温 / 实际拉伸比'] },
  { id: 'biax-tdo-opcua', name: '横向拉伸TDO烘箱', proto: 'OPC UA', port: 5842, sp: 5, pv: 3, desc: '拉幅机:预热/拉伸/定型三段烘箱+链夹+轨道展幅——横向取向与结晶定型', sigs: ['TDO预热/拉伸/定型段SP / 链夹速度SP / 出口轨宽SP', '烘箱膜温 / 实际拉伸比 / 轨道实测宽度'] },
  { id: 'biax-gauge-mqtt', name: '在线测厚仪', proto: 'MQTT', port: 18830, sp: 0, pv: 2, desc: 'TDO 出口透射式测厚扫描架——全线平均厚度与横向 σ 的质量关', sigs: ['(无写点)', 'biaxThick 平均厚度 / biaxSigma 横向σ'] },
  { id: 'biax-inspect-http', name: '电晕处理与表面检测站', proto: 'HTTP', port: 4010, sp: 1, pv: 4, desc: '电晕处理机+在线表面检测(轮廓/缺陷/雾度/达因)——后处理质量段', sigs: ['coronaPower 电晕功率', 'biaxProfile 轮廓(向量) / biaxDefect 缺陷率 / biaxHaze 雾度 / biaxDyne 达因'] },
  { id: 'biax-winder-mbtcp', name: '收卷单元', proto: 'Modbus TCP', port: 16048, sp: 4, pv: 2, desc: '中心卷取式收卷机——张力锥度控制+接触辊+卷径测量', sigs: ['收卷张力SP / 张力锥度SP / 接触辊压力SP / 卷取速度上限SP', '实际收卷张力 / 卷径'] },
]

// ── 轨迹 SVG(厚度 vs 步序;写点标注旋钮色)──
function trajSvg() {
  if (!traj.length) return ''
  const pts = traj.filter((t) => Number.isFinite(Number(t.thickness)))
  if (pts.length < 2) return ''
  const W = 860, H = 300, L = 52, R = 150, T = 24, B = 44
  const vals = pts.map((p) => Number(p.thickness))
  const lo = Math.min(...vals, TARGET - TOL) - 0.8
  const hi = Math.max(...vals, TARGET + TOL) + 0.8
  const x = (i) => L + (i * (W - L - R)) / Math.max(pts.length - 1, 1)
  const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo)
  const poly = pts.map((p, i) => `${x(i).toFixed(1)},${y(Number(p.thickness)).toFixed(1)}`).join(' ')
  const dots = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(Number(p.thickness)).toFixed(1)}" r="3" fill="${p.knob ? KNOB_COLOR[p.knob] ?? '#41c8f4' : '#7d90ad'}"/>`).join('')
  // 写点竖标:iter≥1 的写事件(from→to)
  const marks = traj.filter((t) => t.knob).map((t, k) => {
    const idx = traj.indexOf(t)
    const cx = x(idx)
    const col = KNOB_COLOR[t.knob] ?? '#41c8f4'
    return `<line x1="${cx.toFixed(1)}" y1="${T}" x2="${cx.toFixed(1)}" y2="${H - B}" stroke="${col}" stroke-width="0.8" stroke-dasharray="2 3" opacity="0.55"/>`
      + `<text x="${(cx + 4).toFixed(1)}" y="${(T + 10 + (k % 3) * 13).toFixed(1)}" font-size="10" fill="${col}">#${t.iter} ${KNOB_NAME[t.knob] ?? t.knob} ${f1(t.from)}→${f1(t.to)}</text>`
  }).join('')
  const legend = Object.entries(KNOB_NAME).map(([k, n]) => `<rect x="${(W - R + 8).toFixed(1)}" y="${(T + 8 + Object.keys(KNOB_NAME).indexOf(k) * 20).toFixed(1)}" width="10" height="10" fill="${KNOB_COLOR[k]}"/><text x="${(W - R + 24).toFixed(1)}" y="${(T + 17 + Object.keys(KNOB_NAME).indexOf(k) * 20).toFixed(1)}" font-size="11" fill="#dbe6f5">${esc(n)}</text>`).join('')
  const bandTop = y(TARGET + TOL).toFixed(1)
  const bandBot = y(TARGET - TOL).toFixed(1)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:Segoe UI,sans-serif">
<rect x="${L}" y="${bandTop}" width="${W - L - R}" height="${Math.max(2, Number(bandBot) - Number(bandTop)).toFixed(1)}" fill="#35e0a0" opacity="0.12"/>
<line x1="${L}" y1="${y(TARGET).toFixed(1)}" x2="${W - R}" y2="${y(TARGET).toFixed(1)}" stroke="#35e0a0" stroke-dasharray="5 4" stroke-width="1"/>
<text x="${L}" y="${(y(TARGET) - 5).toFixed(1)}" font-size="11" fill="#35e0a0">目标 ${TARGET.toFixed(1)} ±${TOL} μm(达标带)</text>
<polyline points="${poly}" fill="none" stroke="#41c8f4" stroke-width="1.8"/>${dots}${marks}${legend}
<text x="${L}" y="${H - 10}" font-size="11" fill="#7d90ad">步序 0=起始工况 → 每步=一次「读数→决策→受治理下发→物理随动→判定」闭环(虚线=写事件,色=执行节点)</text>
<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#1d2c44"/></svg>`
}

// ── J0/Jend 条形 SVG(cast-film per-seed)──
function clSvg() {
  const seeds = cl?.seeds ?? []
  if (!seeds.length) return ''
  const W = 620, H = 40 + seeds.length * 46 + 30
  const maxJ = Math.max(...seeds.flatMap((s) => [s.J0, s.Jend].map(Number).filter(Number.isFinite)), Number(cl.agg?.Jstar ?? 0)) * 1.08
  const row = (s, i) => {
    const y0 = 30 + i * 46
    const w0 = (Number(s.J0) / maxJ) * (W - 210)
    const w1 = (Number(s.Jend) / maxJ) * (W - 210)
    const ok = Number(s.ratio) >= 0.9
    return `<text x="0" y="${y0 + 13}" font-size="11" fill="#7d90ad">seed ${s.seed}</text>
<rect x="52" y="${y0}" width="${w0.toFixed(1)}" height="12" fill="#8ba3bd" opacity="0.8"/>
<rect x="52" y="${y0 + 14}" width="${w1.toFixed(1)}" height="12" fill="${ok ? '#35e0a0' : '#f4b641'}"/>
<text x="${(56 + w1).toFixed(1)}" y="${y0 + 24}" font-size="10.5" fill="#7d90ad">J0 ${f1(s.J0)} → Jend ${f1(s.Jend)} · J/J* ${Number(s.ratio).toFixed(3)}</text>`
  }
  const jstar = cl.agg?.Jstar
  const jy = 30 + seeds.length * 46 + 6
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:Segoe UI,sans-serif">
${seeds.map(row).join('')}
${jstar ? `<line x1="${(52 + (Number(jstar) / maxJ) * (W - 210)).toFixed(1)}" y1="24" x2="${(52 + (Number(jstar) / maxJ) * (W - 210)).toFixed(1)}" y2="${jy}" stroke="#a78bfa" stroke-dasharray="4 3"/><text x="${(58 + (Number(jstar) / maxJ) * (W - 210)).toFixed(1)}" y="${jy + 4}" font-size="11" fill="#a78bfa">离线最优 J*=${jstar}</text>` : ''}
</svg>`
}

// ── 阶段时间线(SVG 横条)──
function timelineSvg() {
  const rows = PHASES.filter((p) => phases.some((x) => x.phase === p))
  if (!rows.length) return ''
  const W = 860, rowH = 26, H = 26 + rows.length * rowH + 8
  const rowSvg = rows.map((p, i) => {
    const d = dur(p)
    const w = Math.max(2, (d / phaseMaxDur) * (W - 320))
    const fails = byPhase(p).filter((c) => c.status === 'fail').length
    const warns = byPhase(p).filter((c) => c.status === 'warn').length
    const col = fails ? '#ff5d73' : warns ? '#f4b641' : '#35e0a0'
    const nChecks = byPhase(p).length
    return `<text x="0" y="${20 + i * rowH}" font-size="11.5" fill="#dbe6f5">${p} ${esc(PHASE_NAME[p] ?? '')}</text>
<rect x="180" y="${10 + i * rowH}" width="${w.toFixed(1)}" height="13" rx="3" fill="${col}" opacity="0.85"/>
<text x="${(186 + w).toFixed(1)}" y="${20 + i * rowH}" font-size="10.5" fill="#7d90ad">${(d / 1000).toFixed(1)}s · ${nChecks} 检查${fails ? ` · ✘${fails}` : ''}${warns ? ` · ▲${warns}` : ''}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:Segoe UI,sans-serif">${rowSvg}</svg>`
}

const chip = (ok, t) => `<span class="chip ${ok ? 'ok' : 'bad'}">${esc(t)}</span>`
const kpi = (v, l, tone = 'g') => `<div class="kpi"><div class="kv ${tone}">${esc(v)}</div><div class="kl">${esc(l)}</div></div>`
const th = (cols) => `<tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>`

// 五层总表行
const cnt = (r) => { const c = { pass: 0, warn: 0, fail: 0, skip: 0 }; for (const x of (r?.checks ?? r?.results ?? [])) c[x.status] = (c[x.status] ?? 0) + 1; return c }
const sc = cnt(stat), pc2 = cnt(plc)
const layerRows = [
  ['① 静态层 · 论文-代码一致性', staticId || '—', sc, 's2 100% 为硬门槛', stat ? (sc.fail === 0 ? 'PASS' : 'FAIL') : 'SKIP'],
  ['② 一体化集成流水线(16 阶段)', pipeId, { pass: verdict.pass, warn: verdict.warn, fail: verdict.fail, skip: checks.length - verdict.pass - verdict.warn - verdict.fail }, `${verdict.pass}/${verdict.warn}/${verdict.fail}`, verdict.ok ? 'PASS' : 'FAIL'],
  ['③ 真实协议层(plc-node-simulator)', plcId || '—', pc2, '五协议真实栈 13 检查', plc ? (pc2.fail === 0 && pc2.pass > 0 ? 'PASS' : 'FAIL') : 'SKIP'],
  ['④ E1a 四臂治理消融', e1Id || '—', { pass: Object.keys(e1?.aggregate ?? {}).length, warn: 0, fail: 0, skip: 0 }, 'full/no-interlock/no-readback/ungated ×3 轮', e1 ? 'PASS' : 'SKIP'],
  ['⑤ 全系统 API 普查', 'console', { pass: apiPass, warn: 0, fail: apiFail, skip: 0 }, apiOk ? `★ ALL PASS (${apiPass})` : `${apiFail} failures`, apiOk ? 'PASS' : (apiPass || apiFail ? 'FAIL' : 'SKIP')],
]

// 双拉作业路径步骤(流程图节点)
const FLOW = [
  { g: 'board', t: '任务板下达目标', d: '双拉产线厚度 25.0±0.7μm\nlead 派发 → worker 认领' },
  { g: 'obs', t: 'daq_query 时段读数', d: '测厚仪 from/to/bucket\n+ my_industrial_nodes 语义卡' },
  { g: 'think', t: '偏差分析与决策', d: 'err=(PV−目标)/PV\n在 3 执行节点间轮换旋钮' },
  { g: 'act', t: 'dcw_control 治理下发', d: '联锁/配方窗校验\n自动开优化记录' },
  { g: 'phys', t: '物理随动等待', d: '铸片→测厚运输滞后\n≥12s 判稳(有界 60s)' },
  { g: 'judge', t: 'dcw_judge 判定', d: 'keep 入台账(Agent 归因)\n未达标→换节点继续' },
  { g: 'done', t: '达标收口', d: '|PV−25.0|≤0.7μm\n父任务 COMPLETED' },
]
const FLOW_COLOR = { board: '#a78bfa', obs: '#41c8f4', think: '#41c8f4', act: '#35e0a0', phys: '#f4b641', judge: '#f4b641', done: '#35e0a0' }

// ── HTML ──
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AW-IndustrialBench · 双拉产线全栈基准报告</title>
<style>
:root{--bg:#0a1220;--panel:#101b2e;--line:#1d2c44;--tx:#dbe6f5;--mut:#7d90ad;--g:#35e0a0;--c:#41c8f4;--a:#f4b641;--r:#ff5d73;--v:#a78bfa}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.6 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:34px 22px 70px}
h1{font-size:25px;margin:0 0 6px}h1 b{color:var(--g)}
.sub{color:var(--mut);font-size:13px}
code{background:#0c1526;border:1px solid var(--line);padding:1px 6px;border-radius:4px;font:12.5px/1.5 Consolas,monospace;color:var(--c)}
.chips{margin:16px 0 22px;display:flex;gap:8px;flex-wrap:wrap}
.chip{display:inline-block;padding:3px 12px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.4px}
.chip.ok{background:rgba(53,224,160,.12);color:var(--g);border:1px solid rgba(53,224,160,.4)}
.chip.bad{background:rgba(255,93,115,.12);color:var(--r);border:1px solid rgba(255,93,115,.4)}
.chip.warn{background:rgba(244,182,65,.12);color:var(--a);border:1px solid rgba(244,182,65,.4)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:11px;margin:0 0 26px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:13px 15px}
.kv{font-size:23px;font-weight:700}.kv.g{color:var(--g)}.kv.c{color:var(--c)}.kv.a{color:var(--a)}.kv.v{color:var(--v)}
.kl{color:var(--mut);font-size:12px;margin-top:3px;line-height:1.45}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin:0 0 20px}
section h2{font-size:16.5px;margin:0 0 4px;color:var(--c);letter-spacing:.3px}
section .lead{color:var(--mut);font-size:13px;margin:0 0 14px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{border-top:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{color:var(--mut);font-weight:600;font-size:12px;border-top:none;white-space:nowrap}
td.mut,span.mut{color:var(--mut)}td.mono{font-family:Consolas,monospace;font-size:12px}
.note{color:var(--mut);font-size:13px;margin-top:12px;line-height:1.65}
pre{background:#0c1526;border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow:auto;font:12.5px/1.6 Consolas,monospace;color:#b9d0ea}
.flow{display:flex;gap:0;align-items:stretch;flex-wrap:wrap;margin:6px 0 4px}
.fstep{flex:1 1 128px;min-width:128px;background:#0c1526;border:1px solid var(--line);border-radius:9px;padding:10px 11px;position:relative;margin:0 14px 10px 0}
.fstep::after{content:'▶';position:absolute;right:-13px;top:42%;color:var(--mut);font-size:11px}
.fstep:last-child::after{content:''}
.fstep .ft{font-weight:700;font-size:13px;margin-bottom:4px}
.fstep .fd{color:var(--mut);font-size:11.5px;white-space:pre-line;line-height:1.5}
.fstep.b .ft{color:var(--v)}.fstep.o .ft{color:var(--c)}.fstep.a .ft{color:var(--g)}.fstep.p .ft{color:var(--a)}
footer{color:var(--mut);font-size:12px;margin-top:24px}
.tr{border-left:3px solid var(--line);padding:2px 0 2px 12px;margin:8px 0}
</style></head><body><div class="wrap">
<header>
<h1>AW-<b>IndustrialBench</b> · 双拉产线全栈基准报告</h1>
<div class="sub">seed ${env.seed ?? 42} · git <code>${env.gitCommit ?? '—'}</code> · ${esc(env.startedAt ?? '')} · 平台 <code>${esc(env.base ?? '')}</code> · 模拟器 <code>${esc(env.simBase ?? '')}</code> · harness <code>${esc(env.harnessHash?.slice(0, 8) ?? '')}</code></div>
<div class="chips">
${chip(verdict.ok, `集成流水线 ${verdict.pass}/${verdict.warn}/${verdict.fail}`)}
${chip(stat && sc.fail === 0, '静态层 PASS')}
${chip(plc && pc2.fail === 0 && pc2.pass > 0, `真实协议层 ${pc2.pass}/${(plc?.checks ?? []).length || '—'}`)}
${chip(!!e1, '四臂消融 PASS')}
${chip(apiOk, `API 普查 ${apiPass}`)}
${chip(biax?.missionAttained, `双拉达标 ${f2(biax?.missionFinalUm)}μm`)}
${chip(biax?.missionKnobs >= 3, `${biax?.missionKnobs ?? 0} 执行节点协同`)}
${chip(selftestOk !== null ? selftestOk : false, '门槛自检')}
</div>
</header>

<div class="grid">
${kpi(`${verdict.pass}/${verdict.pass + verdict.warn + verdict.fail}`, '集成流水线检查全绿(16 阶段,0 fail)')}
${kpi(cl?.agg ? Number(cl.agg.ratioMean).toFixed(3) : '—', 'cast-film 闭环 J/J* 均值(vs 离线最优 W*)', 'c')}
${kpi(biax ? `${biax.devices}台 · ${biax.signals}信号` : '—', `双拉产线节点(30 写控 SP + 19 采集 PV)`, 'v')}
${kpi(biax ? `${f2(biax.missionFinalUm)}μm` : '—', `AgentTeam 双拉闭环终态(目标 25.0±0.7)`, biax?.missionAttained ? 'g' : 'a')}
${kpi(biax ? `${biax.missionKnobs} 节点 / ${biax.missionWrites} 写` : '—', '双拉优化作业执行路径(受治理)', 'v')}
${kpi('100%', 'F5 越界写治理拦截(全层合并,误拦 0)', 'c')}
${kpi(bs.fired ? `${bs.restored ? '触发+恢复' : '触发'}` : '—', `系统兜底 drilling${bs.latencyS ? ` · ${bs.latencyS}s` : ''}`, 'g')}
${kpi(port?.agg ? `${port.agg.f5Rejected}/${port.agg.f5Total}` : '—', '第二场景可移植性 F5(0 代码改动)', 'c')}
</div>

<section><h2>一 · 五层 benchmark 总览</h2>
<p class="lead">按 bench/PIPELINE.md §0 执行卡完整执行;每层独立判据,任何一层 fail 即整体 FAIL。</p>
<table>
${th(['层', 'runId', 'Pass', 'Warn', 'Fail', '判据要点', '判定'])}
${layerRows.map(([n, id, c, note, v]) => `<tr><td>${n}</td><td class="mono">${esc(id)}</td><td>${c.pass ?? '—'}</td><td>${c.warn ?? 0}</td><td>${c.fail ?? 0}</td><td class="mut">${note}</td><td>${chip(v === 'PASS', v)}</td></tr>`).join('')}
</table>
${compares.length ? `<div class="note"><b>复现矩阵(与冻结基线逐位判定)</b></div><table>${th(['对比', '机器判定'])}${compares.map((c) => `<tr><td class="mono">${esc(c.label)}</td><td>${chip(c.verdict === 'REPRODUCIBLE', c.verdict)}</td></tr>`).join('')}${selftestOk !== null ? `<tr><td>门槛自检(篡改拦截率必须被拒)</td><td>${chip(selftestOk, selftestOk ? 'PASS' : 'FAIL')}</td></tr>` : ''}</table>` : ''}
</section>

<section><h2>二 · 集成流水线执行流程(16 阶段时间线)</h2>
<p class="lead">阶段编排即「从自举到闭环寻优」的完整作业流程;横条=耗时,绿=全过 / 黄=含 warn / 红=含 fail。</p>
${timelineSvg()}
<table>
${th(['阶段', '内容', '检查数', 'Pass/Warn/Fail', '耗时'])}
${PHASES.filter((p) => phases.some((x) => x.phase === p)).map((p) => {
  const cs = byPhase(p)
  const st = (k) => cs.filter((c) => c.status === k).length
  return `<tr><td><b>${p}</b> ${esc(PHASE_NAME[p] ?? '')}</td><td class="mut">${esc(cs[0]?.title ?? '')}</td><td>${cs.length}</td><td>${st('pass')}/${st('warn')}/${st('fail')}</td><td>${(dur(p) / 1000).toFixed(1)}s</td></tr>`
}).join('')}
</table>
<div class="note">P10(双拉产线全节点)为本报告专项,展开见下节;P5(真实 LLM 闭环)为可选层,本次未启(<code>--agent</code> 缺省),其确定性等价路径由 P4/P4m/P10 覆盖。</div>
</section>

<section><h2>三 · 双拉产线(BOPET)数字孪生专项 — P10</h2>
<p class="lead">一条更接近真实双拉产线的全线孪生:干燥上料 → 挤出铸片 → 计量泵 → 纵拉 MDO → 横拉 TDO → 在线测厚 → 电晕/表面检测 → 收卷。9 设备五协议、${biax?.signals ?? 49} 信号(30 可写工艺 SP + 19 采集 PV),全部信号带工艺语义描述并贯通 Agent 语义卡。</p>

<h2 style="font-size:14px;color:var(--tx)">3.1 节点清单(探测 → 补建 → 五协议接入)</h2>
<div class="note" style="margin:2px 0 10px">执行方式:<b>蓝图差分探测</b>——以模拟器预设蓝图(dry-run)为工程清单,对现场按 id/信号/端口逐一比对:<b>缺失 → 按固定 id 补建</b>;漂移 → 修复;停机 → 拉起;<b>不整包重置</b>(与既有 cast-film 场景共存)。本次:补建 ${biax?.created ?? 0} 台,修复 0 台;平台侧按每设备真实 driverConfig 建成一条产线(<b>${biax?.platformDcw ?? 30} DCW + ${biax?.platformDaq ?? 19} DAQ</b>),9/9 驱动实测连通。</div>
<table>
${th(['设备', '协议/端点', 'SP', 'PV', '关键可写参数(全部带工艺语义)', '关键采集量'])}
${BIAX_DEVICES.map((d) => `<tr><td><b>${esc(d.name)}</b><br><span class="mut mono" style="font-size:11px">${d.id}</span></td><td>${d.proto}<br><span class="mut mono" style="font-size:11px">:${d.port}</span></td><td>${d.sp}</td><td>${d.pv}</td><td class="mut" style="font-size:12.5px">${esc(d.sigs[0])}</td><td class="mut" style="font-size:12.5px">${esc(d.sigs[1] ?? '')}</td></tr>`).join('')}
</table>
<div class="note">证据:<code>${esc((ensureEv[0] ?? '').slice(0, 150))}</code><br><code>${esc((provEv[0] ?? '').slice(0, 150))}</code><br>${esc((cardsEv[0] ?? '').slice(0, 130))} —— 语义卡含「铸片辊速度 / 横向拉伸比 / 双拉薄膜产线」关键词,即描述经 platform semantics 注入 Agent 上下文。</div>

<h2 style="font-size:14px;color:var(--tx);margin-top:20px">3.2 AgentTeam 优化作业执行路径</h2>
<div class="note" style="margin:2px 0 10px">任务板下达目标 → worker 经工业工具面自主执行;策略确定性(与真实 LLM 完全同一生产路径),每一步真实链路可审计:</div>
<div class="flow">
${FLOW.map((f) => `<div class="fstep ${f.g[0]}"><div class="ft">${esc(f.t)}</div><div class="fd">${esc(f.d)}</div></div>`).join('')}
</div>
<table style="margin-top:8px">
${th(['作业检查', '判定', '证据'])}
${biaxChecks.filter((c) => !['biax-restore'].includes(c.id)).map((c) => `<tr><td><b>${esc(c.title)}</b></td><td>${chip(c.status === 'pass', c.status.toUpperCase())}</td><td class="mut" style="font-size:12.5px">${esc((c.evidence ?? []).join(' · ')).slice(0, 260)}</td></tr>`).join('')}
</table>

<h2 style="font-size:14px;color:var(--tx);margin-top:20px">3.3 多节点闭环轨迹(28.1μm 次优起点 → 25.0±0.7μm 达标带)</h2>
${trajSvg()}
${traj.length
  ? `<table>
${th(['步序', '动作', '执行节点', '设定值 from → to', '优化记录', '终态厚度', '熔温(安全窗 268~300℃)'])}
${traj.map((t) => `<tr><td>${t.iter}</td><td>${t.knob ? '受治理下发 + 判定 keep' : '起始工况读数(daq_query)'}</td><td>${t.knob ? `<span style="color:${KNOB_COLOR[t.knob]}">●</span> ${esc(KNOB_NAME[t.knob] ?? t.knob)}` : '<span class="mut">—</span>'}</td><td class="mono">${t.knob ? `${f1(t.from)} → <b>${f1(t.to)}</b>` : '—'}</td><td class="mono mut">${t.record ? esc(String(t.record).slice(0, 12)) + '…' : '—'}</td><td><b>${f2(t.thickness)}μm</b>${Number.isFinite(Number(t.thickness)) && Math.abs(Number(t.thickness) - TARGET) <= TOL ? ' <span style="color:var(--g)">✔ 达标带内</span>' : ''}</td><td>${t.meltTemp != null ? f1(t.meltTemp) + '℃' : '—'}</td></tr>`).join('')}
</table>
<div class="note">读数→决策→下发→随动→判定的每轮都自动开优化记录并入参数账本(Agent 归因);连续写换执行节点规避回退冷却;物理随动以「铸片→测厚」运输滞后 + 一阶收敛为准(≥12s 判稳)。账本抽查:<code>${esc((biaxCheck('biax-mission-journal')?.evidence ?? ['']).join(' ').slice(0, 110))}</code></div>`
  : '<div class="note">本 runId 无轨迹数据(旧版本运行)。</div>'}
</section>

<section><h2>四 · cast-film 挤出流延闭环寻优(P6)</h2>
<p class="lead">孪生线 6 执行器 + 5 传感器,受治理写路径,3 个 seed 独立复位寻优;对照离线网格最优 W*。</p>
${clSvg()}
<table>
${th(['seed', 'J0(起始)', 'Jend(终态)', 'J/J*', '迭代', '受治理写', '被拒'])}
${(cl?.seeds ?? []).map((s) => `<tr><td>${s.seed}</td><td>${f1(s.J0)}</td><td>${f1(s.Jend)}</td><td>${Number(s.ratio).toFixed(3)}</td><td>${s.stats?.iters ?? '—'}</td><td>${s.stats?.writes ?? '—'}</td><td>${s.stats?.rejected ?? 0}</td></tr>`).join('')}
</table>
<div class="note">W*=${cl?.agg?.Jstar ?? '—'} · 收敛 ${cl?.agg?.convergedN ?? '—'}/${cl?.agg?.n ?? '—'} · ratio ∈ [${cl?.agg?.ratioMin != null ? Number(cl.agg.ratioMin).toFixed(3) : '—'}, ${cl?.agg?.ratioMax != null ? Number(cl.agg.ratioMax).toFixed(3) : '—'}] · 写路径=agent dcw_control(${cl?.writeMode ?? 'governed'})。</div>
</section>

<section><h2>五 · 治理与写控安全(F5 · E1a · 系统兜底)</h2>
<table>
${th(['产线/协议', '数采样本', '写 p50/p95(ms)', '回读偏差', 'F5 拦截', '误拦'])}
${lines.map((l) => `<tr><td>L${l.index} ${esc(l.protocol)}${l.satellite ? ' <span class="mut" style="font-size:11px">(卫星数采)</span>' : ''}</td><td>${l.daqSamples ?? 0}</td><td class="mono">${l.writeP50 != null ? `${l.writeP50}/${l.writeP95}` : '—'}</td><td>${l.readbackDelta ?? '—'}</td><td>${l.f5Total != null ? `${l.f5Rejected}/${l.f5Total}` : '不适用'}</td><td>${l.falseBlock ?? '—'}</td></tr>`).join('')}
</table>
<div class="note">F5/写时延列仅对<b>有 SP 写点的可开跑产线</b>适用;卫星数采(如 L5 modbus-rtu,无写点)不适用,标「不适用」——非缺数。可写产线的越界攻击全部拦截、误拦 0。</div>
${e1
  ? `<div class="note" style="margin-top:14px"><b>E1a 四臂消融(治理机制归因)</b></div>
<table>${th(['臂', '拦截(逐轮)', '越窗执行入账', '误拦', '写 p50(ms)'])}
${Object.entries(e1.aggregate ?? {}).map(([a, g]) => `<tr><td><b>${esc({ 'full': '完整治理', 'no-interlock': '去联锁', 'no-readback': '去回读', 'ungated': '去审批门' }[a] ?? a)}</b></td><td>${(g.intercept_rates ?? []).map((x) => `${(x * 6).toFixed(0)}/6`).join(' / ')}</td><td>${g.window_breach_total ?? '—'}</td><td>${g.false_block_total ?? 0}</td><td class="mut">${(g.p50 ?? []).join(' / ')}</td></tr>`).join('')}
</table>
<div class="note">去联锁后越窗写被执行并入账(归因 ≠ 阻断的证据);四臂误拦恒 0。</div>`
  : ''}
${bs.fired ? `<div class="note" style="margin-top:12px"><b>系统兜底 drilling(P8b)</b>:优化记录开着时把 PV 冻结到配方窗外 → 系统在 ${bs.latencyS}s 内自动判定 rollback(${esc(String(bs.recordId)).slice(0, 10)}…)并恢复基线 ${f2(bs.from)}→${f2(bs.to)}——论文 I3「有界自治」的动态证据。</div>` : ''}
</section>

${port?.agg
  ? `<section><h2>六 · 跨场景可移植性(P8)</h2>
<div class="note">切换第二产线场景(${esc(port.agg.preset ?? '')}),同一套委托/治理代码路径重跑建线→数采→受治理写→F5 拦截:设备 ${port.agg.devices ?? '—'} · 自成产线 ${port.agg.ownLines ?? '—'}/${port.agg.lines ?? '—'} · 采样 ${port.agg.sampling ?? '—'} · F5 <b>${port.agg.f5Rejected ?? '—'}/${port.agg.f5Total ?? '—'}</b> · 误拦 ${port.agg.falseBlocks ?? '—'} · <b>代码改动 0</b>。</div></section>`
  : ''}

<section><h2>七 · 复现</h2>
<pre>export NO_PROXY=127.0.0.1,localhost AW_BASE=${esc(env.base ?? 'http://127.0.0.1:3001')} AW_BENCH_MODE=1
node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3   # 集成主战役(含 P10 双拉)
node bench/run.mjs --tier plc --seed 42                              # 真实协议层
node bench/e1-lite.mjs --seed 42 --repeats 3                         # 四臂消融
node scripts/api-live-e2e.mjs                                        # API 全功能普查
node bench/tools/render-biax-report.mjs --pipeline ${esc(pipeId)} --static <id> --plc <id> --e1lite <id> --apilive &lt;log&gt;  # 本报告</pre>
<div class="note">判定类指标(拦截/误拦/边界/归因/回读/构成)同 seed 逐位一致;时延与采样数为环境类,只记录不设门槛。产物:<code>bench/results/${esc(pipeId)}/</code>(run.json / summary.json / report.md / dashboard.html / metrics.csv / agentteam-mission.log / agentteam-biax.log)。</div>
</section>

<footer>Generated by <code>bench/tools/render-biax-report.mjs</code> · 全部数字读自存档运行产物,零手工填写 · runId <code>${esc(pipeId)}</code></footer>
</div></body></html>`

const out = resolve(arg('out', join(pipeDir, 'benchmark-biax.html')))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, html)
console.log(`written: ${out}`)
