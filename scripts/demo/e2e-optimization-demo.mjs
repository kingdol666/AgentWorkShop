/**
 * 端到端优化作业演示(真实平台 + PLC 模拟器孪生,modbus-tcp):
 *
 *  观测 → DoE 计划(真实线,HITL 单卡) → 未批准被拒 → 批准 → 随机化执行(3 步)
 *  → 引擎判读回填台账 → 判定回灌本体证据 → 由实测增益计算目标 SP → 下发生效
 *  → 重量进入目标窗(控得好)
 *
 * 前置:平台实例已开线、模拟器孪生已接入(provision-line 完成)。
 * 用法:
 *   node scripts/demo/e2e-optimization-demo.mjs \
 *     --base http://127.0.0.1:3960 --home D:/tmp/aw-demo-home \
 *     --line ln-xxx --dcw dw-xxx --daq dn-xxx --email .. --pass .. \
 *     [--out docs/audit/evidence/2026-11-02-e2e-optimization-demo/report.json]
 *
 * 目标窗:32.00–32.30 g(演示设定);基线 SP=50 → ≈31.78 g(低于窗)。
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (k, d = '') => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const BASE = argOf('--base', 'http://127.0.0.1:3960')
const HOME = argOf('--home')
const LINE = argOf('--line')
const DCW = argOf('--dcw')
const DAQ = argOf('--daq')
const OUT = argOf('--out', 'docs/audit/evidence/2026-11-02-e2e-optimization-demo/report.json')
const WINDOW = { lo: 32.0, hi: 32.3 }
const LEVELS = [50, 55, 60]
process.env.NO_PROXY = '127.0.0.1,localhost'

let pass = 0
const failures = []
const checks = []
function check(id, name, cond, detail = '') {
  if (cond) {
    pass++
    checks.push({ id, name, detail })
    console.log(`  PASS ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  }
  else {
    failures.push(`${id} ${name}: ${detail}`)
    console.log(`  FAIL ${id} ${name} — ${detail}`)
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let token = process.env.AW_TOKEN ?? ''
async function login() {
  if (token) return
  const r = await fetch(`${BASE}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: argOf('--email'), password: argOf('--pass') }),
  })
  const j = await r.json()
  token = j?.data?.token
  if (!token) throw new Error(`登录失败:${JSON.stringify(j).slice(0, 200)}`)
}
async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(600000),
  })
  return r.json()
}

/**
 * 最近 N 个采样桶的制品重量均值(平台 DAQ REST)。
 * 采集节拍 5s,所以取"最后 N 桶"而不是"最后 N 秒",避免把稳态前的过渡值混进来。
 */
async function weightMean(buckets = 6) {
  const j = await api('GET', `/api/workshop/daq/${DAQ}/samples?minutes=3`)
  const pts = (j?.data?.samples ?? j?.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite)
  if (!pts.length) return null
  const take = pts.slice(-Math.max(1, Math.min(pts.length, buckets)))
  return take.reduce((a, b) => a + b, 0) / take.length
}

/** 单节点没有 GET 路由:从聚合列表里取该 DCW 节点(含 value/lastChangeAt)。 */
async function nodeView() {
  const j = await api('GET', '/api/workshop/dcw')
  return (j?.data?.nodes ?? []).find(n => n.id === DCW) ?? null
}
function ledgerRows(planId) {
  const db = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'), { readOnly: true })
  try {
    const rows = db.prepare(`SELECT * FROM intervention_events WHERE node_id = ? AND hypothesis LIKE ? ORDER BY ts ASC`).all(DCW, `[pexp:${planId}]%`)
    return rows.map(r => ({
      id: r.id,
      from: r.from_value,
      to: r.to_value,
      effect: r.effect,
      verdict: r.verdict,
      mde: r.mde,
      ts: r.ts,
    }))
  }
  finally {
    db.close()
  }
}
function evidenceRows() {
  const db = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'), { readOnly: true })
  try {
    return db.prepare(`SELECT id, target_key, level, source_type, source_ref, detail_json FROM ontology_evidence ORDER BY created_at DESC LIMIT 20`).all()
  }
  finally {
    db.close()
  }
}

