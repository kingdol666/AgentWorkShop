#!/usr/bin/env node
/**
 * bench/optloop.mjs —— 质量目标驱动的多产线并行闭环寻优管线(2026-09-22 新增阶段)。
 *
 * 与 bench/scenarios.mjs(确定性脚本策略,不经 LLM)的本质区别:
 *   任务书只给「质量目标带 + 守卫约束 + 定性工艺机理交底」,不含任何设定值;
 *   每一拍的下一发参数由 omp 工艺工程师根据 daq_query 实测反馈 + 当前设定 + 工艺机理
 *   自主归因与量化决策,受治理下发(dcw_control,配方窗联锁),复测验证后迭代,达标收口。
 *
 * 每线一路 Channel(omp lead=督办/验收,omp worker=工艺工程师)+ 一路录制器:
 *   timeline.jsonl(对话全录) / worker-stream.jsonl(worker 终端全帧)
 *   setpoints.jsonl(全部写控设定值曲线) / quality.jsonl(全部数采实测曲线)
 *
 * 用法(与集成流水线同一隔离环境块):
 *   node bench/optloop.mjs --scenarios injection,wwtp,anneal --budget 60
 * 退出码:0 = 全部完成且守卫满足;1 = 存在失败/超时。
 */
import { join, dirname, resolve } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeApi, sleep, runId as mkRunId, ensureDir } from './lib/util.mjs'
import { ensureSimulator, simUp, SIM_BASE } from './lib/sim.mjs'
import { ensurePlatform } from './lib/platform.mjs'
import { SCENARIOS, SCENARIO_IDS, ensureScenarioLine, provisionScenarioLine } from './lib/scenarios.mjs'
import { createOptRecorder } from './lib/optloop-recorder.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const has = (k) => args.includes(`--${k}`)

const base = arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:3001')
const budgetMin = Number(arg('budget', 60))
const tag = arg('tag', `ol${Date.now().toString(36).slice(-4)}`)
const scenarios = (arg('scenarios', '') || process.env.AW_SCENARIOS || 'injection,wwtp,anneal').split(',').map(s => s.trim()).filter(Boolean)
const list = scenarios.filter(id => SCENARIO_IDS.includes(id))
if (!list.length) { console.error('✘ 无有效场景'); process.exit(1) }

const rid = `${mkRunId()}-optloop`
const outDir = ensureDir(join(REPO, 'bench', 'results', rid))
const api = makeApi(base)

// ── 每场景:定性工艺机理交底(源自 plc-node-simulator 引擎模型头注,全部为定性方向,无量化设定) ──
const MECHANISM = {
  injection: '制品克重 W = f(保压压力+, 保压时间+, 熔温−):保压把熔体补缩进模腔;缩痕与克重同源(补缩不足/表面过早冻结);飞边=保压过头。升高保压或保压时间→克重增;熔温升→克重略降且飞边风险增。',
  wwtp: '溶解氧 DO 与风机频率^1.8 正相关、与进水负荷平衡——风机低了 DO 塌、硝化停(氨氮崩),风机高了电耗平方级上涨;NaOH 投药↑→pH↑;PAC↑→总磷↓(药耗↑);回流/排泥影响泥浓与浊度。',
  anneal: '炉温(区温)↑→再结晶充分→硬度↓;线速↑→受热时间短→硬度↑且产能↑;抗拉强度与硬度正相关;过温→表面缺陷↑。',
}
const STEP_LIMITS = {
  injection: '保压压力单步≤8bar、保压时间单步≤2s、熔温单步≤10℃',
  wwtp: '风机频率单步≤2Hz、NaOH 单步≤2、PAC 单步≤5、回流/排泥单步≤10%',
  anneal: '区温单步≤10℃、线速单步≤5m/min',
}

