/**
 * s8 Agent 授权 / s9 桥接授权
 * (由 scripts/e2e-full-closedloop.mjs 按职责拆出;内容逐行原文搬运)
 */
import { TAG, ctx } from './state.mjs'
import { api, ok, raw, section, waitUntil } from './lib.mjs'

// ════════════════════════════════════════════════════════════════
// S8 Agent 鉴权矩阵(P0-D 回归)
// ════════════════════════════════════════════════════════════════
export async function s8_agent_authz() {
  section('S8 Agent 节点绑定鉴权矩阵(P0-D 回归)')
  const ch = await api('POST', '/api/workshop/channels', {
    body: { name: `e2e-authz-${TAG}`, leadAgent: { name: `lead-${TAG}`, harness: 'mock', config: { delayMs: 50 } } },
    token: ctx.token,
  })
  ctx.channelId = ch.data?.channelId ?? ch.data?.id
  ok(Boolean(ctx.channelId), '创建 channel', ctx.channelId)

  // 关键:必须选一个实现了 host tool 直调面(dispatchHostTool)的 harness。
  // mock 走 MockAgentImpl(非 BaseAgentImpl),工具桥会回「不支持该协作工具」,
  // 那样鉴权断言会被"工具压根没到"掩盖 —— 断言必须打在真正的工具路径上。
  // host 工具直调不经 LLM(直连共享 host-tool-bridge),所以只要有 CLI 即可,不依赖模型凭据。
  const HARNESS = process.env.AW_E2E_TOOL_HARNESS ?? 'opencode'
  const tpl = await api('POST', '/api/workshop/agents', { body: { name: `worker-${TAG}`, harness: HARNESS, config: {} }, token: ctx.token })
  const join = await api('POST', `/api/workshop/channels/${ctx.channelId}/agents`, { body: { agentId: tpl.data?.id, role: 'worker' }, token: ctx.token })
  ctx.agent = { id: join.data?.id, token: join.data?.token, harness: HARNESS }
  ok(Boolean(ctx.agent.id), `Agent 入队(harness=${HARNESS})`, ctx.agent.id)

  const invoke = (tool, args, opts = {}) => api('POST', '/api/workshop/agent-tools/invoke', { body: { agentId: ctx.agent.id, tool, args }, token: ctx.token, ...opts })

  // 0) 工具面自检:该 harness 必须真的能派发 host 工具,否则后续鉴权断言无意义
  const probe = await invoke('my_industrial_nodes', {})
  const probeText = String(probe.data?.result?.text ?? '')
  const bridgeWorks = !/工具桥不支持该协作工具/.test(probeText)
  ok(bridgeWorks, `${HARNESS} harness 的 host tool 直调面可用`, probeText.slice(0, 90))

  // 1) 未绑定 → 必须拒绝(控制)。取值须落在活动配方窗口(180~200)内:
  //    窗口校验(400)发生在绑定校验之前,越窗只会测出"窗口拒绝"而掩盖鉴权结论。
  const unboundControl = await invoke('dcw_control', { node_id: ctx.dcw.main?.id, value: 191, hypothesis: 'e2e 未绑定拒绝验证' })
  const ucText = String(unboundControl.data?.result?.text ?? '')
  ok(unboundControl.data?.result?.isError === true && bridgeWorks, '未绑定 agent 的 dcw_control 被拒', ucText.slice(0, 80))

  // 2) 未绑定 → **回退也必须拒绝**(修复前是默认放行)
  const unboundRollback = await invoke('dcw_rollback', { node_id: ctx.dcw.main?.id })
  const rbText = String(unboundRollback.data?.result?.text ?? '')
  ok(unboundRollback.data?.result?.isError === true && bridgeWorks && /无权|未绑定/.test(rbText),
    '未绑定 agent 的 dcw_rollback 被拒(P0-D)', rbText.slice(0, 110))

  // 3) 绑定后 → 放行(先绑定,后面的 judge 断言需要一条 agent 发起的 open 记录)
  const bind = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: ctx.agent.id, nodeId: ctx.dcw.main?.id, kind: 'dcw', mode: 'auto' }, token: ctx.token })
  ok(bind.status === 200, '绑定 dcw 节点(auto)', JSON.stringify(bind.data ?? {}).slice(0, 80))
  // 断言的是「绑定闸门放行」而不是「下发一定成功」:S7 刚在同一节点做过用户回退,
  // 同向重写会被**写入保持窗口**(安全护栏)拦下 —— 那是正确行为,不该算绑定失败。
  // 但后面的 judge 断言需要一条本 agent 发起的 open 记录,因此窗口内小步重试
  // (旧写法:一次被护栏拦下 → judge 期望必然落空,把正确护栏报成失败)。
  let boundControl
  let bcText = ''
  for (let attempt = 0; attempt < 5; attempt += 1) {
    boundControl = await invoke('dcw_control', { node_id: ctx.dcw.main?.id, value: 196, hypothesis: 'e2e 绑定放行验证' })
    bcText = String(boundControl.data?.result?.text ?? '')
    if (!/写入保持窗口/.test(bcText)) break
    await new Promise(r => setTimeout(r, 10_000))
  }
  ok(boundControl.data?.result?.isError !== true || !/无权|未绑定/.test(bcText),
    '已绑定 agent 的 dcw_control 通过绑定闸门', bcText.slice(0, 110))

  // 4) judge 鉴权:找一条**本 agent 发起**的 open 记录 —— 才是可判定的对象。
  //    按 agentId 精确筛选:节点上可能还有用户/回退产生的记录(那些由用户判定)。
  const optList = (await api('GET', '/api/workshop/dcw/optimizations', { token: ctx.token })).data
  const allRecs = optList?.records ?? optList?.optimizations ?? []
  const openRec = allRecs.find(r => r.nodeId === ctx.dcw.main?.id && r.status === 'open' && r.agentId === ctx.agent.id)
  if (openRec?.id) {
    ok(true, 'agent 写入后已开自己的 open 优化记录(judge 有可判定对象)', openRec.id)
    const ownJudge = await invoke('dcw_judge', { record_id: openRec.id, verdict: 'keep', reason: 'e2e 属主判定:窗口内读数稳定,保留该设定' })
    const ojText = String(ownJudge.data?.result?.text ?? '')
    ok(ownJudge.data?.result?.isError !== true || /已判定|keep/.test(ojText), '属主 agent 可判定自己的记录', ojText.slice(0, 110))
  }
  else {
    ok(false, 'agent 下发后未开自己的优化记录(判定期望落空)',
      `records=${allRecs.length} mine=${allRecs.filter(r => r.agentId === ctx.agent.id).length}`)
  }

  // 5) 已绑定 agent 的**回退**同样可达(证明第 2 条不是"整段功能坏了")
  const boundRollback = await invoke('dcw_rollback', { node_id: ctx.dcw.main?.id })
  const brText = String(boundRollback.data?.result?.text ?? '')
  ok(boundRollback.data?.result?.isError !== true || /冷却/.test(brText),
    '已绑定 agent 的 dcw_rollback 可达(放行或仅被冷却拦截)', brText.slice(0, 90))

  // 6) 未绑定的另一个节点 → 仍拒绝
  const otherNode = await invoke('dcw_control', { node_id: ctx.dcw.two?.id, value: 190 })
  ok(otherNode.data?.result?.isError === true, '已绑定 agent 操作未绑定节点仍被拒(最小权限)')

  // 7) daq 查询鉴权
  const unboundQuery = await invoke('daq_query', { node_id: ctx.daq.scalar?.id })
  ok(unboundQuery.data?.result?.isError === true, '未绑定 agent 的 daq_query 被拒')
  await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: ctx.agent.id, nodeId: ctx.daq.scalar?.id, kind: 'daq', mode: 'auto' }, token: ctx.token })
  const boundQuery = await invoke('daq_query', { node_id: ctx.daq.scalar?.id })
  ok(boundQuery.data?.result?.isError !== true, '已绑定 agent 的 daq_query 放行')

  // 7b) 绑定面越权:用户 B 不得读全量授权表、不得摘掉 manual 闸门(P0 新增)
  const allBindings = await api('GET', '/api/workshop/agent-tools/bindings', { token: ctx.userB?.token })
  ok(allBindings.status === 200 && (allBindings.data?.bindings ?? []).length === 0,
    '普通用户读绑定表只看到自己授权产线的绑定(不泄漏全量授权表)', `status=${allBindings.status} n=${(allBindings.data?.bindings ?? []).length}`)
  const bindingId = bind.data?.binding?.id
  if (bindingId) {
    await api('PATCH', `/api/workshop/agent-tools/bindings/${bindingId}`, { body: { mode: 'manual' }, token: ctx.token })
    const bPatch = await api('PATCH', `/api/workshop/agent-tools/bindings/${bindingId}`, { body: { mode: 'auto' }, token: ctx.userB?.token })
    ok(bPatch.status === 403, '用户 B 摘不掉他人绑定的 HITL 闸门(mode→auto)', `status=${bPatch.status}`)
    const bDel = await api('DELETE', `/api/workshop/agent-tools/bindings/${bindingId}`, { token: ctx.userB?.token })
    ok(bDel.status === 403, '用户 B 删不掉他人绑定', `status=${bDel.status}`)
    await api('PATCH', `/api/workshop/agent-tools/bindings/${bindingId}`, { body: { mode: 'auto' }, token: ctx.token })
  }
  else { ok(false, '未取到 binding.id(绑定面越权断言无法执行)') }

  // 8) manual 模式 → 挂起审批(dcw_control)
  await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: ctx.agent.id, nodeId: ctx.dcw.two?.id, kind: 'dcw', mode: 'manual' }, token: ctx.token })
  const hitlPromise = invoke('dcw_control', { node_id: ctx.dcw.two?.id, value: 189 }, { timeoutMs: 120_000 }).catch(e => ({ data: { result: { isError: true, text: `invoke err ${e.message}` } } }))
  const pending = await waitUntil('manual 挂起审批', async () => {
    const r = await api('GET', '/api/workshop/agent-tools/approvals', { token: ctx.token })
    return (r.data?.approvals ?? []).find(p => p.agentId === ctx.agent.id) ?? null
  }, 20_000)
  ok(Boolean(pending?.id) && bridgeWorks, 'manual 绑定产生待审批', pending?.id)
  if (pending?.id) {
    const dec = await api('POST', `/api/workshop/agent-tools/approvals/${pending.id}/decide`, { body: { approved: true, comment: 'e2e 批准' }, token: ctx.token })
    ok(dec.status === 200, '管理员批准待审批')
    const res = await hitlPromise
    ok(res.data?.result?.isError !== true, '批准后指令执行', String(res.data?.result?.text ?? '').slice(0, 80))
  }
  else {
    await hitlPromise
  }

  // 9) manual 模式下的回退也必须挂起(与 dcw_control 同源,P0-D 后半段)
  const rbPromise = invoke('dcw_rollback', { node_id: ctx.dcw.two?.id }, { timeoutMs: 120_000 }).catch(e => ({ data: { result: { isError: true, text: `err ${e.message}` } } }))
  const pending2 = await waitUntil('manual 回退挂起审批', async () => {
    const r = await api('GET', '/api/workshop/agent-tools/approvals', { token: ctx.token })
    return (r.data?.approvals ?? []).find(p => p.agentId === ctx.agent.id) ?? null
  }, 20_000)
  if (pending2?.id) {
    await api('POST', `/api/workshop/agent-tools/approvals/${pending2.id}/decide`, { body: { approved: false, comment: 'e2e 拒绝回退' }, token: ctx.token })
    const res = await rbPromise
    ok(/未执行|拒绝/.test(String(res.data?.result?.text ?? '')), 'manual 回退经用户审批拒绝后不执行', String(res.data?.result?.text ?? '').slice(0, 80))
  }
  else {
    const res = await rbPromise
    ok(res.data?.result?.isError === true, 'manual 回退被门控(未挂起则必须直接拒绝)', String(res.data?.result?.text ?? '').slice(0, 90))
  }
}