/** 写设定值,遇写间隔/保持窗按"还需 Ns"等待后重试(安全联锁,不绕过) */
async function writeWithRetry(value, hypothesis) {
  let wrote = await api('POST', `/api/workshop/dcw/${DCW}/write`, { value, hypothesis })
  for (let i = 0; i < 4 && wrote?.code === 'WRITE_INTERVAL_NOT_ELAPSED'; i++) {
    const txt = String(wrote.message ?? '')
    const at = txt.indexOf('还需')
    let digits = ''
    for (const ch of txt.slice(at + 2, at + 14)) {
      if (ch >= '0' && ch <= '9') digits += ch
      else if (digits) break
    }
    const need = Number(digits || 60)
    console.log(`  · 写入间隔未到,等待 ${need + 2}s 后重试(安全联锁,不绕过)`)
    await sleep((need + 2) * 1000)
    wrote = await api('POST', `/api/workshop/dcw/${DCW}/write`, { value, hypothesis })
  }
  return wrote
}

console.log(`\n[端到端优化作业演示] base=${BASE} line=${LINE}`)
await login()

// ---------- D0 复位到基线(幂等:上次演示可能把 SP 留在别的档位) ----------
{
  const nodeNow = await nodeView()
  const cur = Number(nodeNow?.value ?? Number.NaN)
  if (Number.isFinite(cur) && Math.abs(cur - LEVELS[0]) > 1e-9) {
    const r = await writeWithRetry(LEVELS[0], '演示前置:复位到基线设定值')
    console.log(`  · 复位基线 SP ${cur} → ${LEVELS[0]}:${r?.code === 0 ? 'ok' : JSON.stringify(r).slice(0, 100)}`)
    await sleep(22000)
  }
  else {
    console.log(`  · 已在基线 SP=${LEVELS[0]}`)
  }
}

// ---------- D1 基线观测 ----------
console.log('\nD1 基线观测(SP=50,目标窗 32.00–32.30g)')
const baseline = await weightMean(6)
check('D1a', '基线重量可观测', baseline != null, `mean=${baseline?.toFixed(3)}g`)
check('D1b', '基线低于目标窗下界(需要优化)', baseline != null && baseline < WINDOW.lo, `baseline=${baseline?.toFixed(3)} < ${WINDOW.lo}`)

// ---------- D2 DoE 计划(HITL) ----------
console.log('\nD2 DoE 计划(真实线 → 单卡 HITL)')
const created = await api('POST', '/api/workshop/process-model/experiments', {
  lineId: LINE,
  levels: { [DCW]: LEVELS },
  repeats: 1,
  settleMs: 60000,
  observeMs: 1000,
  targets: { [DCW]: DAQ },
})
const plan = created?.data?.plan
check('D2a', '计划创建成功且待批准', created?.code === 0 && plan?.status === 'awaiting_approval', `status=${plan?.status}`)
const body = JSON.parse(plan?.planJson ?? '{}')
check('D2b', '成本核算前置(3 步,真实线 60s 下限)', body?.cost?.steps === 3 && /60s/.test(body?.cost?.summary ?? ''), body?.cost?.summary ?? '')

// ---------- D3 未批准被拒 ----------
console.log('\nD3 未批准执行必须被拒')
const denied = await api('POST', '/api/workshop/process-model/experiments', { action: 'run', planId: plan.id })
check('D3', '未批准执行被拒(APPROVAL_REQUIRED)', denied?.code !== 0 && /APPROVAL_REQUIRED|批准/.test(JSON.stringify(denied)), JSON.stringify(denied).slice(0, 120))

// ---------- D4 批准 + 执行 ----------
console.log('\nD4 人工批准 + 随机化执行(3 步 × 60s)')
const approved = await api('POST', '/api/workshop/process-model/experiments', { action: 'approve', planId: plan.id })
check('D4a', '批准后转 planned', approved?.data?.plan?.status === 'planned', approved?.data?.plan?.status)
const t0 = Date.now()
const runRes = await api('POST', '/api/workshop/process-model/experiments', { action: 'run', planId: plan.id })
const run = runRes?.data?.result
check('D4b', '计划执行完成 3/3', run?.status === 'done' && run?.executedSteps === 3, `${run?.status} ${run?.executedSteps}/${run?.totalSteps} 用时 ${Math.round((Date.now() - t0) / 1000)}s ${run?.failedReason ?? ''}`)

// ---------- D5 台账 + 判读 + 证据 ----------
console.log('\nD5 台账判定与本体证据')
const rows = ledgerRows(plan.id)
check('D5a', '台账 3 行且全部判定(非 pending)', rows.length === 3 && rows.every(r => r.verdict !== 'pending'), rows.map(r => r.verdict).join(','))
const ev = evidenceRows()
const linked = ev.filter(e => rows.some(r => e.source_ref === r.id))
check('D5b', '判定回灌本体证据(逐干预可追溯)', linked.length >= 1, `${linked.length} 条`)

