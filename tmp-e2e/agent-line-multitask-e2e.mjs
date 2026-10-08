/**
 * Agent 集成产线 · 多任务目标端到端大考(2026-10-08)。
 *
 * 被测主体 = worker Agent(52b5eb4d,omp 真实 harness 语义的工具桥直调)× 注塑一线
 * (ln-5b12e11a,modbus-tcp 写控 + mes-rest 直取 + 镜像数采)。全部作业以 **Agent 工具
 * 调用**完成(REST 只做观测/裁决/协议矩阵),流程 = 真实产线作业剧本:
 *   T1 闭环优化作业  line_context → daq_query 观测 → recipe_propose(五要素) → HITL 批准 → 设备证实 → 复测
 *   T2 产线微调作业  recipe_update(固化新版本) → recipe_apply(整批下发) → 6/6 设备证实
 *   T3 回退作业      recipe_versions → recipe_rollback(dispatch=true 整批重下发) → 设备证实恢复
 *   T4 数据分析作业  daq_export 全窗宽表 + ops_log 自查 + recipe_log 变更史
 *   T5 多协议读面    Agent daq_query(绑定节点) + REST 协议族矩阵(opcua/mqtt/http/modbus-rtu)
 *   T6 治理负路径    未绑定配方被拒 / 越界参数预检剔除 / 下发频控早拒(治理在岗)
 * 前置: 基准线存在且运行中;worker 配方绑定为 manual(每次动作挂审批,脚本并行裁决=人批准)。
 */
import benchCfg from '../scripts/testing/benchmark.config.json' with { type: 'json' }

const cfg = benchCfg
const BASE = 'http://127.0.0.1:3001'
const WORKER = cfg.workerId
const checks = []
let TOKEN = ''

function ok(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail: String(detail).slice(0, 150) })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${String(detail).slice(0, 150)}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  let j = null
  try {
    j = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...(j ?? {}) }
}

