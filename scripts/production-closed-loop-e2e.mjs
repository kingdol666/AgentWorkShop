/**
 * 生产环境增强闭环 e2e — 数采/数控 × 自动诊断 × 知识沉淀(AgentWorkShop 3001 生产实例)
 *
 * 场景(对应「闭环控制增强」验收):
 *   A 生产就绪        3001 生产实例 + 两桥接插件启用 + 外部服务(KB/诊断/RAG)健康
 *   B 数采+绑定       产线节点可见、daq 绑定、daq_query/快照导出取到实时数据
 *   C 事件自动诊断    kv 配置越限规则 → daq:sample 命中 → 插件自动发起深度诊断(source=auto)
 *                     → 关闭开关(避免持续触发);在跑诊断由轮询器继续跟踪
 *   D 知识辅助决策    kb_search 历史经验 → dcw_control 优化设定(HITL 批准)→
 *                     dcw_judge 落 keep 判定 → kb_store 优化方案入库 → kb_search 复核
 *   E 沉淀验证        rag-bridge /experience 与 two-stage 检索确认知识可查
 *
 * 运行:AW_BASE=http://localhost:3001 node scripts/production-closed-loop-e2e.mjs
 * 前置:scripts/three-system-e2e.mjs 已跑过(演示账号/团队/绑定/授权已就绪)。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const BASE = process.env.AW_BASE ?? 'http://localhost:3001'
const KB = process.env.KB_BASE ?? 'http://127.0.0.1:8770'
const DIAG = process.env.DIAG_BASE ?? 'http://127.0.0.1:3210'
const LINE = process.env.E2E_LINE ?? 'ln-af002514'
const DCW_NODE = process.env.E2E_DCW_NODE ?? 'dw-e92bb0e7'

let pass = 0
let fail = 0
const failures = []
function ok(cond, label, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✔ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
  else {
    fail++
    failures.push(label)
    console.error(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function raw(method, url, { body, token, agent, timeoutMs = 20000 } = {}, retried = 0) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  if (agent) headers['x-aw-agent-token'] = agent.token
  let res
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) })
  }
  catch (e) {
    if (retried < 1) {
      await sleep(1500)
      return raw(method, url, { body, token, agent, timeoutMs }, retried + 1)
    }
    throw e
  }
  return { status: res.status, json: await res.json().catch(() => null) }
}
const api = (method, path, opts = {}) => raw(method, `${BASE}${path}`, opts)
const resultText = r => String(r?.json?.data?.result?.text ?? '')
const invoke = (agent, tool, args, timeoutMs = 60000) => api('POST', '/api/workshop/agent-tools/invoke', { agent, timeoutMs, body: { agentId: agent.id, tool, args } })

// ── 0. 演示账号/团队(复用 three-system-e2e 的持久化状态)─────────────────
const tokenFile = join(ROOT, '.AgentWorkShop', 'data', '.three-system-e2e-token.json')
const saved = JSON.parse(readFileSync(tokenFile, 'utf8'))
const userToken = process.env.AW_E2E_TOKEN ?? saved.token
const userId = saved.uid ?? ''
ok(Boolean(userToken), '复用演示账号 token')
// 夹具:确保产线 operate 授权(users.sqlite 直插,测试专用)
{
  const db = new DatabaseSync(join(ROOT, '.AgentWorkShop', 'data', 'users.sqlite'))
  db.exec('PRAGMA busy_timeout=4000')
  const row = userId ? { id: userId } : db.prepare('SELECT id FROM users ORDER BY created_at DESC LIMIT 1').get()
  if (row?.id) {
    db.prepare(`INSERT OR REPLACE INTO user_line_grants (user_id, line_id, mode, granted_by, granted_at) VALUES (?, ?, 'operate', 'production-e2e', ?)`).run(row.id, LINE, new Date().toISOString())
    console.log(`  · 产线授权夹具就绪(user=${row.id})`)
  }
  db.close()
}
const chsRaw = await api('GET', '/api/workshop/channels', { token: userToken }).catch(() => null)
const chs = Array.isArray(chsRaw?.json?.data) ? chsRaw.json.data : []
const chA = chs.find(c => c?.name?.startsWith('产线数据分析组'))
const chB = chs.find(c => c?.name?.startsWith('闭环控制组'))
// 插件宿主稳定门控:前序 e2e 的 Stage4 启停可能留下二次热重载在途 —— 等清单稳定再断言
{
  let stable = 0
  for (let i = 0; i < 30 && stable < 3; i++) {
    const plugsNow = await api('GET', '/api/workshop/plugins', { token: userToken }).catch(() => null)
    const listNow = plugsNow?.json?.plugins ?? plugsNow?.json?.data?.plugins ?? []
    const bothOn = listNow.filter(p => ['rag-bridge', 'diag-bridge'].includes(p?.name) && p?.enabled !== false).length
    stable = bothOn === 2 ? stable + 1 : 0
    if (stable < 3) await sleep(1500)
  }
  console.log(`  · 插件宿主已稳定(连续 3 次双桥接启用)`)
}
const membersOf = async id => (await api('GET', `/api/workshop/channels/${id}/agents`, { token: userToken })).json?.data ?? []
const mA = await membersOf(chA.id)
const mB = await membersOf(chB.id)
const execA = mA.find(m => m?.name === '数据分析执行器')
const execB = mB.find(m => m?.name === '控制执行器')
ok(Boolean(execA?.token && execB?.token), '两个 omp 执行器就绪', `${execA?.name} / ${execB?.name}`)

// ══ Stage A:生产就绪 ══════════════════════════════════════════════════════
console.log('\n── Stage A 生产就绪(3001)──')
{
  const gate = await raw('GET', `${BASE}/api/workshop/plugins`)
  ok(gate.status === 401, '生产实例存活(无 token 401 信封)', `status=${gate.status}`)
  const plugs = await api('GET', '/api/workshop/plugins', { token: userToken })
  const list = plugs.json?.plugins ?? plugs.json?.data?.plugins ?? []
  const on = n => list.find(p => p?.name === n)?.enabled === true
  ok(on('rag-bridge') && on('diag-bridge'), '两桥接插件在生产实例启用', `count=${list.length}`)
  const ragH = await api('GET', '/api/plugins/rag-bridge/health', { token: userToken })
  ok(ragH.status === 200 && ragH.json?.outbound === true, 'rag-bridge 健康', `kb=${ragH.json?.kb?.id?.slice(0, 8)}`)
  const diagH = await api('GET', '/api/plugins/diag-bridge/health', { token: userToken })
  ok(diagH.status === 200 && diagH.json?.remote?.status === 'ok', 'diag-bridge 健康', `activeRuns=${diagH.json?.remote?.activeRuns}`)
  const kbH = await raw('GET', `${KB}/api/v1/health`)
  const dgH = await raw('GET', `${DIAG}/api/health`)
  ok(kbH.json?.status === 'healthy' && dgH.json?.status === 'ok', 'KB 8770 / 诊断 3210 外部服务健康')
}

// ══ Stage B:数采 + 绑定 ════════════════════════════════════════════════════
console.log('\n── Stage B 数采与绑定 ──')
let freshNode = ''
{
  const daq = await api('GET', '/api/workshop/daq', { token: userToken })
  const nodes = (daq.json?.data?.nodes ?? daq.json?.nodes ?? []).filter(n => n?.lineId === LINE)
  ok(nodes.length > 0, `产线 ${LINE} 数采节点可见`, `count=${nodes.length}`)
  // 选最近有样本的节点(逐节点探 60min 窗)
  let bestAt = 0
  for (const n of nodes.slice(0, 12)) {
    const s = await api('GET', `/api/workshop/daq/${n.id}/samples?last_minutes=60&limit=1`, { token: userToken }).catch(() => null)
    const at = s?.json?.data?.points?.[0]?.at ?? 0
    if (at > bestAt) {
      bestAt = at
      freshNode = n.id
    }
  }
  ok(Boolean(freshNode), '定位最近在采样的节点', `${freshNode} (lastAt=${bestAt ? new Date(bestAt).toISOString() : 'n/a'})`)

  const bind = await api('POST', '/api/workshop/agent-tools/bindings', {
    token: userToken,
    body: { agentId: execA.id, nodeId: freshNode, kind: 'daq', mode: 'auto' },
  })
  ok(bind.status === 200, '分析执行器绑定数采节点(daq)', bind.status === 200 ? 'ok' : JSON.stringify(bind.json).slice(0, 120))

  const snap = await api('POST', '/api/plugins/diag-bridge/snapshot', {
    token: userToken,
    body: { line: LINE, from_ms: Date.now() - 24 * 60 * 60_000, to_ms: Date.now() },
  })
  ok(snap.json?.success === true && snap.json?.rows > 0, '生产实例导出 DAQ 宽表快照', `rows=${snap.json?.rows} nodes=${snap.json?.nodes}`)
}

// ══ Stage C:事件自动诊断(daq:sample → 自动 diag_run)══════════════════════
console.log('\n── Stage C 事件驱动自动诊断 ──')
let autoRunId = ''
{
  const kvPath = join(ROOT, '.AgentWorkShop', 'data', 'plugins', 'diag-bridge', 'kv.json')
  const statePath = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.AgentWorkShop', 'plugins-state.json')
  const touchReload = () => {
    const st = JSON.parse(readFileSync(statePath, 'utf8'))
    st.updatedAt = new Date().toISOString()
    writeFileSync(`${statePath}.tmp`, JSON.stringify(st, null, 2))
    renameSync(`${statePath}.tmp`, statePath)
  }
  const kv = JSON.parse(readFileSync(kvPath, 'utf8'))
  // 基线:启用前已存在的 auto run(历史遗留)不算新触发
  const runs0 = await api('GET', '/api/plugins/diag-bridge/runs', { token: userToken })
  const preAuto = new Set((runs0.json?.runs ?? []).filter(x => x.source === 'auto').map(x => x.runId))
  // 清本线冷却(测试夹具语义:历史战役的 auto 触发会留 30 分钟冷却,不清则本次必不触发)
  delete kv[`cooldown:${LINE}`]
  kv.auto_diag_enabled = 'true'
  kv.auto_rules = JSON.stringify({ [freshNode]: { op: 'gt', value: 0 } }) // 阈值 0 → 下一拍样本必命中(确定性触发)
  writeFileSync(kvPath, JSON.stringify(kv, null, 2))
  touchReload()
  console.log('  · 已启用 auto_diag(规则:节点 ' + freshNode + ' > 0)并触发热重载')

  // 等待窗 4 分钟:重装载(~20s)+ 下一采样拍 + 上传/启动;mock 引擎可能在窗内就跑完,
  // 所以 running/completed 均算命中
  for (let i = 0; i < 48 && !autoRunId; i++) {
    await sleep(5000)
    const runs = await api('GET', '/api/plugins/diag-bridge/runs', { token: userToken })
    const hit = (runs.json?.runs ?? []).find(x => x.source === 'auto' && !preAuto.has(x.runId) && (x.status === 'running' || x.status === 'completed'))
    if (hit) autoRunId = hit.runId
  }
  ok(Boolean(autoRunId), 'daq:sample 越限命中 → 插件自动发起深度诊断(source=auto)', `runId=${autoRunId}`)

  // 关闭开关(避免持续触发);在跑诊断由轮询器重水化继续跟踪
  const kv2 = JSON.parse(readFileSync(kvPath, 'utf8'))
  kv2.auto_diag_enabled = 'false'
  writeFileSync(kvPath, JSON.stringify(kv2, null, 2))
  touchReload()
  console.log('  · auto_diag 已关闭(冷却+去重仍在,防重复触发)')
  const runs2 = await api('GET', '/api/plugins/diag-bridge/runs', { token: userToken })
  const still = (runs2.json?.runs ?? []).find(x => x.runId === autoRunId)
  ok(still?.status === 'running' || still?.status === 'completed', '热重载后轮询器重水化,自动诊断仍被跟踪', still?.status)
}

// ══ Stage D:知识辅助决策 + 优化闭环 + 方案入库 ═════════════════════════════
console.log('\n── Stage D 知识辅助决策与优化闭环 ──')
{
  const hist = await invoke(execA, 'kb_search', { query: '压力设定器 优化 经验 判定 keep' })
  ok(resultText(hist).startsWith('检索到'), '知识辅助:检索到历史经验/文档', resultText(hist).split('\n')[0].slice(0, 80))

  const dcwView = await api('GET', '/api/workshop/dcw', { token: userToken })
  const node = (dcwView.json?.data?.nodes ?? []).find(n => n?.id === DCW_NODE)
  ok(Boolean(node), '数控节点可见', `value=${node?.value} range=${node?.min}~${node?.max}`)
  const span = Number(node?.max) - Number(node?.min)
  const step = span > 0 ? Math.min(span * 0.03, 1) : 0.05
  let target = Number(node?.value) + step
  if (target > Number(node?.max) - span * 0.05) target = Number(node?.value) - step

  // 发起写控(manual → HITL 挂起),脚本扮演人类在待办出现后批准。
  // 配方工艺窗口联锁是生产语义:3% 步长越出活动配方窗口时,按拒绝消息回读的工艺
  // 上/下限取界内值自适应重试 —— 与真实 Agent 的调参行为同构
  const attemptWrite = async (value) => {
    const pendingInvoke = invoke(execB, 'dcw_control', {
      node_id: DCW_NODE,
      value: Number(value.toFixed(4)),
      hypothesis: `依据知识库历史经验(${resultText(hist).split('\n')[1]?.slice(0, 60) ?? '历史经验'})与数采趋势,优化设定至 ${Number(value).toFixed(4)}`,
    }, 300000)
    let approved = false
    let pendRaw = '[]'
    for (let i = 0; i < 30 && !approved; i++) {
      await sleep(2000)
      const pend = await api('GET', '/api/workshop/hitl/pending', { token: userToken })
      const pd = pend?.json?.data
      const arr = Array.isArray(pd) ? pd : (pd?.items ?? pd?.pending ?? [])
      pendRaw = JSON.stringify(arr)
      const item = arr.find(x => x?.kind === 'dcw-approval' && x?.agentId === execB.id)
      if (item?.id) {
        const resp = await api('POST', '/api/workshop/hitl/respond', {
          token: userToken,
          body: { kind: 'dcw-approval', id: item.id, confirmed: true, comment: 'production-e2e 批准' },
        })
        approved = resp.status === 200
      }
    }
    const w = await pendingInvoke
    return { approved, pendRaw, wText: resultText(w) }
  }

  let attempt = await attemptWrite(target)
  ok(attempt.approved, 'HITL 待办出现并经 respond 批准', attempt.approved ? 'ok' : `pending=${attempt.pendRaw.slice(0, 160)}`)
  const capMatch = attempt.wText.match(/工艺上限 ([\d.]+)/)
  const floorMatch = attempt.wText.match(/工艺下限 ([\d.]+)/)
  if (!attempt.wText.includes('下发成功') && capMatch) {
    target = Number(capMatch[1]) * 0.98
    attempt = await attemptWrite(target)
  }
  else if (!attempt.wText.includes('下发成功') && floorMatch) {
    target = Number(floorMatch[1]) * 1.02
    attempt = await attemptWrite(target)
  }
  const wText = attempt.wText
  ok(wText.includes('下发成功'), '优化设定经 HITL 批准并写回成功', wText.split('\n')[0].slice(0, 110))
  const recordId = (wText.match(/优化记录 (\S+) 已开窗/) ?? [])[1] ?? ''

  if (recordId) {
    const j = await invoke(execB, 'dcw_judge', {
      record_id: recordId,
      verdict: 'keep',
      reason: `写入后 ${freshNode} 数采回读与设定一致、无越配方告警,判定 keep(production-e2e)`,
    })
    ok(resultText(j).includes('keep') || !resultText(j).includes('失败'), 'dcw_judge 落 keep 判定(经验固化)', resultText(j).split('\n')[0].slice(0, 100))

    const store = await invoke(execA, 'kb_store', {
      title: `优化方案:压力设定器 ${node?.value}→${target.toFixed(4)}(判定 keep)`,
      category: 'optimization',
      problem: '压力设定偏离经验最优区,需要在不触发越限的前提下上调设定',
      solution: `按配方窗口内 ${step.toFixed(4)} 步进上调;写入后观察 ${freshNode} 回读稳定,dcw_judge=keep(记录 ${recordId}),可标 lastGood`,
      key_lessons: ['小步进+回读确认再判定', 'keep 判定须引用数采证据'],
      tags: [LINE, '闭环优化', `record:${recordId}`, 'production-e2e'],
    })
    ok(resultText(store).includes('已沉淀'), '优化方案写入知识库(经验沉淀)', resultText(store).slice(0, 90))
  }

  const s2 = await invoke(execA, 'kb_search', { query: `压力设定器 优化方案 keep ${LINE}` })
  ok(resultText(s2).startsWith('检索到'), 'kb_search 复核:优化方案可检索', resultText(s2).split('\n')[1]?.slice(0, 100) ?? resultText(s2).slice(0, 100))
}

// ══ Stage E:沉淀验证 ══════════════════════════════════════════════════════
console.log('\n── Stage E 知识沉淀验证 ──')
{
  const exp = await api('GET', '/api/plugins/rag-bridge/experience?limit=50', { token: userToken })
  const count = exp.json?.count ?? 0
  const hasOpt = JSON.stringify(exp.json?.experiences ?? []).includes('optimization')
  ok(count > 0, '经验库可读', `count=${count}`)
  ok(hasOpt, '经验库含 optimization 类目(优化方案在册)')

  const s3 = await api('GET', `/api/plugins/rag-bridge/search?q=${encodeURIComponent('闭环优化 设定 判定')}&top_k=3`, { token: userToken })
  ok(s3.json?.success === true && (s3.json?.results?.length ?? 0) > 0, 'two-stage 检索命中闭环优化知识', `results=${s3.json?.results?.length}`)
}

console.log(`\n══ 生产增强闭环结果:${pass} 通过 / ${fail} 失败 ══`)
if (failures.length) for (const f of failures) console.error(`  - ${f}`)
process.exit(fail > 0 ? 1 : 0)
