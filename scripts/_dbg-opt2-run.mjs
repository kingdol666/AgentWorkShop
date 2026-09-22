/** 闭环寻优运行:质量目标驱动(任务书无设定值)→worker 自主决策迭代;全程捕获厚度收敛曲线 */
const BASE = 'http://127.0.0.1:3001'
const CH = '1c8abbe9-2667-4a0f-8db5-db67d050e85a'
const WORKER = '783511fa-8a43-4769-8dea-5202de646b68'
const THICK = 'dn-3c3aee75'
const TRACE = 'D:/codes/ABO/opt2-trace'
const fs = await import('node:fs')
fs.mkdirSync(TRACE, { recursive: true })
const append = (name, line) => fs.appendFileSync(`${TRACE}/${name}`, line + '\n')

const login = await fetch(BASE + '/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }) }).then(r => r.json())
const H = { 'content-type': 'application/json', authorization: `Bearer ${login.data.token}` }
const api = async (m, p, b) => (await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })).json().catch(() => ({}))
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 厚度收敛曲线采样器
const curve = []
let curveDone = false
async function sampleCurve() {
  while (!curveDone) {
    try {
      const j = await api('GET', `/api/workshop/daq`)
      const n = (j.data?.nodes ?? []).find(x => x.id === THICK)
      if (n) {
        const row = { at: new Date().toISOString(), value: n.value, state: n.state }
        curve.push(row)
        append('thickness-curve.jsonl', JSON.stringify(row))
      }
    } catch { }
    await sleep(10000)
  }
}

// worker 终端全帧录制
let tapped = false
async function tryTap() {
  if (tapped) return
  const terms = (await api('GET', `/api/workshop/channels/${CH}/terminals`)).data ?? []
  const mine = (Array.isArray(terms) ? terms : []).find(t => t.agentId === WORKER)
  if (!mine?.pid) return
  const ws = new globalThis.WebSocket(`${BASE.replace(/^http/, 'ws')}/api/system/monitor/terminal/ws?pid=${mine.pid}&token=${encodeURIComponent(login.data.token)}`)
  ws.addEventListener('open', () => { tapped = true; console.log('worker 终端录制已挂载 pid=' + mine.pid) })
  ws.addEventListener('message', (ev) => fs.appendFileSync(`${TRACE}/worker-omp-stream.jsonl`, String(ev.data).slice(0, 4000) + '\n'))
  ws.addEventListener('error', () => { tapped = false })
}

// 基线(改前)厚度样本
const before = (await api('GET', `/api/workshop/daq/${THICK}/samples?minutes=3`)).data?.points ?? []
fs.writeFileSync(`${TRACE}/thickness-before.json`, JSON.stringify(before))
console.log('改前厚度样本:', before.length)

// 提交寻优任务书(质量目标驱动,不含任何设定值)
const goal = await api('POST', `/api/workshop/channels/${CH}/tasks`, {
  title: '厚度闭环寻优:回到 50±2μm 质量带',
  parts: [{
    text: [
      '流延线当前厚度 53.7μm,偏出目标带(50±2μm)。你拥有三区加热温度 SP、螺杆转速 SP、线速度 SP、模口间隙 SP 的写权(配方窗内),以及厚度/熔温/熔体压力/缺陷率的数采读权。',
      '',
      '工艺机理(交底):挤出流量 Q ∝ 螺杆转速,且随熔体温度升高(熔体粘度下降)而增大;厚度 ∝ Q/线速度,并受模口间隙系数调节;熔体温度由三区温度沿程热传导叠加决定(调温要三区联动);熔体温度过高时缺陷率平方级上升;线速度是产能,尽量少降。',
      '',
      '质量目标:厚度 50±2μm 且稳定(连续两轮复测在带内)。附加约束:缺陷率≤1%、熔体压力≤22MPa(安全)、线速度降幅≤15%(保产能)。',
      '',
      '作业纪律:①每轮先 daq_query 取厚度/熔温/压力/缺陷实测,并读当前各设定值,做偏差归因;②决策写明机理依据与量化调整,单步限幅:转速单步≤15rpm、线速单步≤10m/min、温度单步≤15℃、间隙单步≤0.1mm;③写入后等 60~90s 物理响应再复测;④达标且稳定后 dcw_judge 收口;⑤每轮报告:测量值/各设定现值/决策依据/新设定。数采节点的量程告警状态可忽略(模板量程与工艺不匹配),以实测数值为准。',
    ].join('\n'),
  }],
  mode: 'goal',
  modeConfig: { goalCriteria: '厚度连续两轮复测在 48~52μm 内,缺陷率≤1%,压力≤22MPa,dcw_judge 已提交,每轮决策依据已留痕' },
})
const taskId = goal.data?.id ?? goal.data?.task?.id
console.log('寻优任务书已提交:', taskId?.slice(0, 8))
append('timeline.jsonl', JSON.stringify({ at: new Date().toISOString(), kind: 'goal-submitted', taskId }))

// 主循环:录制时间线 + 挂终端 + 采样曲线 + 等收口
let seen = new Set()
let state = ''
const deadline = Date.now() + 45 * 60000
while (Date.now() < deadline) {
  tryTap().catch(() => { })
  const j = await api('GET', `/api/workshop/channels/${CH}/messages?limit=30`)
  const arr = j.data?.messages ?? j.data ?? []
  for (const m of (Array.isArray(arr) ? arr : [])) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    append('timeline.jsonl', JSON.stringify({
      at: m.createdAt, role: m.role,
      from: m.metadata?.['x-aw-from-label'] ?? m.metadata?.['x-aw-from-agent'] ?? '?',
      to: m.metadata?.['x-aw-target-agent'] ?? 'channel',
      inReplyTo: m.metadata?.['x-aw-in-reply-to'] ?? null,
      text: (m.parts ?? []).map(p => p.text ?? '').join('').slice(0, 1500),
    }))
  }
  const tasks = await api('GET', `/api/workshop/channels/${CH}/tasks`)
  const tarr = Array.isArray(tasks.data) ? tasks.data : tasks.data?.tasks ?? []
  const cur = tarr.find(x => x.id === taskId)
  const ns = cur?.state ?? ''
  if (ns !== state) { state = ns; console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 任务状态 → ${state}`) }
  if (['COMPLETED', 'FAILED', 'CANCELED'].includes(state)) break
  await sleep(6000)
}
curveDone = true

// 收尾:厚度改后样本 + 台账 + 任务终态
const after = (await api('GET', `/api/workshop/daq/${THICK}/samples?minutes=6`)).data?.points ?? []
fs.writeFileSync(`${TRACE}/thickness-after.json`, JSON.stringify(after))
const opt = await api('GET', '/api/workshop/dcw/optimizations?limit=6')
fs.writeFileSync(`${TRACE}/optimization-records.json`, JSON.stringify(opt, null, 2))
const taskFinal = await api('GET', `/api/workshop/channels/${CH}/tasks`)
const tarr = Array.isArray(taskFinal.data) ? taskFinal.data : taskFinal.data?.tasks ?? []
fs.writeFileSync(`${TRACE}/task-final.json`, JSON.stringify(tarr, null, 2))
const settings = await api('GET', '/api/workshop/dcw')
const dnodes = (settings.data?.nodes ?? []).filter(n => Object.values({}).length === 0)
console.log('任务终态:', state)
console.log('厚度曲线采样:', curve.length, '点 | 改前样本:', before.length, '| 改后:', after.length)
console.log('TRACE:', TRACE)