function missionBrief(scen) {
  const s = SCENARIOS[scen]
  const guards = s.guards.map(g => `${g.label}${g.max != null ? `≤${g.max}` : `∈[${g.min},${g.max}]`} ${g.unit ?? ''}`).join('、')
  return [
    `【工况交底】${s.story}`,
    ``,
    `【质量目标】${s.pv.label} ${s.pv.target}±${s.pv.tol} ${s.pv.unit},且连续两轮复测在带内。`,
    s.guards.length ? `【守卫约束】${guards}。` : ``,
    s.id === 'wwtp' ? `【优化目标】达标后,在守住全部硬约束的前提下逐级「降风机频、退药」降低运行成本。` : s.id === 'anneal' ? `【优化目标】质量窗守住后,在线速产能上逐级推进,触窗即回退。` : ``,
    ``,
    `【工艺机理(交底,定性)】${MECHANISM[scen]}`,
    ``,
    `【作业纪律】每轮:①daq_query 取本线全部实测(PV/守卫量),并读当前各设定值,做偏差归因;②决策写明机理依据与量化调整(单步限幅:${STEP_LIMITS[scen]});③写入后等物理响应(≥${Math.round(s.settleMs / 1000)}s)再复测;④达标且稳定(连续两轮在带内)后 dcw_judge 收口;⑤每轮向优化总工报告:测量值/各设定现值/决策依据/新设定。数采节点的量程告警状态可忽略(模板量程与工艺不匹配),一切以实测数值为准。最终以 complete_task 收口本子任务。

【收口铁则】PV 未进入目标带(且守卫全部满足)之前,严禁调用 complete_task;若多轮迭代仍未达标,继续按机理修正方向迭代(可加大步幅到限幅上限),直到连续两轮在带内才算完成。前序寻优轮次若未达标,本轮须接力完成。`,
  ].filter(Boolean).join('\n')
}

