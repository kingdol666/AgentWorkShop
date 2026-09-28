#!/usr/bin/env node
/**
 * scripts/_audit/kb-team-omp-e2e.mjs —— 知识库集成通用闭环优化频道 × 真实 omp × 多 PLC 模拟场景。
 *
 * 每个 scenario:
 *   ① 模拟器建场(ensureScenarioLine) + 平台建线开跑(provisionScenarioLine,真实协议链路);
 *   ② 实例化「通用闭环优化频道(标准)」模板,enableKnowledgeBase=true(频道加载 rag-bridge);
 *   ③ lead 绑定 PV 数采节点 + 调节数控节点(auto);
 *   ④ 提交优化 goal(要求:先查知识库 → lead 委派节点权限 → 治理小步下发复测 → 判定 → 经验沉淀);
 *   ⑤ 期间轮询任务/消息/事件,全程转录落盘(transcript.md + 原始 JSON);
 *   ⑥ 验收:根任务收口 + worker 确实被授予节点(grantedBy 溯源) + 发生过治理写入
 *      + PV 回带 + 知识库经验新增(kb_agent 异步落库)。
 *
 * 用法:
 *   node scripts/_audit/kb-team-omp-e2e.mjs --base http://127.0.0.1:3456 --scenarios injection,wwtp
 * 前置:目标实例为本仓库构建(内置通用模板 + rag-bridge);rag-bridge token 已配置(启 KB 鉴权时);
 *       omp CLI 在 PATH 且可用;模拟器可自举(bench/lib/sim.mjs ensureSimulator)。
 */
import { join, dirname, resolve } from 'node:path'
import { writeFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeApi, ensureDir, sleep } from '../../bench/lib/util.mjs'
import { ensureSimulator, simUp } from '../../bench/lib/sim.mjs'
import { SCENARIOS, ensureScenarioLine, provisionScenarioLine, readPvMean } from '../../bench/lib/scenarios.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }

const BASE = arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:3456')
const list = (arg('scenarios', 'injection') || 'injection').split(',').map(s => s.trim()).filter(id => SCENARIOS[id])
const TASK_TIMEOUT_MS = Number(arg('timeout-min', '32')) * 60_000
const KB_WAIT_MS = Number(arg('kb-wait-min', '6')) * 60_000
const POLL_MS = 20_000
const sfx = arg('sfx', `kb${new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')}`)

const rid = `kb-team-omp-${new Date().toISOString().slice(0, 19).replace(/[-T:]/g, '')}`
const outDir = ensureDir(join(REPO, 'bench', 'results', rid))
console.log(`=== kb-team × omp 闭环优化 × 多场景 ===\nbase=${BASE} scenarios=${list.join(',')} out=${outDir}\n`)