// ════════════════════════════════════════════════════════════════
// S9 工具桥越权(P0-E 回归)
// ════════════════════════════════════════════════════════════════
export async function s9_bridge_authz() {
  section('S9 工具桥越权(P0-E 回归)')
  // 用户 B 的 token + 用户 A 的 agentId → 必须 403
  const cross = await raw('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: ctx.agent.id, tool: 'my_industrial_nodes', args: {} },
    token: ctx.userB?.token,
  })
  ok(cross.status === 403, '用户 B 冒用用户 A 的 agentId → 403(P0-E)', `status=${cross.status} ${String(cross.message ?? '').slice(0, 80)}`)

  // 错误 agent token → 401
  const badToken = await raw('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: ctx.agent.id, tool: 'my_industrial_nodes', args: {} },
    agentToken: 'not-a-real-token',
  })
  ok(badToken.status === 401, '伪造 agent token → 401', `status=${badToken.status}`)

  // 正确 agent token → 放行
  const goodToken = await raw('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: ctx.agent.id, tool: 'my_industrial_nodes', args: {} },
    agentToken: ctx.agent.token,
  })
  ok(goodToken.status === 200, '正确 agent token 自证放行', `status=${goodToken.status}`)

  // 用户 A 自己的 agent → 放行
  const own = await api('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: ctx.agent.id, tool: 'my_industrial_nodes', args: {} },
    token: ctx.token,
  })
  ok(own.status === 200, '属主用户调用自己 agent 的工具放行', `status=${own.status}`)

  // 不存在的 agentId → 404
  const missing = await api('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: 'no-such-agent', tool: 'my_industrial_nodes', args: {} },
    token: ctx.token,
  })
  ok(missing.status === 404, '不存在的 agentId → 404', `status=${missing.status}`)
}