/** Agent 工具直调(工具桥;返回 { text, isError }) */
async function inv(tool, args, timeoutMs = 180_000) {
  const res = await fetch(BASE + '/api/workshop/agent-tools/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ agentId: WORKER, tool, args }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await res.json().catch(() => ({}))
  return j?.data?.result ?? { text: JSON.stringify(j?.data ?? j).slice(0, 200), isError: j?.code !== 0 }
}

/** 并行裁决:invoke 挂起的审批卡出现后按人工口径批准/拒绝。
 *  choice:整包方案(recipe-propose 结构化单)批准必须携带方案序号 —— 否则 fail-closed
 *  归一按拒绝收敛(铁律:多方案批准未选包=拒绝);单动作 recipe-gate 单无需 choice。 */
async function adjudicate(pattern, approved, comment, choice) {
  let card = null
  for (let i = 0; i < 45 && !card; i++) {
    await sleep(1000)
    const pend = await api('GET', '/api/workshop/hitl/pending')
    const items = pend?.data?.items ?? []
    card = items.filter(x => x.kind === 'dcw-approval' && pattern.test(String(x.nodeId ?? '')))
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
  }
  if (!card) return null
  await api('POST', '/api/workshop/hitl/respond', {
    kind: 'dcw-approval', id: card.id, confirmed: approved, comment,
    ...(Number.isInteger(choice) ? { choice } : {}),
  })
  return card
}

// ================= 登录与前置 =================
const login = await api('POST', '/api/users/login', { email: cfg.account.email, password: cfg.account.password })
TOKEN = login?.data?.token ?? ''
ok('登录 + 环境就绪', !!TOKEN, `line=${cfg.lineId} recipe=${cfg.recipeId}`)

const pre = await api('GET', '/api/workshop/dcw')
const line = (pre?.data?.lines ?? []).find(l => l.id === cfg.lineId)
const active = (pre?.data?.lineStates ?? []).find(s => s.lineId === cfg.lineId)?.active
ok('T0 基准线在册且运行中', !!line && active === true, `${line?.name} mode=${line?.controlMode} active=${active}`)

// ================= T1 闭环优化作业(Agent 全流程) =================
console.log('\n── T1 闭环优化作业:观测→决策→五要素提案→HITL→下发→复测 ──')
const ctx = await inv('line_context', {})
ok('T1.1 line_context:Agent 看到产线/配方上下文', !ctx.isError && String(ctx.text).includes(cfg.recipeId.slice(0, 8)), String(ctx.text).slice(0, 90))

const now = Date.now()
const obs = await inv('daq_query', { node_id: cfg.nodes.daq.weight, from_ms: now - 300_000, to_ms: now, bucket_ms: 30_000 })
const obsTxt = String(obs.text ?? '')
ok('T1.2 daq_query 观测:镜像克重有数(8min 窗)', !obs.isError && /\d/.test(obsTxt), obsTxt.slice(0, 90))

const curNode = (pre?.data?.nodes ?? []).find(n => n.id === cfg.nodes.dcw.holdP)
const cur = Number(curNode?.value ?? 63)
const to = cur > cfg.benchmark.anchorSetpoint ? cur - 1 : cur + 1
const pkg = {
  name: `MT-保压${to > cur ? '微升' : '微降'}步`,
  rationale: `多任务大考 T1:镜像克重观测有效,做有界激励步实证闭环链路(目标 ${cfg.target.center}±${cfg.target.deadband})`,
  params: [{ node_id: cfg.nodes.dcw.holdP, to, basis: `单变量小步 ${cur}→${to}(≤步限 ${cfg.limits.holdP.step}bar)`, exp_ref: 'KB:R1/R2 方向性实证;T1 观测窗均值' }],
}
// 节拍自适应(与基准 PIPELINE 同口径):被 300s 试验节拍/60s 间隔拦下时按提示等待后重提
let propTxt = ''
let card1 = null
for (let atmp = 1; atmp <= 2; atmp++) {
  const propP = inv('recipe_propose', { recipe_id: cfg.recipeId, packages: [pkg], emergency: true }, 300_000)
  card1 = await adjudicate(/^recipe-propose:/, true, 'T1 自动裁决:批准该闭环步(选定方案 #0)', 0)
  const prop = await propP
  propTxt = String(prop.text ?? '')
  if (card1 && /设备证实/.test(propTxt)) break
  const waitSec = Number(/请等待约?\s*(\d+)s/.exec(propTxt)?.[1] ?? 0)
  if (waitSec > 0 && atmp < 2) {
    console.log(`  (T1 提案被节拍窗拦下,等 ${waitSec + 5}s 后重提…)`)
    await sleep((waitSec + 5) * 1000)
    continue
  }
  break
}
ok('T1.3 recipe_propose:审批卡挂起并获批', !!card1, card1 ? `${card1.id}` : '(未见卡)')
ok('T1.4 整批下发回执:全部参数设备证实', /设备证实/.test(propTxt) && !/未获批准|间隔卡控|节拍/.test(propTxt), propTxt.split('\n')[0]?.slice(0, 110))
const t1RunId = /runId[:：]\s*(rr-[\w-]+)/.exec(propTxt)?.[1] ?? ''
ok('T1.5 回执携带 runId(后续轮次回访锚)', !!t1RunId, t1RunId)
await sleep(15_000)
const post = await inv('daq_query', { node_id: cfg.nodes.daq.spMirror, from_ms: Date.now() - 60_000, to_ms: Date.now(), bucket_ms: 5_000 })
ok('T1.6 下发后镜像 SP 复测跟上', !post.isError && /\d/.test(String(post.text)), String(post.text).slice(0, 80))

// ================= T2 产线微调作业(recipe_update 固化 → recipe_apply 整批) =================
console.log('\n── T2 产线微调作业:固化版本 → 整批下发 ──')
await sleep(61_000) // opIntervalMs 频控:距 T1 已批下发须 ≥60s(治理在岗,如实等待)
const updP = inv('recipe_update', {
  recipe_id: cfg.recipeId,
  params: [{ node_id: cfg.nodes.dcw.holdP, value: to }],
  reason: `T2 微调作业:固化 T1 激励步结果 ${cur}→${to}(有界激励,不改变工艺目标)`,
}, 300_000)
await adjudicate(/^recipe:/, true, 'T2 自动裁决:批准版本固化')
const upd = await updP
ok('T2.1 recipe_update:人工批准后固化新版本', /已保存为 v\d+/.test(String(upd.text)) && !upd.isError, String(upd.text).split('\n')[0]?.slice(0, 100))

await sleep(61_000) // 频控等待
// 空闲巡检(~150s 周期)会停掉无任务 worker 的 runtime:挂起等待审批的回合被按设计
// fail-closed 收敛(「回合已被中止,审批失效」)并指引重新提交 —— 治理语义正确。
// e2e 模拟 Agent 的恢复行为:被巡检收敛则重提一次(重提=新的回合+新的审批卡)。
let appTxt = ''
let card3 = null
for (let atmp = 1; atmp <= 2; atmp++) {
  const appP = inv('recipe_apply', { recipe_id: cfg.recipeId, reason: `T2 微调作业:把固化版本整批下发到产线(第 ${atmp} 次提交)` }, 300_000)
  card3 = await adjudicate(/^recipe:/, true, 'T2 自动裁决:批准整批下发')
  const app = await appP
  appTxt = String(app.text ?? '')
  if (!/回合已被中止/.test(appTxt)) break
  console.log(`  (第 ${atmp} 次提交被空闲巡检收敛,按指引重提…)`)
  await sleep(3000)
}
ok('T2.2 recipe_apply:人工批准后整批下发', !!card3 && /设备证实/.test(appTxt), appTxt.split('\n')[0]?.slice(0, 110))
ok('T2.3 全参数设备证实(modbus+mes-rest 混合配方)', /全部设备证实\((\d+)\/\1/.test(appTxt), appTxt.split('\n')[0]?.slice(0, 110))

// ================= T3 回退作业(定义回退 + PLC 整批恢复) =================
console.log('\n── T3 回退作业:版本复核 → 统一回退(dispatch=true) ──')
await sleep(61_000) // 频控等待
const verP = inv('recipe_versions', { recipe_id: cfg.recipeId })
const ver = await verP
ok('T3.1 recipe_versions:版本史可读', !ver.isError && /v\d+/.test(String(ver.text)), String(ver.text).split('\n')[0]?.slice(0, 90))

const rbP = inv('recipe_rollback', {
  recipe_id: cfg.recipeId,
  to_last_good: true,
  dispatch: true,
  reason: 'T3 回退作业:恢复到已知良好批次冻结参数(整批重下发)',
}, 300_000)
const card4 = await adjudicate(/^recipe:/, true, 'T3 自动裁决:批准统一回退')
const rb = await rbP
const rbTxt = String(rb.text ?? '')
ok('T3.2 recipe_rollback(dispatch=true):回退+整批重下发设备证实', !!card4 && /设备证实|全部设备证实/.test(rbTxt) && !rb.isError, rbTxt.split('\n')[0]?.slice(0, 110))

// ================= T4 数据分析作业(导出/自查/变更史) =================
console.log('\n── T4 数据分析作业:全窗导出 → 审计自查 → 变更史 ──')
const exp = await inv('daq_export', { node_ids: `${cfg.nodes.daq.weight},${cfg.nodes.daq.spMirror}`, from_ms: Date.now() - 3_600_000, to_ms: Date.now() }, 180_000)
ok('T4.1 daq_export:Agent 全窗宽表导出', !exp.isError && /daqexp-|rows|行/.test(String(exp.text)), String(exp.text).slice(0, 90))
const audit = await inv('ops_log', { minutes: 60, limit: 20 })
const auditTxt = String(audit.text ?? '')
ok('T4.2 ops_log:Agent 自查本轮作业留痕(提案/下发/回退可见)', !audit.isError && /recipe\.|下发/.test(auditTxt), auditTxt.slice(0, 90))
const rlog = await inv('recipe_log', { recipe_id: cfg.recipeId, limit: 10 })
ok('T4.3 recipe_log:配方变更史可读(版本/归因)', !rlog.isError && /v\d+|版本/.test(String(rlog.text)), String(rlog.text).slice(0, 90))

// ================= T5 多协议读面(Agent 读 + REST 协议族矩阵) =================
console.log('\n── T5 多协议读面 ──')
const aq1 = await inv('daq_query', { node_id: cfg.nodes.daq.weight, from_ms: Date.now() - 300_000, to_ms: Date.now(), bucket_ms: 30_000 })
const aq2 = await inv('daq_query', { node_id: cfg.nodes.daq.spMirror, from_ms: Date.now() - 300_000, to_ms: Date.now(), bucket_ms: 30_000 })
ok('T5.1 Agent daq_query:绑定节点双通道有数', !aq1.isError && !aq2.isError, 'weight+spMirror 两通道')
const agg = await api('GET', '/api/workshop/daq')
const famNodes = []
for (const n of (agg?.data?.nodes ?? [])) {
  if (!n.lineId || !n.id.startsWith('dn-')) continue
  famNodes.push(n)
}
const byName = kw => (agg?.data?.nodes ?? []).filter(n => String(n.name ?? '').includes(kw)).slice(0, 2)
const probeFam = async (kw, kind) => {
  const nodes = byName(kw)
  let alive = 0
  for (const n of nodes) {
    const r = await api('GET', `/api/workshop/daq/${n.id}/samples?from=${Date.now() - 300_000}&to=${Date.now()}&bucketMs=30000`)
    if ((r?.data?.points ?? []).length >= 3) alive++
  }
  return { kw, kind, alive, total: nodes.length }
}
const fams = []
for (const [kw, kind] of [['挤出主机PLC', 'modbus-tcp'], ['晶点计数', 'modbus-rtu'], ['熔体泵送', 'opcua'], ['在线测厚仪', 'mqtt'], ['CCD检测站', 'http']]) {
  fams.push(await probeFam(kw, kind))
}
const famPass = fams.filter(f => f.alive > 0).length
ok('T5.2 协议族矩阵 5 族在采(modbus-tcp/rtu/opcua/mqtt/http)', famPass === 5, fams.map(f => `${f.kind}:${f.alive}/${f.total}`).join(' '))

// ================= T6 治理负路径(Agent 视角) =================
console.log('\n── T6 治理负路径 ──')
const noBinding = await inv('recipe_trial', { recipe_id: 'rc-notexist', params: [{ node_id: cfg.nodes.dcw.holdP, value: 63 }], hypothesis: 'T6 负路径' })
ok('T6.1 未绑定/不存在配方操作被拒', noBinding.isError === true || /不存在|无权|未绑定/.test(String(noBinding.text)), String(noBinding.text).slice(0, 80))
// 频控探针先打:紧随 T3 已批下发(<60s)→ 提案早拒(频控在预检之前,治理顺序即如此)
const freq = await inv('recipe_apply', { recipe_id: cfg.recipeId, reason: 'T6 频控探针:紧随 T3 下发,应被 60s 间隔早拒' })
ok('T6.2 下发频控早拒(距上次已批下发 <60s 被拦,治理在岗)', /间隔|等待/.test(String(freq.text)) && freq.isError, String(freq.text).slice(0, 90))
// 越界探针:等频控窗放行后提交 —— 此时应命中预检剔除(批准必被拒包不可达)
console.log('  (等 61s 频控窗放行后验证越界预检…)')
await sleep(61_000)
const oob = await inv('recipe_propose', {
  recipe_id: cfg.recipeId,
  packages: [{ name: 'T6 越界探针', rationale: '负路径:越界参数必须被预检剔除', params: [{ node_id: cfg.nodes.dcw.holdP, to: 999, basis: '越界探针', exp_ref: 'T6' }] }],
})
ok('T6.3 越界参数预检剔除(批准必被拒包不可达)', /预检失败|剔除|无一参数通过/.test(String(oob.text)) && oob.isError, String(oob.text).split('\n')[0]?.slice(0, 90))

// ================= T7 收尾:恢复基准锚 + 参数面完整性(防套件间状态污染) =================
// T3 回退到 lastGood 会:①把 holdP 恢复到旧值(偏离 benchmark.anchorSetpoint);
// ②把配方整体替换为旧版参数集 —— mesDirect(dw-cdbf5feb)若晚于该版本加入,会被剪除
// (实测:mes_fetch 随之"无权访问"、整批下发 6/6→5/5)。REST 直写回锚会被步限拦
// (45→63 一跳 >stepLimit 8),故走配方路:recipe_update 固化目标态 → recipe_apply 整批下发。
console.log('\n── T7 收尾:恢复基准锚 + 参数面完整性(配方路)──')
const MES_DIRECT_VALUE = 185 // 历史运行值(write 账本:注塑·MES温度设定(直取)→ 185℃)
const upd7P = inv('recipe_update', {
  recipe_id: cfg.recipeId,
  params: [
    { node_id: cfg.nodes.dcw.holdP, value: cfg.benchmark.anchorSetpoint },
    { node_id: cfg.nodes.dcw.mesDirect, value: MES_DIRECT_VALUE },
  ],
  reason: `T7 收尾:恢复基准锚 ${cfg.benchmark.anchorSetpoint}bar + 补回 lastGood 回退剪除的 MES 直取参数`,
}, 300_000)
await adjudicate(/^recipe:/, true, 'T7 自动裁决:批准恢复基线')
const upd7 = await upd7P
ok('T7.1 recipe_update:基线恢复版本固化(锚 + mesDirect 参数面)', /已保存为 v\d+/.test(String(upd7.text)) && !upd7.isError, String(upd7.text).split('\n')[0]?.slice(0, 110))
let app7Txt = ''
for (let atmp = 1; atmp <= 2; atmp++) {
  const app7P = inv('recipe_apply', { recipe_id: cfg.recipeId, reason: `T7 收尾:整批下发恢复基线(第 ${atmp} 次提交)` }, 300_000)
  await adjudicate(/^recipe:/, true, 'T7 自动裁决:批准基线下发')
  const app7 = await app7P
  app7Txt = String(app7.text ?? '')
  if (!/回合已被中止/.test(app7Txt) && !/间隔卡控/.test(app7Txt)) break
  console.log(`  (第 ${atmp} 次提交被收敛/频控,等待后重试…)`)
  await sleep(61_000)
}
ok('T7.2 recipe_apply:基线整批下发并全部设备证实(6/6 含 mesDirect)', /全部设备证实\(6\/6/.test(app7Txt) && !/间隔卡控/.test(app7Txt), app7Txt.split('\n')[0]?.slice(0, 110))

// ================= 汇总 =================
const pass = checks.filter(c => c.pass).length
console.log(`\n======== Agent 产线多任务 e2e:${pass}/${checks.length} ========`)
for (const c of checks.filter(c => !c.pass)) console.log(`  FAIL: ${c.name} — ${c.detail}`)
process.exit(pass === checks.length ? 0 : 1)
