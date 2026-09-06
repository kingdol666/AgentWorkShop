/**
 * Recipe 管理 + Agent 操控 E2E(隔离实例 :3021)
 *
 * 验证:
 *  1) REST 版本流:PATCH 参数 → v2(归因 user/admin);GET versions 历史完整
 *  2) Agent recipe_update(部分合并)→ v3(归因 agent/Channel名-成员名 + reason)
 *  3) Agent recipe_versions 查看版本史(谁/何时/为什么/diff)
 *  4) REST revert → v4(user);Agent recipe_rollback version=3 → v5(agent)
 *  5) line_context:产线/产品/配方/版本/PLC 当前值/我的绑定 全景
 *  6) 负向:无 reason 拒绝;未绑定节点拒绝;回退到未来版本拒绝
 *  7) 工具面注入:四新工具在 omp worker 工具清单
 *  8) 真实 LLM 任务(omp):line_context → recipe_update → recipe_versions,交付回带标记
 * 用法:NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-recipe-e2e.mjs [base]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3021'
const TAG = `rc${Math.random().toString(36).slice(2, 6)}`
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
const invoke = (token, agentId, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { body: { agentId, tool, args }, token })

async function main() {
  console.log(`━━━ Recipe 管理/Agent 操控 E2E @ ${BASE} (tag=${TAG}) ━━━`)

  // ── 0. 登录 + 夹具 ──
  const login = await api('POST', '/api/users/login', { body: { email: 'admin', password: 'admin123' } })
  const token = login.data?.token
  ok(Boolean(token), 'admin 登录')
  const line = (await api('POST', '/api/workshop/dcw/lines', { body: { name: `rcline-${TAG}` }, token })).data?.line
  const node = (await api('POST', '/api/workshop/dcw', {
    body: { name: `rcnode-${TAG}`, templateRef: 'temp-sp', driver: 'mock', driverConfig: { key: `rcnode-${TAG}` }, min: 0, max: 100, unit: '℃', lineId: line.id },
    token,
  })).data?.node
  const product = (await api('POST', '/api/workshop/dcw/products', { body: { name: `rcproduct-${TAG}`, lineId: line.id }, token })).data?.product
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
    body: { name: `rcrecipe-${TAG}`, productId: product.id, params: [{ nodeId: node.id, value: 42, min: 0, max: 100 }] },
    token,
  })).data?.recipe
  ok(Boolean(line?.id && node?.id && product?.id && recipe?.id), `夹具:产线/节点/产品/配方(${recipe?.id} v${recipe?.version})`)

  // ── 1. Agent 组建(omp worker + 绑定)──
  const ch = (await api('POST', '/api/workshop/channels', {
    body: { name: `rc-${TAG}`, leadAgent: { name: `lead-${TAG}`, harness: 'mock', config: { delayMs: 60 } } },
    token,
  })).data
  const tpl = await api('POST', '/api/workshop/agents', {
    body: { name: `rcw-${TAG}`, harness: 'omp', config: { provider: 'zhipu-coding-plan', model: 'glm-5.3-flash', systemPromptPrefix: '你是产线操作员:严格按任务执行,完成后立即调用 complete_task。' } },
    token,
  })
  const join = await api('POST', `/api/workshop/channels/${ch.channelId}/agents`, { body: { agentId: tpl.data.id, role: 'worker' }, token })
  const instId = join.data?.id
  const bind = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: instId, nodeId: node.id, kind: 'dcw', mode: 'auto' }, token })
  ok(Boolean(instId) && bind.code === 0, 'omp worker 建号+绑定')

  // ── 2. 工具面注入 ──
  const list = await api('GET', `/api/workshop/agent-tools/list?agentId=${instId}`, { token })
  const names = (list.data?.tools ?? []).map(x => x.name)
  ok(['line_context', 'recipe_versions', 'recipe_update', 'recipe_rollback'].every(n => names.includes(n)), '工具面含 4 个新工具')

  // ── 3. REST 版本流:PATCH → v2(user/admin 归因)──
  const patched = await api('PATCH', `/api/workshop/dcw/recipes/${recipe.id}`, {
    body: { params: [{ nodeId: node.id, value: 50, min: 0, max: 100 }] },
    token,
  })
  ok(patched.data?.recipe?.version === 2, `PATCH → v2(实际 v${patched.data?.recipe?.version})`)
  const vs1 = (await api('GET', `/api/workshop/dcw/recipes/${recipe.id}/versions`, { token })).data?.versions ?? []
  const v1entry = vs1.find(v => v.version === 1)
  ok(vs1.length === 2 && v1entry?.by === 'user' && v1entry?.actorName === 'admin', `versions 历史完整(by=${v1entry?.by}, actor=${v1entry?.actorName})`)

  // ── 4. Agent recipe_update → v3(agent 归因)──
  const upd = await invoke(token, instId, 'recipe_update', {
    recipe_id: recipe.id,
    params: [{ node_id: node.id, value: 88 }],
    reason: '数采证据:窗口均值稳定在 88 且无越限',
  })
  ok(upd.data?.result?.text?.includes('v3'), `[agent] recipe_update → v3`, upd.data?.result?.text?.slice(0, 100))
  const vs2 = (await api('GET', `/api/workshop/dcw/recipes/${recipe.id}/versions`, { token })).data?.versions ?? []
  const v2entry = vs2.find(v => v.version === 2)
  ok(v2entry?.by === 'agent' && v2entry?.actorName?.includes('/'), `v3 归因 agent + Channel/成员(by=${v2entry?.by}, actor=${v2entry?.actorName})`)
  const cur = (await api('GET', '/api/workshop/dcw', { token })).data?.recipes?.find(r => r.id === recipe.id)
  ok(cur?.params?.[0]?.value === 88, '当前参数值=88(部分合并成功)')

  // ── 5. Agent recipe_versions 查看 ──
  const vh = await invoke(token, instId, 'recipe_versions', { recipe_id: recipe.id })
  ok(vh.data?.result?.text?.includes('来源=Agent') && vh.data?.result?.text?.includes('来源=用户'), '[agent] recipe_versions 含双来源归因', vh.data?.result?.text?.slice(0, 100))
  ok(vh.data?.result?.text?.includes('42→50') || vh.data?.result?.text?.includes('50→88'), '[agent] 版本 diff 可读')

  // ── 6. REST revert → v4(user);Agent rollback version=3 → v5 ──
  const rv = await api('POST', `/api/workshop/dcw/recipes/${recipe.id}/revert`, { body: { version: 2, reason: 'E2E 界面回退' }, token })
  ok(rv.data?.recipe?.version === 4 && rv.data?.recipe?.params?.[0]?.value === 50, `REST revert → v4 参数=50(实际 v${rv.data?.recipe?.version} 值 ${rv.data?.recipe?.params?.[0]?.value})`)
  const rb = await invoke(token, instId, 'recipe_rollback', { recipe_id: recipe.id, version: 3, reason: '优化翻车,回退到 88 的版本' })
  ok(rb.data?.result?.text?.includes('v5'), '[agent] recipe_rollback → v5', rb.data?.result?.text?.slice(0, 100))
  const cur2 = (await api('GET', '/api/workshop/dcw', { token })).data?.recipes?.find(r => r.id === recipe.id)
  ok(cur2?.params?.[0]?.value === 88, '回退后参数=88(非破坏版本化)')

  // ── 7. line_context 全景 ──
  const lc = await invoke(token, instId, 'line_context', {})
  ok(lc.data?.result?.text?.includes(`rcline-${TAG}`) && lc.data?.result?.text?.includes(`rcproduct-${TAG}`) && lc.data?.result?.text?.includes(`rcrecipe-${TAG}`), '[agent] line_context 含产线/产品/配方名')
  ok(lc.data?.result?.text?.includes('v5') && lc.data?.result?.text?.includes('PLC 当前'), '[agent] line_context 含版本与 PLC 当前值')

  // ── 8. 负向 ──
  const n1 = await invoke(token, instId, 'recipe_update', { recipe_id: recipe.id, params: [{ node_id: node.id, value: 60 }] })
  ok(n1.data?.result?.isError === true, '负向:无 reason 被拒')
  const n2 = await invoke(token, instId, 'recipe_update', { recipe_id: recipe.id, params: [{ node_id: 'not-bound', value: 60 }], reason: 'x' })
  ok(n2.data?.result?.isError === true, '负向:未绑定节点被拒')
  const n3 = await invoke(token, instId, 'recipe_rollback', { recipe_id: recipe.id, version: 99, reason: 'x' })
  ok(n3.data?.result?.isError === true, '负向:不存在的版本被拒')

  // ── 9. 真实 LLM 任务(omp):上下文→保存→查史,回带标记 ──
  const t = await api('POST', `/api/workshop/channels/${ch.channelId}/tasks`, {
    body: {
      title: `recipe-loop-${TAG}`,
      parts: [{ text: `执行配方闭环自查(不要下发 PLC 控制指令):
1. 调用 line_context 确认你控制的产线/产品/配方与版本;
2. 调用 recipe_update,recipe_id 用 line_context 看到的,params=[{node_id: "${node.id}", value: 92}],reason 写"闭环验证:数采窗口稳定";
3. 调用 recipe_versions 复核;
4. 最终交付原样包含三行标记:CONTEXT-OK、SAVED-OK、HIST-OK,并各附一句你看到的信息。
完成后调用 complete_task。` }],
      assigneeId: instId,
    },
    token,
  })
  const taskId = t.data?.task?.id ?? t.data?.id
  ok(Boolean(taskId), '[omp] 闭环任务下发')
  let state = ''
  const deadline = Date.now() + 14 * 60_000
  while (Date.now() < deadline) {
    for (let i = 0; i < 3; i++) {
      try {
        const me = await api('GET', `/api/workshop/tasks/${taskId}`, { token })
        state = me.data?.state ?? ''
        break
      }
      catch { await sleep(3000) }
    }
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(state)) break
    await sleep(6000)
  }
  ok(state === 'COMPLETED', `[omp] 闭环任务 COMPLETED(state=${state})`)
  const taskBlob = JSON.stringify((await api('GET', `/api/workshop/tasks/${taskId}`, { token })).data ?? {})
  const msgBlob = JSON.stringify((await api('GET', `/api/workshop/channels/${ch.channelId}/messages?limit=200`, { token })).data ?? {})
  const blob = taskBlob + msgBlob
  ok(blob.includes('CONTEXT-OK'), '[omp] 交付含 CONTEXT-OK(Agent 知道自己操控的产线/产品/配方)')
  const finalVer = (await api('GET', '/api/workshop/dcw', { token })).data?.recipes?.find(r => r.id === recipe.id)
  ok(finalVer?.params?.[0]?.value === 92 && (finalVer?.version ?? 0) >= 6, `[omp] LLM 保存参数生效(v${finalVer?.version} 值 ${finalVer?.params?.[0]?.value})`)
  ok(blob.includes('SAVED-OK') && blob.includes('HIST-OK'), '[omp] 交付含 SAVED-OK/HIST-OK')

  // ── 清理 ──
  await api('DELETE', `/api/workshop/channels/${ch.channelId}?purge=1`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/agents/${tpl.data.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/${node.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/recipes/${recipe.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/products/${product.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/lines/${line.id}`, { token }).catch(() => {})

  console.log(`\n━━━ Recipe E2E: ${pass} passed / ${fail} failed ━━━`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E 异常:', err)
  process.exit(1)
})
