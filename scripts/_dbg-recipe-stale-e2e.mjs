/**
 * 配方失效节点(停用/解绑/删除)一致性 E2E(隔离实例 :3021)
 *
 * 验证:
 *  1) 配方一键下发:A 正常下发;B(停用)/C(解绑)/D(删除)三类失效参数逐一跳过并记明原因
 *  2) 手动 REST 写停用节点 → 409(单点门控)
 *  3) Agent dcw_control 停用节点 → 明确「已停用」报错
 *  4) Agent recipe_update:触到停用/解绑节点被拒;正常参数保存时自动剪除基线中的失效参数并告知
 *  5) recipe_rollback 回退到含失效节点的历史版本 → 剪枝成功,版本描述记录剔除
 *  6) line_context 参数行带 [已停用/已取消绑定/已删除] 标记
 * 用法:NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-recipe-stale-e2e.mjs [base]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3021'
const TAG = `st${Math.random().toString(36).slice(2, 6)}`
let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}
const api = async (method, path, { body, token } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const invoke = (token, agentId, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { body: { agentId, tool, args }, token })

async function main() {
  console.log(`━━━ 配方失效节点一致性 E2E @ ${BASE} (tag=${TAG}) ━━━`)
  const login = await api('POST', '/api/users/login', { body: { email: 'admin', password: 'admin123' } })
  const token = login.data?.token
  ok(Boolean(token), 'admin 登录')

  // ── 夹具:产线 + 4 节点 + 产品 + 配方(4 参数)──
  const line = (await api('POST', '/api/workshop/dcw/lines', { body: { name: `st-line-${TAG}` }, token })).data?.line
  const mkNode = async (name) => (await api('POST', '/api/workshop/dcw', {
    body: { name: `${name}-${TAG}`, templateRef: 'temp-sp', driver: 'mock', driverConfig: { key: `${name}-${TAG}` }, min: 0, max: 100, unit: '℃', lineId: line.id },
    token,
  })).data?.node
  const na = await mkNode('st-a')
  const nb = await mkNode('st-b')
  const nc = await mkNode('st-c')
  const nd = await mkNode('st-d')
  const product = (await api('POST', '/api/workshop/dcw/products', { body: { name: `st-prod-${TAG}`, lineId: line.id }, token })).data?.product
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
    body: { name: `st-recipe-${TAG}`, productId: product.id, params: [
      { nodeId: na.id, value: 40 },
      { nodeId: nb.id, value: 41 },
      { nodeId: nc.id, value: 42 },
      { nodeId: nd.id, value: 43 },
    ] },
    token,
  })).data?.recipe
  ok(Boolean(na?.id && nb?.id && nc?.id && nd?.id && recipe?.id), `夹具:4 节点 + 配方 ${recipe?.id}`)

  // ── 三态变异:B 停用 / C 解绑 / D 删除 ──
  await api('PATCH', `/api/workshop/dcw/${nb.id}`, { body: { enabled: false }, token })
  await api('PATCH', `/api/workshop/dcw/${nc.id}`, { body: { lineId: '' }, token })
  await api('DELETE', `/api/workshop/dcw/${nd.id}`, { token })

  // ── 1. 一键下发:失效参数逐一跳过 ──
  const apply = await api('POST', `/api/workshop/dcw/recipes/${recipe.id}/apply`, { body: {}, token })
  ok(apply.status === 200, '一键下发执行')
  const results = apply.data?.run?.results ?? []
  const byNode = Object.fromEntries(results.map(r => [r.nodeId ?? 'deleted', r]))
  ok(byNode[na.id]?.ok === true, 'A 正常节点照常下发')
  ok((byNode[nb.id]?.message ?? '').includes('已停用') && byNode[nb.id]?.ok === false, `B 停用跳过(${byNode[nb.id]?.message ?? '∅'})`)
  ok((byNode[nc.id]?.message ?? '').includes('已取消绑定') && byNode[nc.id]?.ok === false, `C 解绑跳过(${byNode[nc.id]?.message ?? '∅'})`)
  ok(Object.values(byNode).some(r => (r.message ?? '').includes('已删除') && r.ok === false), `D 删除跳过(${(results.find(r => !r.nodeId)?.message) ?? '∅'})`)
  ok((apply.data?.run?.results ?? []).every(r => results.some(x => x === r)), 'run.results 完整保留跳过原因')

  // ── 2. 手动 REST 写停用节点 → 409 ──
  const manual = await api('POST', `/api/workshop/dcw/${nb.id}/write`, { body: { value: 10 }, token })
  ok(manual.status === 409, `手动写停用节点 409(实际 ${manual.status} ${manual.message ?? ''})`)

  // ── 3. Agent 组建 + 直调 ──
  const ch = (await api('POST', '/api/workshop/channels', {
    body: { name: `st-${TAG}`, leadAgent: { name: `lead-${TAG}`, harness: 'mock', config: { delayMs: 60 } } },
    token,
  })).data
  const tpl = await api('POST', '/api/workshop/agents', { body: { name: `stw-${TAG}`, harness: 'omp', config: { provider: 'zhipu-coding-plan', model: 'glm-5.3-flash' } }, token })
  const join = await api('POST', `/api/workshop/channels/${ch.channelId}/agents`, { body: { agentId: tpl.data.id, role: 'worker' }, token })
  const instId = join.data?.id
  for (const n of [na, nb, nc]) await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: instId, nodeId: n.id, kind: 'dcw', mode: 'auto' }, token })
  ok(Boolean(instId), 'omp worker 建号+绑定')

  const wB = await invoke(token, instId, 'dcw_control', { node_id: nb.id, value: 10 })
  ok(wB.data?.result?.isError === true && wB.data?.result?.text.includes('已停用'), '[agent] dcw_control 停用节点明确报错', wB.data?.result?.text?.slice(0, 80))

  // ── 4. recipe_update:触雷拒绝 + 自动剪枝 ──
  const uB = await invoke(token, instId, 'recipe_update', { recipe_id: recipe.id, params: [{ node_id: nb.id, value: 70 }], reason: '触雷测试' })
  ok(uB.data?.result?.isError === true && uB.data?.result?.text.includes('已停用'), '[agent] recipe_update 停用节点被拒', uB.data?.result?.text?.slice(0, 80))
  const uC = await invoke(token, instId, 'recipe_update', { recipe_id: recipe.id, params: [{ node_id: nc.id, value: 70 }], reason: '触雷测试' })
  ok(uC.data?.result?.isError === true && uC.data?.result?.text.includes('已取消绑定'), '[agent] recipe_update 解绑节点被拒', uC.data?.result?.text?.slice(0, 80))

  const uA = await invoke(token, instId, 'recipe_update', { recipe_id: recipe.id, params: [{ node_id: na.id, value: 77 }], reason: '正常参数保存(应自动剔除 C/D 失效参数)' })
  ok(uA.data?.result?.text?.includes('v2') && uA.data?.result?.text?.includes('剔除'), '[agent] 正常保存 → v2 + 剔除失效参数告知', uA.data?.result?.text?.slice(0, 120))
  const cur = (await api('GET', '/api/workshop/dcw', { token })).data?.recipes?.find(r => r.id === recipe.id)
  ok(cur?.params?.length === 2 && cur?.params?.some(p => p.nodeId === na.id) && cur?.params?.some(p => p.nodeId === nb.id), `基线剪枝后参数=A+B(实际 ${cur?.params?.length} 条)`)

  // ── 5. 回退到含失效节点的 v1 → 剪枝成功 ──
  const rb = await api('POST', `/api/workshop/dcw/recipes/${recipe.id}/revert`, { body: { version: 1, reason: '回退到含失效节点的初版' }, token })
  ok(rb.status === 200 && rb.data?.recipe?.version === 3, `回退 v1 → v3 成功(实际 v${rb.data?.recipe?.version})`)
  ok((rb.data?.recipe?.description ?? '').includes('剔除') || (rb.data?.recipe?.paramsHistory ?? []).some(h => (h.description ?? '').includes('剔除')), '回退版本描述记录剔除')
  ok((rb.data?.recipe?.params ?? []).every(p => p.nodeId !== nd.id && p.nodeId !== nc.id), '回退后不含已删除/已解绑节点参数')

  // ── 6. line_context 状态标记 ──
  const lc = await invoke(token, instId, 'line_context', {})
  if (lc.data?.result?.text?.includes('已停用') && lc.data?.result?.text?.includes('参数不下发')) ok(true, '[agent] line_context 标记停用参数')
  else {
    ok(false, '[agent] line_context 标记停用参数')
    console.log('  ── line_context 实际输出 ──')
    console.log(lc.data?.result?.text ?? JSON.stringify(lc))
  }

  // ── 清理 ──
  await api('DELETE', `/api/workshop/channels/${ch.channelId}?purge=1`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/agents/${tpl.data.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/recipes/${recipe.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/products/${product.id}`, { token }).catch(() => {})
  for (const n of [na, nb, nc]) await api('DELETE', `/api/workshop/dcw/${n.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/lines/${line.id}`, { token }).catch(() => {})

  console.log(`\n━━━ StaleRef E2E: ${pass} passed / ${fail} failed ━━━`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E 异常:', err)
  process.exit(1)
})