// ---------- D6 学习:由实测响应估增益 ----------
console.log('\nD6 从实验数据估计动作增益')
// P5:优先用执行器只按可辨识步估计的增益(run.estimatedGain);旧结果回退到全步中位数
const gains = []
for (const r of rows) {
  if (r.effect == null || r.from == null || r.to == null) continue
  const dsp = Number(r.to) - Number(r.from)
  if (Math.abs(dsp) > 1e-9) gains.push(Number(r.effect) / dsp)
}
const runnerGain = run?.estimatedGain
const gain = runnerGain != null && Number.isFinite(runnerGain)
  ? runnerGain
  : (gains.length ? gains.sort((a, b) => a - b)[Math.floor(gains.length / 2)] : null)
const gainSrc = runnerGain != null && Number.isFinite(runnerGain) ? `执行器可辨识步估计(排除 ${run?.gainExcludedSteps ?? 0} 步欠功效)` : '全步中位数(旧口径)'
check('D6a', '可从台账效应量估出增益', gain != null && Number.isFinite(gain), `gain=${gain?.toFixed(5)} g/bar(${gainSrc};样本 ${runnerGain != null ? run?.gainSamples : gains.length})`)
check('D6b', '增益方向正确(压力↑→重量↑)', gain != null && gain > 0, `gain=${gain?.toFixed(5)}`)

// ---------- D7 计算并下发目标 SP ----------
console.log('\nD7 计算目标 SP 并下发')
const lastSp = Number(rows.at(-1)?.to ?? LEVELS[0])
const currentWeight = await weightMean(6)
const targetWeight = (WINDOW.lo + WINDOW.hi) / 2
const proposed = gain != null ? lastSp + (targetWeight - currentWeight) / gain : lastSp
const targetSp = Math.round(Math.min(90, Math.max(50, proposed)) * 10) / 10
check('D7a', '目标 SP 在安全量程内', targetSp >= 50 && targetSp <= 90, `SP=${targetSp}bar(当前 ${lastSp},重量 ${currentWeight?.toFixed(3)}g)`)
// 写完 DoE 最后一步后有 60s 保持窗:等到窗口结束再下发
const sinceLastWrite = rows.length ? Date.now() - Date.parse(rows.at(-1).ts) : 60000
if (sinceLastWrite < 62000) await sleep(62000 - sinceLastWrite)
const writeHypothesis = `按 DoE 实测增益 ${gain?.toFixed(5)} g/bar 计算:目标重量 ${targetWeight}g`
const wrote = await writeWithRetry(targetSp, writeHypothesis)
check('D7b', '参数下发受理', wrote?.code === 0, JSON.stringify(wrote?.data ?? wrote).slice(0, 160))
const readback = await nodeView()
const rb = Number(readback?.value ?? Number.NaN)
check('D7c', '回读一致', Math.abs(rb - targetSp) < 0.11, `readback=${rb} target=${targetSp}`)

// ---------- D8 控得好:重量进入目标窗 ----------
console.log('\nD8 效果验证(等待工艺跟随)')
await sleep(25000)
const after = await weightMean(6)
const inWindow = after != null && after >= WINDOW.lo && after <= WINDOW.hi
check('D8', '制品重量进入目标窗', inWindow, `after=${after?.toFixed(3)}g window=[${WINDOW.lo},${WINDOW.hi}] Δ=${((after ?? 0) - (baseline ?? 0)).toFixed(3)}g`)

// ---------- 证据 ----------
const report = {
  at: new Date().toISOString(),
  scope: { platform: 'isolated-instance', simulator: 'plc-node-simulator(modbus-tcp)', deviceLayer: 'simulated-twin', realPlant: false },
  lineId: LINE,
  dof: { levels: LEVELS, planId: plan.id, controller: DCW, target: DAQ },
  baseline: { weight: baseline, sp: LEVELS[0] },
  ledger: rows,
  estimatedGain: gain,
  dispatch: { targetSp, readback: rb, targetWeight },
  final: { weight: after, window: WINDOW, delta: after != null && baseline != null ? after - baseline : null },
  pass,
  fail: failures.length,
  failures,
  checks,
}
mkdirSync(join(OUT, '..'), { recursive: true })
writeFileSync(OUT, JSON.stringify(report, null, 2))
console.log(`\n[结果] PASS=${pass} FAIL=${failures.length}`)
console.log(`[证据] ${OUT}`)
if (failures.length) {
  for (const f of failures) console.error(` - ${f}`)
  process.exit(1)
}
console.log('[端到端优化作业] ALL PASS\n')
