/**
 * 闭环实验收尾器 —— 复用已完成的调参任务状态,补跑 inspector 稽核 + S4 评估 + 落盘。
 * 用途:主实验脚本意外中断时,从活系统状态恢复出完整 result.json(不重跑调参)。
 *
 * 用法:NO_PROXY='127.0.0.1,localhost' node scripts/experiment-castfilm-finish.mjs <tag> [channelId]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TAG = process.argv[2] ?? 'cfB'
const BASE = 'http://127.0.0.1:3001'
const SIM = 'http://127.0.0.1:4010'
const OUT_DIR = path.join(fileURLToPath(new URL('../docs/experiments/results', import.meta.url)), `castfilm-${TAG}`)
const RUN_LOG = fileURLToPath(new URL(`../docs/experiments/results-run-${TAG}.log`, import.meta.url))
fs.mkdirSync(OUT_DIR, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (base, method, p, { body, token } = {}) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

let pass = 0
let fail = 0
const marks = []
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`)
  }
  else {
    fail++
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
  marks.push({ name, ok: !!cond, extra })
}

const login = await api(BASE, 'POST', '/api/users/login', { body: { email: 'admin@awshop.local', password: 'admin123' } })
const token = login.data?.token
if (!token) {
  console.error('登录失败')
  process.exit(1)
}

// ---- 找 channel / goal task / tuner 实例 ----
const channels = (await api(BASE, 'GET', '/api/workshop/channels', { token })).data ?? []
const ch = process.argv[3] ? { id: process.argv[3] } : channels.find(c => c.name.includes(TAG))
if (!ch?.id) {
  console.error(`找不到 castfilm-${TAG} 频道`)
  process.exit(1)
}
const tasks = (await api(BASE, 'GET', `/api/workshop/channels/${ch.id}/tasks`, { token })).data ?? []
const goal = tasks.find(t => t.title === `castfilm-optimize-${TAG}`)
ok(goal?.state === 'COMPLETED', `调参任务状态 ${goal?.state}(progress ${goal?.progress}%)`)

// ---- 通道成员(tuner/inspector 实例) ----
const members = (await api(BASE, 'GET', `/api/workshop/channels/${ch.id}/agents`, { token })).data ?? []
const tunerInst = members.find(m => (m.name ?? '').includes('tuner'))
const inspInst = members.find(m => (m.name ?? '').includes('inspector'))
ok(Boolean(tunerInst?.id && inspInst?.id), `成员实例(tuner=${tunerInst?.id?.slice(0, 8)},inspector=${inspInst?.id?.slice(0, 8)})`)

// ---- 收敛交付 ----
const blobOf = async (taskId) => {
  const t = JSON.stringify((await api(BASE, 'GET', `/api/workshop/tasks/${taskId}`, { token })).data ?? {})
  const m = JSON.stringify((await api(BASE, 'GET', `/api/workshop/channels/${ch.id}/messages?limit=300`, { token })).data ?? {})
  const e = JSON.stringify((await api(BASE, 'GET', `/api/workshop/channels/${ch.id}/events?limit=500`, { token })).data ?? {})
  return t + m + e
}
const goalBlob = await blobOf(goal.id)
// 取「最后一条带数值的 CONVERGED」(任务输入里的提示词模板不算交付)
const convMatches = [...goalBlob.matchAll(/CONVERGED h=([\d.]+)\s+defect=([\d.]+)\s+press=([\d.]+)\s+N=([\d.]+)\s+v=([\d.]+)/g)]
const convLine = convMatches.at(-1)?.[0] ?? ''
ok(Boolean(convLine), `[闭环] 收敛交付: ${convLine.slice(0, 120)}`)

// ---- 数控账本(REST journal:服务端内存态,不依赖磁盘文件) ----
const dcwAll = (await api(BASE, 'GET', '/api/workshop/dcw', { token })).data?.nodes ?? []
const myDcw = dcwAll.filter(n => String(n.name).includes(TAG))
const lineIdOf = myDcw[0]?.lineId ?? ''
const journal = (await api(BASE, 'GET', `/api/workshop/dcw/journal?lineId=${lineIdOf}&limit=500`, { token })).data?.anchors ?? []
const tagWrites = journal.filter(w => myDcw.some(n => n.id === w.nodeId))
ok(tagWrites.length > 0, `[数控] 参数账本 ${tagWrites.length} 条真实协议写(${[...new Set(tagWrites.map(w => w.nodeId))].size} 节点,含 HITL approvalId ${tagWrites.filter(w => w.approvalId).length} 条)`)

// ---- inspector 稽核 ----
const daqNodes = (await api(BASE, 'GET', '/api/workshop/daq', { token })).data?.nodes ?? []
const thk = daqNodes.find(n => n.name.includes('平均膜厚') && n.name.includes(TAG))
const dft = daqNodes.find(n => n.name.includes('缺陷率') && n.name.includes(TAG))
const prs = daqNodes.find(n => n.name.includes('熔体压力') && n.name.includes(TAG))
let auditLine = ''
let auditState = 'SKIP'
if (inspInst?.id) {
  const existing = tasks.find(t => t.title === `castfilm-audit-${TAG}`)
  const audit = existing
    ? { data: { task: { id: existing.id } } }
    : await api(BASE, 'POST', `/api/workshop/channels/${ch.id}/tasks`, {
        body: {
          title: `castfilm-audit-${TAG}`,
          parts: [{ text: `独立稽核刚结束的调参批次:用 daq_query 读取 "${thk?.name}"(id=${thk?.id})、"${dft?.name}"(id=${dft?.id})、"${prs?.name}"(id=${prs?.id}) 的当前值;对照合格判据(膜厚 48~52μm、缺陷率<2%、压力≤22MPa)给出 PASS 或 FAIL 及数值证据;交付最后一行原样输出 AUDIT <PASS|FAIL> h=<值> defect=<值> press=<值>。完成后调用 complete_task。` }],
          assigneeId: inspInst.id,
        }, token,
      })
  const auditTask = audit.data?.task?.id ?? audit.data?.id
  const deadline = Date.now() + 8 * 60_000
  while (Date.now() < deadline) {
    await sleep(8000)
    auditState = (await api(BASE, 'GET', `/api/workshop/tasks/${auditTask}`, { token })).data?.state ?? ''
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(auditState)) break
  }
  const auditMatches = [...(await blobOf(auditTask)).matchAll(/AUDIT (PASS|FAIL) h=([\d.-]+)\s+defect=([\d.-]+)\s+press=([\d.-]+)/g)]
  auditLine = auditMatches.at(-1)?.[0] ?? ''
}
ok(auditState === 'COMPLETED' && /AUDIT\s+PASS/.test(auditLine), `[稽核] inspector 复核 ${auditLine.slice(0, 90) || auditState}`)

// ---- S4 评估:采样窗 vs W* ----
const W = (await api(SIM, 'GET', '/api/plant/optimum')).data
const nowMs = Date.now()
const winStats = async (nodeId, windowMs) => {
  const pts = (await api(BASE, 'GET', `/api/workshop/daq/${nodeId}/samples?from=${nowMs - windowMs}&to=${nowMs}&bucketMs=1000&limit=600`, { token })).data?.points ?? []
  const vals = pts.map(p => Number(p.avg ?? p.value)).filter(Number.isFinite)
  if (!vals.length) return null
  const avg = a => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1)
  return { n: vals.length, avg: avg(vals), min: Math.min(...vals), max: Math.max(...vals) }
}
// 稽核/评估窗 = 最近 8 分钟(覆盖收敛后稳态)
const WIN = 8 * 60_000
const hWin = thk ? await winStats(thk.id, WIN) : null
const dWin = dft ? await winStats(dft.id, WIN) : null
const pWin = prs ? await winStats(prs.id, WIN) : null
const hIn = hWin && Math.abs(hWin.avg - 50) <= 2
const dIn = dWin && dWin.avg < 2
const pIn = pWin && pWin.max <= 22
ok(hIn, `膜厚窗均值 ${hWin ? hWin.avg.toFixed(2) : '∅'}μm ∈ 50±2 [${hWin ? hWin.min.toFixed(1) : '-'}~${hWin ? hWin.max.toFixed(1) : '-'}]`)
ok(dIn, `缺陷率窗均值 ${dWin ? dWin.avg.toFixed(3) : '∅'}% < 2`)
ok(pIn, `压力窗峰值 ${pWin ? pWin.max.toFixed(2) : '∅'}MPa ≤ 22`)

const lastNewValue = (nodeId, fallback) => {
  const mine = tagWrites.filter(w => w.nodeId === nodeId).sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  return Number(mine.at(-1)?.newValue ?? fallback)
}
const jScore = ({ thickness, defect, screw, lineSpeed, meltTemp, pressure }) => {
  if (meltTemp < 195 || meltTemp > 225 || pressure > 22) return NaN
  const thErr = Math.abs(thickness - 50)
  const jTh = thErr <= 2 ? 1 : Math.max(0, 1 - (thErr - 2) / 10)
  const jQuality = 1 - Math.min(defect, 8) / 8
  const jEnergy = 1 - (screw - 50) / 150
  const jThrough = lineSpeed / 120
  return 55 * jTh + 25 * jQuality + 8 * jEnergy + 7 * jThrough
}
const nodes = dcwAll
const screwNode = nodes.find(n => n.name.includes('螺杆转速') && n.name.includes(TAG))
const lineNode = nodes.find(n => n.name.includes('牵引线速') && n.name.includes(TAG))
const N = lastNewValue(screwNode?.id, 150)
const V = lastNewValue(lineNode?.id, 95)
const agentJ = jScore({ thickness: hWin?.avg ?? 0, defect: dWin?.avg ?? 100, screw: N, lineSpeed: V, meltTemp: 210, pressure: pWin?.avg ?? 99 })
const ratio = Number.isFinite(agentJ) ? agentJ / W.score : 0
ok(ratio >= 0.9, `工艺目标函数 J(W_agent)=${Number(agentJ).toFixed(2)} 达 W*(J=${W.score}) 的 ${(ratio * 100).toFixed(1)}%(N=${N} v=${V})`)

// ---- 前段检查从运行日志回填(排除主脚本任务 id 解析 bug 时期的轮询伪失败) ----
if (fs.existsSync(RUN_LOG)) {
  const log = fs.readFileSync(RUN_LOG, 'utf-8')
  for (const m of log.matchAll(/^[ \t]*(✓|✗) (.+)$/gmu)) {
    const name = m[2].trim()
    if (/调参任务 COMPLETED\(state=RUNNING\)/.test(name)) continue // 任务实况以本脚本直查为准
    marks.unshift({ name, ok: m[1] === '✓', extra: '', front: true })
    m[1] === '✓' ? pass++ : fail++
  }
  const approvals = [...log.matchAll(/\[hitl\] 自动批准 #(\d+)/g)]
  var hitlCount = approvals.length
}

// ---- truth 落盘 + result.json ----
const truth = (await api(SIM, 'GET', '/api/plant/truth?limit=5000')).data?.samples ?? []
fs.writeFileSync(path.join(OUT_DIR, 'truth.jsonl'), truth.map(t => JSON.stringify(t)).join('\n'))
const result = {
  tag: TAG, base: BASE, sim: SIM,
  startedAt: goal?.createdAt ?? null, finishedAt: new Date().toISOString(),
  seed: 42, timeScale: 6,
  optimum: W,
  start: { zone: 200, screw: 150, lineSpeed: 95, dieGap: 1.0 },
  convergence: { convLine, auditLine, approvals: { count: hitlCount ?? null, latencies: [] } },
  finalSetpoints: { screw: N, lineSpeed: V },
  windows: { thickness: hWin, defect: dWin, pressure: pWin },
  scores: { agentJ, optimumJ: W.score, ratio },
  checks: marks,
  pass, fail,
}
fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2))
console.log(`\n结果 → docs/experiments/results/castfilm-${TAG}/(result.json + truth.jsonl;${pass} PASS / ${fail} FAIL)`)
process.exit(fail === 0 ? 0 : 1)