// ── 环境 ──
console.log(`\n=== AW-IndustrialBench · quality-objective multi-line closed-loop optimization ${rid} ===`)
console.log(`scenarios=${list.join(',')}  budget=${budgetMin}min  base=${base}  sim=${SIM_BASE}\n`)
if (!(await simUp())) {
  const r = await ensureSimulator({ log: console.log })
  if (!r.started && !(await simUp())) { console.error(`✘ 模拟器自举失败`); process.exit(1) }
}
const pr = await ensurePlatform({ base, log: console.log })
if (!pr.started && pr.reason && pr.reason !== 'already-up') { console.error(`✘ 平台自举失败`); process.exit(1) }
let login
try { login = await api.login(process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', process.env.AW_ADMIN_PASS ?? 'admin123') }
catch (e) { console.error(`✘ 平台鉴权失败:`, e?.message ?? e); process.exit(1) }
if (!login.ok) { console.error('✘ 平台鉴权失败'); process.exit(1) }
console.log('✔ 平台就绪并鉴权\n')

// ── OL-1/2:预设共存装载 + 幂等建线(并行) ──
const sfx = tag
const provisioned = await Promise.all(list.map(async (scen) => {
  console.log(`· [${scen}] 模拟器场景装载…`)
  await ensureScenarioLine(SCENARIOS[scen])
  const rec = await provisionScenarioLine(api, SCENARIOS[scen], { sfx: `${tag}-${scen}` })
  console.log(`  ✔ [${scen}] 建线 ${rec.lineName}(${rec.reused ? '复用' : '新建'}) dcw=${Object.keys(rec.dcw).length} daq=${Object.keys(rec.daq).length}`)
  return { scen, rec }
}))

// ── OL-2:每线一个 Channel(omp lead+worker)+ 全节点绑定 + 质量目标任务书 ──
const runs = []
for (const { scen, rec } of provisioned) {
  const s = SCENARIOS[scen]
  const ch = (await api.call('POST', '/api/workshop/channels', { name: `闭环寻优-${scen}-${tag}`, scenarioPrompt: `本频道执行 ${s.zh} 闭环寻优:一切决策基于 daq_query 实测数字与工艺机理,写入走 dcw_control(配方窗内),每轮留痕。` })).data
  const CH = ch?.channelId ?? ch?.id
  if (!CH) throw new Error(`[${scen}] 频道创建失败: ${JSON.stringify(ch).slice(0, 200)}`)
  const leadR = (await api.call('POST', '/api/workshop/agents', { name: `优化总工-${tag}-${scen}`, harness: 'omp', config: { intro: '督办与验收', systemPromptPrefix: '你是优化总工。把寻优任务拆解派给工艺工程师;督办进度(长等待属正常工艺响应,勿频繁催促);收口前核对其数据链(测量→决策→写入→复测→判定)。中文简短。' } })).data
  const workerR = (await api.call('POST', '/api/workshop/agents', { name: `工艺工程师-${tag}-${scen}`, harness: 'omp', config: { intro: '闭环寻优执行者', systemPromptPrefix: '你是工艺工程师。严格按任务书作业纪律执行闭环:读数归因→机理决策→受治理写入→等物理响应→复测→判定。禁止臆造数字;长等待是工艺要求,耐心完成。中文。' } })).data
  const team = (await api.call('POST', '/api/workshop/teams', { name: `寻优剧组-${tag}-${scen}` })).data
  const teamId = team?.id ?? team?.team?.id
  await api.call('POST', `/api/workshop/teams/${teamId}/members`, { agentId: leadR.id, role: 'lead' })
  await api.call('POST', `/api/workshop/teams/${teamId}/members`, { agentId: workerR.id, role: 'worker' })
  await api.call('POST', `/api/workshop/teams/${teamId}/deploy`, { channelId: CH })
  const inst = (await api.call('GET', `/api/workshop/channels/${CH}/agents`)).data ?? []
  const WI = inst.find(a => a.role === 'worker')
  for (const nodeId of Object.values(rec.dcw)) await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: WI.id, nodeId, kind: 'dcw', mode: 'auto' })
  for (const nodeId of Object.values(rec.daq)) await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: WI.id, nodeId, kind: 'daq', mode: 'auto' })
  const goal = await api.call('POST', `/api/workshop/channels/${CH}/tasks`, { title: `${s.zh}:回到 ${s.pv.target}±${s.pv.tol} ${s.pv.unit}`, parts: [{ text: missionBrief(scen) }], mode: 'goal', modeConfig: { goalCriteria: `${s.pv.label}连续两轮复测在 ${s.pv.target - s.pv.tol}~${s.pv.target + s.pv.tol} ${s.pv.unit} 内,全部守卫约束满足,dcw_judge 已提交,每轮决策依据已留痕` } })
  const taskId = goal.data?.id ?? goal.data?.task?.id
  console.log(`  ✔ [${scen}] channel=${CH.slice(0, 8)} 任务=${String(taskId).slice(0, 8)} worker 绑定 ${Object.keys(rec.dcw).length + Object.keys(rec.daq).length} 节点`)
  runs.push({ scen, zh: SCENARIOS[scen].zh, CH, taskId, workerInst: WI.id, lineId: rec.ids.lineId, dcw: rec.dcw, daq: rec.daq, state: 'SUBMITTED', done: false, startedAt: Date.now() })
}

// ── OL-3:录制器(每线一路)并启动 ──
const recorders = new Map()
for (const r of runs) {
  const rec = createOptRecorder({ BASE: base, token: api.token, channelId: r.CH, lineId: r.lineId, traceDir: outDir, label: r.scen })
  rec.start()
  recorders.set(r.scen, rec)
}
console.log('\n✔ 三线录制器已启动(时间线/终端全帧/设定曲线/质量曲线)\n')