// ── 自举 ──
if (!(await simUp())) {
  const r = await ensureSimulator({ log: console.log })
  if (!r.started && !(await simUp())) { console.error(`✘ 模拟器自举失败: ${r.reason}`); process.exit(1) }
}
const api = makeApi(BASE)
const login = await api.login(process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', process.env.AW_ADMIN_PASSWORD ?? 'Awshop@123!')
if (!login.ok) { console.error('✘ 平台登录失败'); process.exit(1) }
console.log(`平台就绪(${login.how},role=${login.role});模拟器就绪\n`)

const globalResult = { rid, base: BASE, scenarios: [] }

for (const id of list) {
  const scen = SCENARIOS[id]
  const dir = ensureDir(join(outDir, id))
  const res = { scenario: id, zh: scen.zh, checks: {}, errors: [] }
  globalResult.scenarios.push(res)
  const log = (line) => { console.log(`[${id}] ${line}`); appendFileSync(join(dir, 'transcript.md'), `${line}\n`) }
  writeFileSync(join(dir, 'transcript.md'), `# ${scen.zh}(kb-team × omp)作业转录\n\n- 开始: ${new Date().toISOString()}\n- 频道模板: chtl-generic-optimize-default(enableKnowledgeBase=true)\n\n`)

  try {
    // ── ① 建场 + 建线 ──
    log(`① 模拟器建场 ${scen.key} …`)
    const ensure = await ensureScenarioLine(scen)
    log(`   设备=${ensure.verified.devices}/${ensure.verified.expectDevices} SP=${ensure.verified.sp} PV=${ensure.verified.pv} 协议=${ensure.verified.protocols.join('/')}`)
    const line = await provisionScenarioLine(api, scen, { sfx: `${sfx}-${id}` })
    if (line.errors?.length || !line.ids?.lineId) throw new Error(`建线失败: ${line.errors?.join(';')}`)
    res.line = { lineId: line.ids.lineId, recipeId: line.ids.recipeId, started: line.ids.started, reused: line.reused }
    log(`① 平台建线 ${line.lineName} started=${line.ids.started} dcw=${Object.keys(line.dcw).length} daq=${Object.keys(line.daq).length}`)

    // ── ② 实例化 KB 通用频道 ──
    const inst = (await api.call('POST', '/api/workshop/channel-templates/chtpl-generic-optimize-default/instantiate', {
      name: `KB闭环优化-${scen.zh}-${sfx}-${id}`,
      enableKnowledgeBase: true,
    }))
    const channelId = inst.data?.channelId
    if (!channelId) throw new Error(`频道实例化失败: ${inst.message}`)
    const agents = (await api.call('GET', `/api/workshop/channels/${channelId}/agents`)).data ?? []
    const lead = agents.find(a => a.role === 'lead')
    res.channel = { channelId, leadId: lead?.id, leadHarness: lead?.harness }
    log(`② 频道 ${channelId} 已实例化(lead=${lead?.name}/${lead?.harness},成员=${agents.length})`)

    // ── ③ lead 绑定 PV 数采 + 调节数控(auto) ──
    const pvNode = line.daq[scen.pv.sig]
    const knobSigs = (scen.knobs ?? []).map(k => k.sig).slice(0, 2)
    const knobNodes = knobSigs.map(s => line.dcw[s]).filter(Boolean)
    if (!pvNode || !knobNodes.length) throw new Error(`关键节点缺失: pv=${pvNode} knobs=${knobNodes}`)
    for (const [nodeId, kind] of [[pvNode, 'daq'], ...knobNodes.map(n => [n, 'dcw'])]) {
      const r = await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: lead.id, nodeId, kind, mode: 'auto' })
      if (r.status !== 200) throw new Error(`lead 绑定失败 ${kind} ${nodeId}: ${r.message}`)
    }
    res.leadBindings = { pvNode, knobNodes }
    log(`③ lead 绑定:daq(${scen.pv.sig})=${pvNode} dcw=${knobNodes.join(',')}`)

    // ── ④ 提交 goal ──
    const knobText = (scen.knobs ?? []).slice(0, 2).map(k => `${k.sig}`).join('、')
    const guardText = (scen.guards ?? []).map(g => `${g.label}≤${g.max}`).join('、') || '无'
    const goal = [
      `【产线闭环优化】${scen.zh}:${scen.story}`,
      `目标:把「${scen.pv.label}(${scen.pv.sig})」稳定控制回 ${scen.pv.target}±${scen.pv.tol}${scen.pv.unit} 目标带;守卫约束:${guardText}。`,
      `可调手段(数控节点,治理下发):${knobText}。`,
      `作业要求:`,
      `1. 开工先查知识库:lead 用 kb_agent(mode=sync) 检索「${scen.zh} 数据分析」「${scen.pv.label} 物理机理与设定影响」,把检索结论作为寻优方向与步长依据;`,
      `2. lead 把自己已绑定的节点授权授予 worker(dispatch_task 带 grant_node_ids 随任务授予,或 team_grant_nodes),确保工艺工程师与数据分析师各自拿到所需节点权限,不要无权限空转;`,
      `3. 工艺工程师单变量小步调整(每步 ≤ 量程 2%,尊重单步限幅与写入间隔),每次调整后等 ${Math.round(scen.settleMs / 1000)}s 再 daq_query 复测「${scen.pv.label}」;`,
      `4. 进入目标带且复测稳定后 dcw_judge 落判定(keep),lead 用 kb_agent(mode=async) 把本次经验沉淀入知识库(含调整前后参数值与响应数据),随后完成收口汇报。`,
    ].join('\n')
    const task = (await api.call('POST', `/api/workshop/channels/${channelId}/tasks`, { title: `${scen.zh}(KB 闭环)`, description: goal })).data
    if (!task?.id) throw new Error(`根任务提交失败`)
    res.rootTaskId = task.id
    log(`④ 根任务 ${task.id} 已提交,开始作业(超时 ${Math.round(TASK_TIMEOUT_MS / 60000)}min)…\n`)

    // ── ⑤ 轮询转录 ──
    let seenMsg = new Set()
    let seenTaskState = new Map()
    let lastEventSeq = 0
    let toolEvidence = { kbAgent: 0, grant: 0 }
    const t0 = Date.now()
    let terminal = null
    const dump = async () => {
      const msgs = (await api.call('GET', `/api/workshop/channels/${channelId}/messages?limit=200`)).data ?? []
      for (const m of [...msgs].reverse()) {
        const key = m.id ?? `${m.createdAt}:${m.fromAgentName}`
        if (seenMsg.has(key)) continue
        seenMsg.add(key)
        const who = m.fromAgentName ?? m.from ?? '?'
        const text = String(m.text ?? m.preview ?? '').slice(0, 600)
        if (text.trim()) appendFileSync(join(dir, 'transcript.md'), `\n> **${who}** @ ${m.createdAt ?? ''}\n>\n${text.split('\n').map(l => `> ${l}`).join('\n')}\n`)
      }
      const tasks = (await api.call('GET', `/api/workshop/channels/${channelId}/tasks`)).data ?? []
      const arr = Array.isArray(tasks) ? tasks : (tasks.tasks ?? [])
      for (const t of arr) {
        const st = `${t.id}:${t.state}:${t.progress ?? 0}`
        if (seenTaskState.get(t.id) !== st) {
          seenTaskState.set(t.id, st)
          appendFileSync(join(dir, 'transcript.md'), `\n- [任务] ${t.id} 「${t.title}」 state=${t.state} progress=${t.progress ?? 0}% assignee=${t.assigneeId ?? '-'}`)
        }
      }
      // 事件流:记录工具调用证据(kb_agent / team_grant_nodes / grant_node_ids)与 lead 进度报告
      const ev = (await api.call('GET', `/api/workshop/channels/${channelId}/events?limit=200&afterSeq=${lastEventSeq}`)).data ?? {}
      for (const item of (ev.items ?? [])) {
        lastEventSeq = Math.max(lastEventSeq, Number(item.seq ?? 0))
        const text = String(item.payload?.text ?? item.payload?.summary ?? '')
        if (!text) continue
        const kbHits = (text.match(/kb_agent/g) ?? []).length
        const grantHits = (text.match(/team_grant_nodes|grant_node_ids/g) ?? []).length
        toolEvidence.kbAgent += kbHits
        toolEvidence.grant += grantHits
        if (kbHits || grantHits) {
          appendFileSync(join(dir, 'transcript.md'), `\n- [工具证据] @ ${(item.at ?? item.createdAt ?? '').slice(11, 19)} ${text.replace(/\n+/g, ' ').slice(0, 220)}`)
        }
      }
      return { tasks: arr, msgs }
    }
    while (Date.now() - t0 < TASK_TIMEOUT_MS) {
      await sleep(POLL_MS)
      try {
        const { tasks } = await dump()
        const root = tasks.find(t => t.id === task.id)
        if (root && ['COMPLETED', 'FAILED', 'CANCELED'].includes(root.state)) { terminal = root; break }
        log(`… 作业中(${Math.round((Date.now() - t0) / 60000)}min)root=${root?.state ?? '?'}`)
      }
      catch (err) {
        log(`… 轮询抖动(忽略): ${err?.message ?? err}`)
      }
    }
    await dump()
    if (!terminal) { res.errors.push(`根任务超时(${Math.round(TASK_TIMEOUT_MS / 60000)}min)未收口`) }
    else if (terminal.state !== 'COMPLETED') { res.errors.push(`根任务终态=${terminal.state}`) }
    res.checks.rootTaskClosed = terminal?.state === 'COMPLETED'
    log(`\n⑤ 根任务终态=${terminal?.state ?? 'TIMEOUT'}`)

    // ── ⑥ 验收 ──
    const workers = agents.filter(a => a.role === 'worker')
    let delegated = 0
    for (const w of workers) {
      const bs = (await api.call('GET', `/api/workshop/agent-tools/bindings?agentId=${w.id}`)).data
      const flat = Array.isArray(bs) ? bs : (bs?.bindings ?? [])
      if (flat.some(b => b.grantedByAgentId === lead.id)) delegated++
    }
    res.checks.workerDelegated = delegated > 0
    log(`⑥ 委派核验:${delegated}/${workers.length} 个 worker 持有 lead 授予的节点授权`)

    const dcwNow = (await api.call('GET', '/api/workshop/dcw')).data?.nodes ?? []
    const myDcw = dcwNow.filter(n => Object.values(line.dcw).includes(n.id))
    const wrote = myDcw.some(n => n.lastWriteAt)
    res.checks.governedWriteHappened = wrote
    res.dcAfter = myDcw.map(n => ({ id: n.id, name: n.name, value: n.value, lastWriteAt: n.lastWriteAt ?? null }))
    log(`⑥ 治理写入核验:${wrote ? '发生过 dcw 治理写入' : '无 dcw 写入痕迹'}`)

    const pvMean = await readPvMean(api, pvNode, 5).catch(() => null)
    const inBand = pvMean != null && Math.abs(Number(pvMean) - scen.pv.target) <= scen.pv.tol
    res.checks.pvInBand = inBand
    res.pvMean = pvMean
    log(`⑥ PV 复测:均值=${pvMean} 目标带=${scen.pv.target}±${scen.pv.tol} → ${inBand ? '达标' : '未达标'}`)

    res.toolEvidence = toolEvidence
    res.checks.kbToolUsed = toolEvidence.kbAgent > 0
    res.checks.grantToolUsed = toolEvidence.grant > 0 || delegated > 0
    log(`⑥ 工具证据(事件流):kb_agent×${toolEvidence.kbAgent} 委派×${toolEvidence.grant}`)

    log(`⑥ 等待知识库经验沉淀可检索(≤${Math.round(KB_WAIT_MS / 60000)}min)…`)
    const kbQuery = encodeURIComponent(`${scen.zh.slice(0, 6)} ${scen.pv.label} 经验`)
    const kbDeadline = Date.now() + KB_WAIT_MS
    let kbHit = false
    while (Date.now() < kbDeadline) {
      await sleep(45_000)
      const sr = (await api.call('GET', `/api/plugins/rag-bridge/search?q=${kbQuery}&top_k=5`).catch(() => null))?.data
      if ((sr?.total_results ?? 0) > 0 || (sr?.results ?? []).length > 0) { kbHit = true; break }
      log(`   … 检索暂未命中(累计等待 ${Math.round((kbDeadline - Date.now()) / 60000)}min)`)
    }
    res.checks.kbExperience = kbHit
    log(`⑥ 知识库经验检索:${kbHit ? '已检出本场景经验内容' : '超时未检出(检索面后端索引漂移时以转录工具证据为准)'}`)
  }
  catch (err) {
    res.errors.push(String(err?.message ?? err))
    log(`✘ 异常: ${err?.message ?? err}`)
  }

  res.ok = res.errors.length === 0 && Object.values(res.checks).every(Boolean)
  log(`\n════ [${id}] 结果: ${res.ok ? 'PASS' : 'FAIL'} checks=${JSON.stringify(res.checks)}${res.errors.length ? ` errors=${res.errors.join(';')}` : ''}`)
  writeFileSync(join(dir, 'final.json'), JSON.stringify(res, null, 2))
}

writeFileSync(join(outDir, 'kb-team-omp-result.json'), JSON.stringify(globalResult, null, 2))
const allOk = globalResult.scenarios.every(s => s.ok)
console.log(`\n════ 总结果: ${allOk ? '✅ 全场景 PASS' : '❌ 存在 FAIL'}(明细: ${outDir})`)
process.exit(allOk ? 0 : 1)
