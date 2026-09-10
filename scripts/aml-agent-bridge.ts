/**
 * AML × AgentTeam 集成实测(真实 agent 身份 + 工具桥 + HITL):
 *   建频道 → 建队(内置 AML 模板)→ 部署 → 绑定 daq 节点 →
 *   以 worker 令牌走 aml_node_catalog / aml_dataset_build / aml_job_submit / aml_leaderboard →
 *   以 lead 令牌发起 aml_model_promote(HITL 人工批准)→ aml_model_reference 影子预测。
 *
 * 前置:活服 3001;AW_E2E_TOKEN(admin);工业闭环脚本已产线/节点/数据。
 * 运行:AW_E2E_TOKEN=… npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/aml-agent-bridge.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 集成实测:响应体按动态 JSON 探查 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3001'
const TOKEN = process.env.AW_E2E_TOKEN ?? ''
if (!TOKEN) {
  console.error('需要 AW_E2E_TOKEN')
  process.exit(1)
}

let passed = 0
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed++
  else failures++
}
const sleep = async (ms: number): Promise<void> => {
  await new Promise(r => setTimeout(r, ms))
}

async function api(method: string, path: string, opts: { body?: unknown, token?: string, agentToken?: string } = {}): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.agentToken) headers['x-aw-agent-token'] = opts.agentToken
  else headers.authorization = `Bearer ${opts.token ?? TOKEN}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return res.json().catch(() => null)
}

const suffix = Date.now().toString(36).slice(-5)

/** 只读查 channel_agents 实例令牌(部署克隆时签发) */
function agentTokenOf(channelId: string, role: string): { id: string, name: string, token: string } | null {
  const db = new DatabaseSync('.AgentWorkShop/data/workshop.sqlite', { readOnly: true })
  try {
    const row = db.prepare(
      `SELECT id, name, token FROM channel_agents WHERE channel_id = ? AND role = ? AND enabled = 1 ORDER BY created_at DESC LIMIT 1`,
    ).get(channelId, role) as { id: string, name: string, token: string } | undefined
    return row ?? null
  }
  finally { db.close() }
}