// ── OL-4:等待收口(并行;单线完成即定格录制) ──
const t0 = Date.now()
const deadline = t0 + budgetMin * 60000
while (Date.now() < deadline && runs.some(r => !r.done)) {
  for (const r of runs) {
    if (r.done) continue
    try {
      const j = await api.call('GET', `/api/workshop/channels/${r.CH}/tasks`)
      const arr = Array.isArray(j.data) ? j.data : j.data?.tasks ?? []
      const st = arr.find(x => x.id === r.taskId)?.state ?? ''
      if (st !== r.state) {
        r.state = st
        console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] [${r.scen}] 任务 → ${st}`)
      }
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(st)) { r.done = true; r.finalState = st; recorders.get(r.scen)?.stop() }
    } catch { /* 瞬断吸收,下轮再查 */ }
  }
  await sleep(8000)
}
for (const r of runs) {
  if (!r.done) { r.finalState = 'BUDGET_TIMEOUT'; recorders.get(r.scen)?.stop() }
}

// ── OL-5:终态核验(独立读数:PV/守卫现状)+ 报告落盘 ──
const report = { runId: rid, at: new Date().toISOString(), budgetMin, base, scenarios: list, lines: [] }
for (const r of runs) {
  const s = SCENARIOS[r.scen]
  const dcwSnap = await api.call('GET', '/api/workshop/dcw')
  const daqSnap = await api.call('GET', '/api/workshop/daq')
  const knobs = Object.entries(r.dcw).map(([sig, id]) => {
    const n = (dcwSnap.data?.nodes ?? []).find(x => x.id === id)
    return { sig, value: n?.value, unit: n?.unit, state: n?.state }
  })
  const quality = Object.entries(r.daq).map(([sig, id]) => {
    const n = (daqSnap.data?.nodes ?? []).find(x => x.id === id)
    return { sig, value: n?.value, unit: n?.unit, state: n?.state }
  })
  const pvFinal = quality.find(q => q.sig === s.pv.sig)?.value
  const inBand = Number.isFinite(pvFinal) && Math.abs(Number(pvFinal) - s.pv.target) <= s.pv.tol
  const guardsOk = s.guards.every((g) => {
    const q = quality.find(x => x.sig === g.sig)
    if (!q || q.value == null) return true
    if (g.max != null && Number(q.value) > g.max) return false
    if (g.min != null && Number(q.value) < g.min) return false
    if (g.max != null && Number(q.value) > g.max) return false
    return true
  })
  const line = {
    scen: r.scen, zh: r.zh, channel: r.CH, taskId: r.taskId, lineId: r.lineId,
    finalState: r.finalState ?? r.state, pvFinal, pvTarget: `${s.pv.target}±${s.pv.tol}`, inBand, guardsOk,
    knobs, quality,
    recorder: recorders.get(r.scen)?.state ?? {},
  }
  report.lines.push(line)
  console.log(`  [${r.scen}] finalState=${line.finalState} pv=${pvFinal}(带${inBand ? '内' : '外'}) guards=${guardsOk ? 'OK' : 'VIOLATED'} | 曲线采样 set=${line.recorder.setpointSamples} q=${line.recorder.qualitySamples} tl=${line.recorder.timelineRows} ws=${line.recorder.wsFrames}`)
}
const okAll = report.lines.every(l => l.finalState === 'COMPLETED' && l.inBand && l.guardsOk)
report.ok = okAll
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(report, null, 2))

// 每线简报 MD(决策链从 timeline 提取要点)
for (const l of report.lines) {
  const md = [
    `# ${l.zh} · 闭环寻优报告(${l.scen})`,
    ``,
    `- 终态:${l.finalState} · PV 终值:${l.pvFinal} ${SCENARIOS[l.scen].pv.unit}(目标带 ${l.pvTarget})${l.inBand ? ' ✓ 带内' : ' ✘ 带外'}`,
    `- 守卫约束:${l.guardsOk ? '全部满足' : '存在违反(见 summary.json)'} `,
    `- 收口设定:`,
    ...l.knobs.map(k => `  - ${k.sig} = ${k.value} ${k.unit ?? ''}`),
    `- 实测终值:`,
    ...l.quality.map(q => `  - ${q.sig} = ${q.value} ${q.unit ?? ''}`),
    `- 证据文件:${l.scen}-timeline.jsonl(对话全录) / ${l.scen}-worker-stream.jsonl(worker 全帧) / ${l.scen}-setpoints.jsonl(设定曲线) / ${l.scen}-quality.jsonl(质量曲线)`,
    ``,
  ].join('\n')
  writeFileSync(join(outDir, `${l.scen}-REPORT.md`), md)
}

console.log(`\n─── optloop 结果:${okAll ? '✅ 全部达标' : '❌ 未全部达标'} ───`)
console.log(`报告 → bench/results/${rid}/`)
process.exit(okAll ? 0 : 1)
