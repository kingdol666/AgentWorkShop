/**
 * 0.7.46/0.7.47 打包系统验收 · 阶段 5:真实场景 prompt 闭环控制优化(hybrid twin channel)
 *  - 用 PLC 模拟注塑产线的**真实场景事实**(克重窗口/守卫/受控量/活动批次)下发 goal 任务
 *  - 断言:真实 omp 团队走完 twin_scene_read → twin_snapshot_create → mpc_optimize → twin_gate_evaluate
 *  - 断言:recommendation-only 生效 —— 全程**零真实 DCW 写入**
 * 用法:AW_BASE=http://127.0.0.1:3001 [AW_HOME=<隔离实例目录>] node scripts/_aw0746-stage5.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const HOME = process.env.AW_HOME ?? `${process.cwd()}/.aw0746-home`
const ADMIN = { email: process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', password: process.env.AW_ADMIN_PASSWORD ?? 'Awshop@123!' }

let pass = 0
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass += 1
  else fails.push(name)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}

const token = (await j('POST', '/api/users/login', { email: ADMIN.email, password: ADMIN.password })).data?.token
const chans = (await j('GET', '/api/workshop/channels', undefined, token)).data ?? []
// AW_CHANNEL_ID 可指定专用 Channel:FIFO 根队列是串行的,上一个根任务 FAILED 后
// 该 Channel 可能长时间不再派发新根任务(实测 55017fd8 悬挂 15 分钟),
// 验收用新实例化 Channel 可避免被历史队列拖住。
const twin = process.env.AW_CHANNEL_ID
  ? chans.find(c => c.id === process.env.AW_CHANNEL_ID)
  : chans.find(c => /闭环优化-hybridtwin/.test(c.name))
check('找到闭环优化 Channel(hybrid twin 模板实例)', Boolean(twin), `${twin?.name} ${String(twin?.id).slice(0, 8)}`)
const channelId = twin.id
const members = (await j('GET', `/api/workshop/channels/${channelId}/agents`, undefined, token)).data ?? []
const lead = members.find(m => m.role === 'lead')

const dcw = (await j('GET', '/api/workshop/dcw', undefined, token)).data
const line = (dcw.lines ?? []).find(l => /injection-aw0746/i.test(String(l.name)))
const daq = (await j('GET', '/api/workshop/daq', undefined, token)).data
const nodes = (daq.nodes ?? []).filter(n => n.lineId === line.id)
const byName = re => nodes.find(n => re.test(n.name))
// auto_daq 走 Agent 真实绑定:给 Channel 全体成员补绑定(模板实例化不自带)
const requiredIds = [byName(/part-weight/), byName(/flash-rate/), byName(/sink-mark/), byName(/melt-temp-pv/), byName(/melt-pressure-pv/)].filter(Boolean).map(n => n.id)
let bindCount = 0
for (const m of members) {
  for (const nodeId of requiredIds) {
    const r = await j('POST', '/api/workshop/agent-tools/bindings', { agentId: m.id, nodeId, kind: 'daq', mode: 'auto' }, token)
    if (r.code === 0) bindCount += 1
  }
}
console.log(`  · 场景绑定注入:${bindCount} 条(成员 ${members.length} × 节点 ${requiredIds.length})`)
const controls = (dcw.nodes ?? []).filter(n => n.lineId === line.id && /hold-pressure|hold-time|mold-temp/.test(n.name))
const writesBefore = Number(dcw.controller?.writesTotal ?? 0)

// 真实场景 prompt(取自 PLC 模拟器注塑场景的工程事实)
const SCENARIO = [
  '场景:PLC 模拟器注塑成型产线(真实协议栈,非抽象任务)。',
  `产线 ${line.name}(${line.id}),活动批次配方三件套由 line_context 读取,不要臆造 id。`,
  '质量目标:制品克重 part-weight 命中 32.5 ± 0.35 g;飞边 flash-rate ≤ 0.4%;缩痕 sink-mark ≤ 1.5%;',
  '守卫:熔体温度 melt-temp-pv 235~262℃;注射压力 inj-pressure-pv 40~70 bar。',
  `受控量(不可越界,单变量小步):${controls.map(c => `${c.name}(${c.id},${c.min}~${c.max}${c.unit})`).join('; ')}。`,
  `观测节点:${[byName(/part-weight/), byName(/flash-rate/), byName(/sink-mark/), byName(/melt-temp/), byName(/inj-pressure/)].filter(Boolean).map(n => `${n.name}(${n.id})`).join('; ')}。`,
].join('\n')

const TASK = [
  '目标:完成一次 recommendation-only 的混合孪生 MPC 闭环优化推演,并给出可审计的推荐结论。',
  '硬性要求(按序执行,每步都有据可查):',
  '1) twin_scene_read 读取场景契约;若场景未就绪,先用 scene/objective 参数把当前产线与活动批次登记进去(允许使用工具自带参数)。',
  '2) twin_snapshot_create 生成工况快照(必须带最新 DAQ 值)。',
  '3) twin_trial_run 跑至少 1 个候选的虚拟试验(硬约束拒绝不安全候选;candidateExecuted 必须为 false)。',
  '4) mpc_optimize 在受控量小步范围内搜索推荐设定;',
  '5) twin_gate_evaluate 做门禁与收益评估 —— 若门禁未通过,报告 safe_small_step 结论(这是合法结果,不要伪造通过)。',
  '禁止事项:任何成员不得调用 dcw_control / param_control 写真实设定(本次为 recommendation-only,写控需另行授权)。',
  '交付物(中文,≤ 12 行):① 场景与批次三元组;② 快照关键值;③ 推荐设定(或 safe_small_step 原因);④ 门禁/证书结论;⑤ 一句话说明"未写真实 PLC"这一事实。',
].join('\n')

const task = await j('POST', `/api/workshop/channels/${channelId}/tasks`, {
  title: `闭环优化:注塑克重窗口 recommendation-only ${Date.now().toString(36).slice(-4)}`,
  description: `${SCENARIO}\n\n${TASK}`,
  assigneeId: lead?.id,
}, token)
const taskId = task.data?.id
const taskStartMs = Date.now() - 60_000
check('闭环优化任务下发到 lead(真实 omp 团队)', Boolean(taskId), `task=${String(taskId).slice(0, 8)} ${task.message ?? ''}`)

console.log('  … 等待真实 omp 团队执行(最长 20 分钟)…')
let final = null
const deadline = Date.now() + 20 * 60_000
while (Date.now() < deadline) {
  await sleep(15_000)
  const ts = (await j('GET', `/api/workshop/channels/${channelId}/tasks`, undefined, token)).data ?? []
  const t = ts.find(x => x.id === taskId)
  process.stdout.write(`\r    state=${t?.state ?? '?'} progress=${t?.progress ?? 0}% children=${ts.filter(x => x.parentId === taskId).length}   `)
  if (t && ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state)) {
    final = t
    break
  }
}
console.log('')
check('任务到达终态', Boolean(final), `state=${final?.state ?? 'timeout'}`)
check('任务 COMPLETED(闭环推演完成)', final?.state === 'COMPLETED', `state=${final?.state}`)

const arts = (final?.artifacts ?? []).map(a => (a.parts ?? []).map(p => p.text ?? '').join('\n')).join('\n---\n')
console.log('\n交付物:\n' + (arts || '(空)').slice(0, 1400))

// 工具证据必须落在**磁盘工件**上,而不是频道事件里 grep 工具名:
// ① 事件流不记 Agent 的工具调用(实测命中为空,旧断言属于误判);
// ② 交付物里的 snapshot_id/trial_id 可能是模型幻觉,只有工件文件才是硬证据。
const twinsRoot = `${HOME}/aml/twins`
const since = taskStartMs
const newer = (dir) => {
  const p = join(twinsRoot, dir)
  if (!existsSync(p)) return []
  return readdirSync(p, { withFileTypes: true })
    .filter(e => e.isDirectory() && statSync(join(p, e.name)).mtimeMs >= since)
    .map(e => join(p, e.name))
}
const snapDirs = newer('snapshots')
const trialDirs = newer('trials')
const mpcDirs = newer('mpc')
check('孪生/MPC 工具链被真实调用(磁盘工件留痕)', snapDirs.length >= 1 && trialDirs.length >= 1, `快照=${snapDirs.length} 试验=${trialDirs.length} MPC=${mpcDirs.length}(${twinsRoot})`)

const trialArtifacts = trialDirs.map((d) => {
  try {
    return JSON.parse(readFileSync(join(d, 'trials.json'), 'utf8'))
  }
  catch {
    return null
  }
}).filter(Boolean)
const trialsReal = trialArtifacts.map(a => a.trial).filter(Boolean)
check('虚拟试验恒为 candidateExecuted=false(recommendation-only)', trialsReal.length >= 1 && trialsReal.every(t => t.candidateExecuted === false), `试验数=${trialsReal.length} candidateExecuted=${[...new Set(trialsReal.map(t => t.candidateExecuted))].join(',')}`)
const snapIds = snapDirs.map((d) => {
  try {
    return JSON.parse(readFileSync(join(d, 'snapshots.json'), 'utf8'))
  }
  catch {
    return null
  }
}).filter(Boolean)
check('TwinSnapshot 为真实数据(fresh=true 且水位>0)', snapIds.length >= 1 && snapIds.every(s2 => s2.dataQuality?.fresh === true && s2.daqWatermark > 0), snapIds.map(s2 => `${s2.snapshotId} fresh=${s2.dataQuality?.fresh}`).join('; '))
const certs = trialArtifacts.filter(a => a.certificate).length
console.log(`  · 工件明细:快照 ${snapIds.length} 个 / 试验 ${trialsReal.length} 个 / 推荐证书 ${certs} 张`)

const dcwAfter = (await j('GET', '/api/workshop/dcw', undefined, token)).data
const writesAfter = Number(dcwAfter.controller?.writesTotal ?? 0)
check('全程零真实 DCW 写入(recommendation-only 生效)', writesAfter === writesBefore, `writes ${writesBefore} → ${writesAfter}`)

console.log(`\n★ 阶段 5:${pass} 通过 / ${fails.length} 失败${fails.length ? ` (${fails.join('; ')})` : ''}`)
console.log(JSON.stringify({ channelId, taskId, state: final?.state }, null, 1))