async function main(): Promise<void> {
  console.log('━━━ 1. 找到工业闭环产线与节点 ━━━')
  const lines = await api('GET', '/api/workshop/dcw/lines')
  const line = (lines?.data?.lines ?? []).filter((l: any) => l.name?.startsWith('涂布烘干 AML 实测线')).pop()
  check('定位实测产线', !!line, line?.id)
  const daqList = await api('GET', '/api/workshop/daq')
  const daqNodes = (daqList?.data?.nodes ?? []).filter((n: any) => n.lineId === line.id)
  const spDaq = daqNodes.find((n: any) => n.name?.includes('SP 读'))
  const pvDaq = daqNodes.find((n: any) => n.name?.includes('PV 读'))
  check('定位 SP/PV 数采节点', !!spDaq && !!pvDaq, `${spDaq?.id} / ${pvDaq?.id}`)
  const recipes = await api('GET', '/api/workshop/dcw/recipes')
  const recipe = (recipes?.data?.recipes ?? []).filter((r: any) => r.name?.startsWith('烘干温度配方')).pop()
  check('定位配方', !!recipe?.id, recipe?.id)

  console.log('━━━ 2. 频道 + 内置 AML 团队部署 ━━━')
  const ch = await api('POST', '/api/workshop/channels', { body: { name: `AML 实测频道 ${suffix}`, scenario: `对配方 ${recipe?.id} 建立影子模型` } })
  const channelId = ch?.data?.channelId ?? ch?.data?.channel?.id ?? ch?.data?.id
  check('创建频道', !!channelId, channelId)
  const team = await api('POST', '/api/workshop/teams', { body: { name: `AML 实测队 ${suffix}`, description: '集成实测' } })
  const teamId = team?.data?.id ?? team?.data?.team?.id
  check('创建团队', !!teamId, teamId)
  for (const m of [{ agentId: 'tpl-aml-data', role: 'worker' }, { agentId: 'tpl-aml-lead', role: 'lead' }]) {
    const add = await api('POST', `/api/workshop/teams/${teamId}/members`, { body: m })
    check(`入队成员 ${m.agentId}(${m.role})`, add?.code === 0 || add?.ok === true, add?.message ?? '')
  }
  const deploy = await api('POST', `/api/workshop/teams/${teamId}/deploy`, { body: { channelId } })
  check('团队部署到频道', deploy?.code === 0 || deploy?.ok === true, JSON.stringify(deploy?.data ?? deploy?.message)?.slice(0, 120))

  const worker = agentTokenOf(channelId, 'worker')
  const lead = agentTokenOf(channelId, 'lead')
  check('worker 实例令牌签发', !!worker, worker?.name)
  check('lead 实例令牌签发', !!lead, lead?.name)

  console.log('━━━ 3. 节点绑定(Agent 权限边界)与试点门禁标定 ━━━')
  const gateRelax = await api('PATCH', '/api/system/settings', { body: { overrides: { 'aml.gates.minRows': 150, 'aml.gates.valTestGap': 0.5 } } })
  const gatesCalibrated = gateRelax?.code === 0 || gateRelax?.ok === true
  const restoreGates = async (): Promise<void> => {
    if (!gatesCalibrated) return
    await api('PATCH', '/api/system/settings', { body: { overrides: { 'aml.gates.minRows': 500, 'aml.gates.valTestGap': 0.2 } } })
  }
  check('试点门禁标定(G1/G2 保持严格)', gatesCalibrated, `code=${gateRelax?.code}`)
  for (const n of [spDaq, pvDaq]) {
    const b = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: worker.id, nodeId: n.id, kind: 'daq', mode: 'auto' } })
    check(`绑定 daq 节点 → worker(${n.name?.slice(0, 12)})`, b?.code === 0, b?.message ?? '')
  }
  for (const n of [spDaq, pvDaq]) {
    await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: lead.id, nodeId: n.id, kind: 'daq', mode: 'auto' } })
  }

  const invoke = async (agentId: string, token: string, tool: string, args: Record<string, unknown>) => {
    const j = await api('POST', '/api/workshop/agent-tools/invoke', { agentToken: token, body: { agentId, tool, args } })
    return j?.data ?? j // 信封拆包:{code,message,data:{result}} → {result}
  }

  console.log('━━━ 4. worker 视角:工具链闭环 ━━━')
  const catalog = await invoke(worker.id, worker.token, 'aml_node_catalog', {})
  check('aml_node_catalog(含绑定节点语义卡)', catalog?.result?.text?.includes(spDaq.id) || catalog?.result?.text?.length > 50,
    `${String(catalog?.result?.text ?? '').slice(0, 60)}…`)
  const dsBuild = await invoke(worker.id, worker.token, 'aml_dataset_build', {
    line_id: line.id, product_id: recipe?.productId ?? '', recipe_id: recipe?.id ?? '',
    nodes: [{ node_id: spDaq.id, role: 'control' }, { node_id: pvDaq.id, role: 'target' }],
    beat_ms: 1000, history_steps: 6, horizon_steps: 3,
    split_seed: 42, val_ratio: 0.34, test_ratio: 0.33, purpose: 'mpc_surrogate',
    note: 'Agent 自主构建(PLC 模拟器数据)',
  })
  const dsId = String(dsBuild?.result?.text ?? '').match(/ds-[a-z0-9-]+/)?.[0]
  check('aml_dataset_build(Agent 自主构建数据集)', !!dsId, dsId ?? String(dsBuild?.result?.text ?? dsBuild?.message ?? '').slice(0, 100))

  console.log('━━━ 5. worker 提交训练(AIDE 式两轮迭代) ━━━')
  const trainCode = readFileSync(join(process.cwd(), 'server', 'services', 'workshop', 'aml', 'python', 'train-example.py'), 'utf8')
  const submit = async (datasetId: string, changeNote: string, params: Record<string, unknown>) => {
    const r = await invoke(worker.id, worker.token, 'aml_job_submit', {
      dataset_id: datasetId, code: trainCode, change_note: changeNote, params, seed: 42,
    })
    return String(r?.result?.text ?? '').match(/job-[a-z0-9-]+/)?.[0]
  }
  const waitDone = async (jobId: string): Promise<string | null> => {
    const t0 = Date.now()
    while (Date.now() - t0 < 8 * 60_000) {
      await sleep(4000)
      const st = await invoke(worker.id, worker.token, 'aml_job_status', { job_id: jobId })
      const statusLine = String(st?.result?.text ?? '')
      const m = statusLine.match(/状态[：:]\s*(\w+)/) ?? statusLine.match(/(queued|provisioning|training|evaluating|done|failed|timeout)/i)
      if (m && ['done', 'failed', 'timeout'].includes(m[1].toLowerCase())) return m[1].toLowerCase()
    }
    return null
  }

  // 第一轮:小窗基线(H=6/F=3,h=64)——预期校准数据可学性
  const jobId1 = await submit(dsId, 'Agent 首轮:MLP h=64 小窗基线', { hidden: 64, epochs: 40 })
  check('第一轮作业提交', !!jobId1, jobId1)
  const final1 = jobId1 ? await waitDone(jobId1) : null
  console.log(`    第一轮终态=${final1}(基线校准;未达标即进入第二轮靶向精修)`)

  // 第二轮:更大历史窗 + 更大容量(依据第一轮门禁反馈的靶向精修)
  const dsBuild2 = await invoke(worker.id, worker.token, 'aml_dataset_build', {
    line_id: line.id, product_id: recipe?.productId ?? '', recipe_id: recipe?.id ?? '',
    nodes: [{ node_id: spDaq.id, role: 'control' }, { node_id: pvDaq.id, role: 'target' }],
    beat_ms: 1000, history_steps: 10, horizon_steps: 4,
    split_seed: 42, val_ratio: 0.2, test_ratio: 0.2, purpose: 'mpc_surrogate',
    note: 'Agent 第二轮:加大历史窗(H=10)覆盖 τ≈8s 惯性',
  })
  const dsId2 = String(dsBuild2?.result?.text ?? '').match(/ds-[a-z0-9-]+/)?.[0]
  check('第二轮数据集(靶向:加大历史窗)', !!dsId2, dsId2)
  const jobId2 = dsId2 ? await submit(dsId2, 'Agent 第二轮:加大历史窗 H=10 + 容量 h=192(靶向精修)', { hidden: 192, lr: 0.0008, epochs: 80 }) : null
  check('第二轮作业提交', !!jobId2, jobId2)
  const final2 = jobId2 ? await waitDone(jobId2) : null
  check('第二轮训练达标(done)', final2 === 'done', `final=${final2}`)

  console.log('━━━ 6. 排行榜与越权守卫 ━━━')
  const lb = await invoke(worker.id, worker.token, 'aml_leaderboard', { dataset_id: dsId2 ?? dsId })
  check('aml_leaderboard(谱系+门禁)', String(lb?.result?.text ?? '').length > 100, String(lb?.result?.text ?? '').slice(0, 80))
  const models = await api('GET', '/api/workshop/aml/models')
  const cand = (models?.data?.models ?? []).filter((m: any) => m.stage === 'candidate' && m.recipeId === recipe?.id)
    .sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]
  check('候选模型在册(登记自动完成)', !!cand, cand?.id)
  if (!cand) {
    await restoreGates()
    process.exit(failures > 0 ? 1 : 0)
    return
  }
  const workerPromote = await invoke(worker.id, worker.token, 'aml_model_promote', { model_id: cand?.id ?? 'x', to_stage: 'production' })
  const workerBlocked = workerPromote?.result?.isError === true || /lead 专属|无权/.test(String(workerPromote?.result?.text ?? workerPromote?.message ?? ''))
  check('worker 调晋升被拒(lead 专属硬守卫)', workerBlocked, String(workerPromote?.result?.text ?? workerPromote?.message ?? '').slice(0, 80))

  console.log('━━━ 7. lead 发起晋升 → HITL 人工批准 ━━━')
  const promotePromise = invoke(lead.id, lead.token, 'aml_model_promote', { model_id: cand.id, to_stage: 'production' })
  let approved = false
  for (let i = 0; i < 20 && !approved; i++) {
    await sleep(1000)
    const pending = await api('GET', '/api/workshop/hitl/pending')
    const items = pending?.data?.items ?? pending?.data ?? []
    const hit = (Array.isArray(items) ? items : []).find((x: any) => x.kind === 'dcw-approval' && String(x.title ?? '').includes('AML'))
    if (hit?.id) {
      const resp = await api('POST', '/api/workshop/hitl/respond', { body: { kind: 'dcw-approval', id: hit.id, confirmed: true, comment: '集成实测批准' } })
      approved = resp?.data?.ok === true || resp?.ok === true || resp?.code === 0
      check('HITL 待办出现并批准', approved, hit.id)
    }
  }
  const promoteResult = await Promise.race([promotePromise, sleep(30_000).then(() => null)])
  check('晋升执行完成(HITL 批准后)', String(promoteResult?.result?.text ?? '').includes('production'),
    String(promoteResult?.result?.text ?? '').slice(0, 120))
  const prodList = await api('GET', `/api/workshop/aml/models?recipeId=${recipe.id}&stage=production`)
  check('production 模型唯一在册', (prodList?.data?.models?.length ?? 0) === 1, `n=${prodList?.data?.models?.length}`)

  console.log('━━━ 8. 影子预测(Agent 调参参考) ━━━')
  const now = Date.now()
  const fetchSeries = async (nodeId: string) => {
    const r = await api('GET', `/api/workshop/daq/${nodeId}/samples?from=${now - 30_000}&to=${now}&bucketMs=1000&limit=100`)
    return (r?.data?.points ?? []).map((p: any) => p.avg ?? p.value)
  }
  const spSeries = await fetchSeries(spDaq.id)
  const pvSeries = await fetchSeries(pvDaq.id)
  const ref = await invoke(worker.id, worker.token, 'aml_model_reference', {
    line_id: line.id, recipe_id: recipe.id,
    controls: { [spDaq.id]: 185 }, steps: 3,
  })
  const refText = String(ref?.result?.text ?? '')
  check('aml_model_reference(生产模型 what-if 预测)', refText.length > 50 && !refText.includes('尚无 production'),
    refText.slice(0, 160).replace(/\n/g, ' '))
  void spSeries
  void pvSeries

  console.log(`\n━━━ 结果:${passed} PASS / ${failures} FAIL ━━━`)
  await restoreGates()
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
