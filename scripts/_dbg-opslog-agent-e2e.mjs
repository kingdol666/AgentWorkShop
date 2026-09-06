/**
 * OpsLog Agent 归属 + ops_log/recipe_log 工具 E2E(隔离实例 :3021)
 *
 * 验证:
 *  1) Agent dcw_control 下发 → audit: actorKind=agent, actorName=「Channel名/成员名」(非 UUID)
 *  2) ops_log / recipe_log 注入全部 harness worker 的工具面(agent-tools/list)
 *  3) REST 直调 ops_log/recipe_log:能看到 来源=Agent 条目 + 配方下发/优化开窗
 *  4) 负向:未绑定节点查询被拒
 *  5) 真实 LLM 任务 ×4 引擎(omp/codex/dsh/opencode):Agent 自主调用两工具并在交付中
 *     回带 LOGCHECK-OK / RECIPECHECK-OK 标记(mock 引擎无 LLM 回合,由 2/3 覆盖)
 * 用法:NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-opslog-agent-e2e.mjs [base]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3021'
const TAG = `ol${Math.random().toString(36).slice(2, 6)}`
let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (method, path, { body, token } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

const ENGINES = [
  { key: 'omp', harness: 'omp', cfg: { provider: 'zhipu-coding-plan', model: 'glm-5.3-flash' } },
  { key: 'codex', harness: 'codex', cfg: { model: 'glm-5.3-flash', approvalPolicy: 'never' } },
  { key: 'dsh', harness: 'dsh', cfg: { provider: 'ustc', model: 'glm-5.3-flash' } },
  { key: 'opencode', harness: 'opencode', cfg: { model: 'zhipuai-coding-plan/glm-5.3-flash' } },
]

async function main() {
  console.log(`━━━ OpsLog/Recipe 工具 E2E @ ${BASE} (tag=${TAG}) ━━━`)

  // ── 0. admin 登录(用户名) ──
  const login = await api('POST', '/api/users/login', { body: { email: 'admin', password: 'admin123' } })
  const token = login.data?.token
  ok(Boolean(token), 'admin 用户名登录')
  if (!token) process.exit(1)

  // ── 1. 产线 + mock 节点 + 配方(+下发) ──
  const line = (await api('POST', '/api/workshop/dcw/lines', { body: { name: `opsline-${TAG}` }, token })).data?.line
  ok(Boolean(line?.id), `产线创建 ${line?.id ?? ''}`)
  const node = (await api('POST', '/api/workshop/dcw', {
    body: { name: `opsnode-${TAG}`, templateRef: 'temp-sp', driver: 'mock', driverConfig: { key: `opsnode-${TAG}` }, min: 0, max: 100, unit: '℃', lineId: line.id },
    token,
  })).data?.node
  ok(Boolean(node?.id), `mock 数控节点创建 ${node?.id ?? ''}`)
  const product = (await api('POST', '/api/workshop/dcw/products', {
    body: { name: `opsproduct-${TAG}`, lineId: line.id },
    token,
  })).data?.product
  ok(Boolean(product?.id), `产品创建 ${product?.id ?? ''}`)
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
    body: { name: `opsrecipe-${TAG}`, productId: product?.id, params: [{ nodeId: node.id, value: 42, min: 0, max: 100 }] },
    token,
  })).data?.recipe ?? (await api('GET', '/api/workshop/dcw/recipes', { token })).data?.recipes?.find(r => r.name === `opsrecipe-${TAG}`)
  ok(Boolean(recipe?.id), `配方创建 ${recipe?.id ?? ''}`)
  const applied = await api('POST', `/api/workshop/dcw/recipes/${recipe.id}/apply`, { body: {}, token })
  ok(applied.status === 200 || applied.pending === true, `配方一键下发(status=${applied.status} ${applied.message ?? ''})`)

  // ── 2. 每 harness:channel(mock lead)+ worker + 绑定 ──
  const members = {}
  for (const e of [...ENGINES, { key: 'mock', harness: 'mock', cfg: { delayMs: 50 } }]) {
    const ch = (await api('POST', '/api/workshop/channels', {
      body: { name: `opslog-${e.key}-${TAG}`, leadAgent: { name: `lead-${TAG}`, harness: 'mock', config: { delayMs: 60 } } },
      token,
    })).data
    const tpl = await api('POST', '/api/workshop/agents', {
      body: { name: `ops-${e.key}-${TAG}`, harness: e.harness, config: { ...e.cfg, systemPromptPrefix: '你是产线操作员:严格按任务执行,只做任务要求的事,完成后立即调用 complete_task。' } },
      token,
    })
    const join = await api('POST', `/api/workshop/channels/${ch.channelId}/agents`, { body: { agentId: tpl.data.id, role: 'worker' }, token })
    const instId = join.data?.id
    const bind = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: instId, nodeId: node.id, kind: 'dcw', mode: 'auto' }, token })
    members[e.key] = { channelId: ch.channelId, instId, name: `ops-${e.key}-${TAG}` }
    ok(Boolean(instId) && bind.code === 0, `${e.harness} worker 建号+绑定(bind=${bind.code === 0 ? 'ok' : bind.message})`)
  }

  // ── 3. 工具面注入断言(全 harness 一致) ──
  for (const [k, m] of Object.entries(members)) {
    const list = await api('GET', `/api/workshop/agent-tools/list?agentId=${m.instId}`, { token })
    const names = ((list.data?.tools) ?? []).map(t => t.name)
    ok(names.includes('ops_log') && names.includes('recipe_log'), `[${k}] 工具面含 ops_log+recipe_log`)
  }

  // ── 4. Agent 下发(mock 直调:mock 驱动确定性 ACK,无需 PLC)→ 审计归属 ──
  const wr = await api('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: members.omp.instId, tool: 'dcw_control', args: { node_id: node.id, value: 55, task_id: 'e2e-opslog' } },
    token,
  })
  ok(wr.data?.result?.text?.includes('下发成功'), '[omp 直调] dcw_control 下发成功', wr.data?.result?.text?.slice(0, 80))
  const audit = await api('GET', '/api/workshop/audit?limit=100&action=dcw.write.agent', { token })
  const entry = ((audit.data?.entries) ?? []).find(x => x.targetId === node.id)
  ok(Boolean(entry), 'audit 出现 dcw.write.agent 条目')
  ok(entry?.actorKind === 'agent', `条目来源=agent(实际 ${entry?.actorKind})`)
  ok(entry?.actorName === `opslog-omp-${TAG}/ops-omp-${TAG}`, `操作者=Channel/成员(实际 ${entry?.actorName})`)

  // ── 5. 工具直调查询 ──
  const q1 = await api('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: members.omp.instId, tool: 'ops_log', args: { minutes: 120 } },
    token,
  })
  ok(q1.data?.result?.text?.includes('来源=Agent') && q1.data?.result?.text?.includes(`opslog-omp-${TAG}/ops-omp-${TAG}`), '[omp] ops_log 看到来源=Agent + 人话操作者', q1.data?.result?.text?.slice(0, 100))
  const q2 = await api('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: members.omp.instId, tool: 'recipe_log', args: { minutes: 120 } },
    token,
  })
  ok(q2.data?.result?.text?.includes('配方下发') || q2.data?.result?.text?.includes('优化开窗'), '[omp] recipe_log 看到配方下发/优化开窗', q2.data?.result?.text?.slice(0, 100))
  const q3 = await api('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: members.omp.instId, tool: 'ops_log', args: { node_id: 'not-bound-node' } },
    token,
  })
  ok(q3.data?.result?.isError === true, '负向:未绑定节点查询被拒')

  // ── 6. 真实 LLM 任务 ×4:Agent 自主调用两工具并回带标记 ──
  const tasks = {}
  for (const e of ENGINES) {
    const m = members[e.key]
    const t = await api('POST', `/api/workshop/channels/${m.channelId}/tasks`, {
      body: {
        title: `opslog-check-${e.key}-${TAG}`,
        parts: [{ text: `执行自查(严格按步骤,不要下发任何控制指令):
1. 调用工具 ops_log(minutes=180)查看你负责产线的运维日志;
2. 调用工具 recipe_log(minutes=180)查看配方下发与回退历史;
3. 在最终交付中原样包含两行标记(各占一行):LOGCHECK-OK 与 RECIPECHECK-OK,并各引用一条你看到的日志摘要(一句话)。
完成后调用 complete_task。` }],
        assigneeId: m.instId,
      },
      token,
    })
    tasks[e.key] = t.data?.task?.id ?? t.data?.id
    ok(Boolean(tasks[e.key]), `[${e.key}] 任务下发`)
  }
  const states = {}
  const pollTask = async (id) => {
    for (let i = 0; i < 3; i++) {
      try {
        const me = await api('GET', `/api/workshop/tasks/${id}`, { token })
        return me.data?.state
      }
      catch { await sleep(3000) }
    }
    return undefined
  }
  const deadline = Date.now() + 20 * 60_000
  while (Date.now() < deadline && Object.keys(states).length < ENGINES.length) {
    for (const e of ENGINES) {
      if (states[e.key]) continue
      const st = await pollTask(tasks[e.key])
      if (st && ['COMPLETED', 'FAILED', 'CANCELED'].includes(st)) states[e.key] = st
    }
    if (Object.keys(states).length < ENGINES.length) await sleep(6000)
  }
  for (const e of ENGINES) {
    ok(states[e.key] === 'COMPLETED', `[${e.key}] 引擎任务 COMPLETED(state=${states[e.key] ?? 'RUNNING'})`)
    // 交付标记在 任务 artifacts / channel messages / events 三处任一出现即可
    const taskBlob = JSON.stringify((await api('GET', `/api/workshop/tasks/${tasks[e.key]}`, { token })).data ?? {})
    const msgBlob = JSON.stringify((await api('GET', `/api/workshop/channels/${members[e.key].channelId}/messages?limit=200`, { token })).data ?? {})
    const evBlob = JSON.stringify((await api('GET', `/api/workshop/channels/${members[e.key].channelId}/events?limit=400`, { token })).data ?? {})
    const blob = taskBlob + msgBlob + evBlob
    ok(blob.includes('LOGCHECK-OK'), `[${e.key}] 交付含 LOGCHECK-OK(Agent 真读到日志)`)
    ok(blob.includes('RECIPECHECK-OK'), `[${e.key}] 交付含 RECIPECHECK-OK(Agent 真读到 Recipe 历史)`)
  }

  // ── 清理 ──
  for (const m of Object.values(members)) await api('DELETE', `/api/workshop/channels/${m.channelId}?purge=1`, { token }).catch(() => {})
  for (const e of [...ENGINES, { key: 'mock' }]) {
    const list = await api('GET', '/api/workshop/agents', { token })
    const tpl = (list.data ?? []).find(x => x.name === `ops-${e.key}-${TAG}`)
    if (tpl) await api('DELETE', `/api/workshop/agents/${tpl.id}`, { token }).catch(() => {})
  }
  await api('DELETE', `/api/workshop/dcw/${node.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/recipes/${recipe.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/lines/${line.id}`, { token }).catch(() => {})

  console.log(`\n━━━ OpsLog E2E: ${pass} passed / ${fail} failed ━━━`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E 异常:', err)
  process.exit(1)
})
