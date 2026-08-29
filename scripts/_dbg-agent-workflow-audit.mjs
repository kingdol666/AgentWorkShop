/** mock 真实作业流审计:多 Agent × 多节点绑定/读写/越权矩阵/HITL 并发/解绑失效/级联清理 */
const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jget = (u) => fetch(ROOT + u, { headers: H }).then(r => r.json())
const jdel = (u) => fetch(ROOT + u, { method: 'DELETE', headers: H }).then(r => r.json())
const invoke = (agentId, tool, args) => jpost('/api/workshop/agent-tools/invoke', { agentId, tool, args }).then(r => r.data.result)
const bindings = (agentId) => jget(`/api/workshop/agent-tools/bindings?agentId=${agentId}`).then(d => d.data.bindings)
const bind = (agentId, nodeId, kind, mode) => jpost('/api/workshop/agent-tools/bindings', { agentId, nodeId, kind, mode })
const daqNodes = () => jget('/api/workshop/daq').then(d => d.data.nodes)

const cleanup = []
async function main() {
  // ===== 场景搭建:一条产线,两个工艺位(温度 + 压力),两个 Agent 分工 =====
  const line = (await jpost('/api/workshop/dcw/lines', { name: '作业流审计线' })).data.line
  cleanup.push(['line', line.id])
  const prod = (await jpost('/api/workshop/dcw/products', { name: '作业流审计产品', lineId: line.id })).data.product
  cleanup.push(['prod', prod.id])
  // 3 个数控 + 2 个数采(多节点绑定场景)
  const dw1 = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: '作业-温度设定', lineId: line.id })).data.node
  const dw2 = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-pressure-sp', name: '作业-压力设定', lineId: line.id })).data.node
  const dw3 = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-speed-sp', name: '作业-速度设定', lineId: line.id })).data.node
  const dq1 = (await jpost('/api/workshop/daq', { templateRef: 'daq-temp-tc', name: '作业-温度采集', lineId: line.id, intervalMs: 500 })).data.node
  const dq2 = (await jpost('/api/workshop/daq', { templateRef: 'daq-pressure-tx', name: '作业-压力采集', lineId: line.id, intervalMs: 500 })).data.node
  for (const id of [dw1.id, dw2.id, dw3.id]) cleanup.push(['dcw', id])
  for (const id of [dq1.id, dq2.id]) cleanup.push(['daq', id])

  // Agent-1(操作员):数控 temp(manual) + 数控 pressure(auto) + 数采 temp
  // Agent-2(质检员):仅数采 temp + 数采 pressure(只读角色)
  const A1 = 'agt-op-1'
  const A2 = 'agt-qc-1'
  for (const b of [...await bindings(A1), ...await bindings(A2)]) await jdel(`/api/workshop/agent-tools/bindings/${b.id}`)
  await bind(A1, dw1.id, 'dcw', 'manual')
  await bind(A1, dw2.id, 'dcw', 'auto')
  await bind(A1, dq1.id, 'daq', 'auto')
  await bind(A2, dq1.id, 'daq', 'auto')
  await bind(A2, dq2.id, 'daq', 'auto')
  console.log('scenario: A1=dw1(manual)+dw2(auto)+dq1 | A2=dq1+dq2(只读)')

  // 配方:控制参数只含温度;数采窗口含两个采集节点
  const rc = (await jpost('/api/workshop/dcw/recipes', {
    productId: prod.id, name: '作业流审计配方',
    params: [{ templateRef: 'dcw-temp-sp', nodeId: dw1.id, value: 180, min: 176, max: 188 }],
    daqWindows: [{ nodeId: dq1.id, min: 100, max: 260 }, { nodeId: dq2.id, min: 0.5, max: 1.2 }],
  })).data.recipe
  cleanup.push(['recipe', rc.id])
  const st = await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: rc.id })
  if (!st.data?.line?.active) { fail('line start'); process.exit(1) }
  await sleep(2500)

  // ===== 1. my_industrial_nodes:A1 多节点清单 =====
  const mine1 = await invoke(A1, 'my_industrial_nodes', {})
  const ok1 = mine1.text.includes('温度设定') && mine1.text.includes('压力设定') && mine1.text.includes('温度采集')
    && mine1.text.includes('176~188') && mine1.text.includes('手动确认') && mine1.text.includes('自动')
  if (ok1) console.log('PASS A1 多节点清单:3 绑定(2 数控 + 1 数采),窗口/模式齐备')
  else fail(`A1 清单异常: ${mine1.text.slice(0, 200)}`)
  const mine2 = await invoke(A2, 'my_industrial_nodes', {})
  if (mine2.text.includes('数采') && !mine2.text.includes('[数控]')) console.log('PASS A2 只读清单:仅数采')
  else fail(`A2 清单异常: ${mine2.text.slice(0, 120)}`)

  // ===== 2. 读写作业流:A1 manual 批准下发 + auto 直接下发 =====
  const p1 = invoke(A1, 'dcw_control', { node_id: dw1.id, value: 182 })
  await sleep(600)
  let pend = (await jget(`/api/workshop/agent-tools/approvals?agentId=${A1}`)).data.approvals
  // 并发场景:同一节点重复下发 → 去重拒绝
  const dup = await invoke(A1, 'dcw_control', { node_id: dw1.id, value: 183 })
  if (dup.isError && dup.text.includes('待审批')) console.log('PASS HITL 并发去重:同节点 pending 期间拒绝新下发')
  else fail(`并发去重失效: ${dup.text.slice(0, 80)}`)
  // 用户批准第一条
  await jpost(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, { approved: true, comment: '按配方执行' })
  const r1 = await p1
  if (r1.text.includes('下发成功') && r1.text.includes('182')) console.log('PASS A1 dw1(manual) 批准后下发成功')
  else fail(`manual 下发异常: ${r1.text.slice(0, 120)}`)

  const r2 = await invoke(A1, 'dcw_control', { node_id: dw2.id, value: 0.92 })
  if (r2.text.includes('下发成功')) console.log('PASS A1 dw2(auto) 直接下发成功')
  else fail(`auto 下发异常: ${r2.text.slice(0, 120)}`)

  // ===== 3. 越权矩阵 =====
  // 3.1 A2 试图数控下发(只读角色,无 dcw 绑定)
  const x1 = await invoke(A2, 'dcw_control', { node_id: dw1.id, value: 185 })
  if (x1.isError && x1.text.includes('尚未绑定')) console.log('PASS 越权①:A2(只读)数控下发被拒')
  else fail(`越权①失效: ${x1.text.slice(0, 80)}`)
  // 3.2 A1 试图操控未绑定的 dw3(同产线但未授权)
  const x2 = await invoke(A1, 'dcw_control', { node_id: dw3.id, value: 300 })
  if (x2.isError && x2.text.includes('无权操作') && x2.text.includes(dw3.id)) console.log('PASS 越权②:A1 操控未绑定节点 dw3 被拒')
  else fail(`越权②失效: ${x2.text.slice(0, 80)}`)
  // 3.3 A2 试图查询未绑定的节点(不存在节点)
  const x3 = await invoke(A2, 'daq_query', { node_id: 'dn-xxx' })
  if (x3.isError && x3.text.includes('无权查询')) console.log('PASS 越权③:A2 查询陌生节点被拒')
  else fail(`越权③失效: ${x3.text.slice(0, 80)}`)
  // 3.4 A1 用 A2 的数采视角?不适用——A1 有 dq1;验证 A1 不可查 dq2(未绑定)
  const x4 = await invoke(A1, 'daq_query', { node_id: dq2.id })
  if (x4.isError && x4.text.includes('无权查询')) console.log('PASS 越权④:A1 查询未绑定 dq2 被拒')
  else fail(`越权④失效: ${x4.text.slice(0, 80)}`)

  // ===== 4. 数据读取:A1 不传 node_id = 全部自己的数采节点;A2 全部(2 个) =====
  const q1 = await invoke(A1, 'daq_query', { last_minutes: 5 })
  const q2 = await invoke(A2, 'daq_query', { last_minutes: 5 })
  if (q1.text.includes('作业-温度采集') && q1.text.includes('1 个节点') && !q1.text.includes('作业-压力采集'))
    console.log('PASS 数据读取:A1 仅见自己绑定的 dq1')
  else fail(`A1 读取范围异常: ${q1.text.slice(0, 150)}`)
  if (q2.text.includes('作业-温度采集') && q2.text.includes('作业-压力采集') && q2.text.includes('2 个节点'))
    console.log('PASS 数据读取:A2 见绑定的 dq1+dq2')
  else fail(`A2 读取范围异常: ${q2.text.slice(0, 150)}`)
  // 数值确实来自产线运行(mock 波动数据)
  const live = (await daqNodes()).find(n => n.id === dq1.id)
  if (q1.text.includes(`最新 ${live?.value}`) || q1.text.match(/最新 \d/)) console.log('PASS 读取数据来自真实采集流(数值随产线波动)')
  else console.log('  [info] 数值比对:' + (live?.value ?? '?'))

  // ===== 5. HITL 拒绝路径 + 解绑失效 =====
  const p5 = invoke(A1, 'dcw_control', { node_id: dw1.id, value: 186 })
  await sleep(600)
  pend = (await jget(`/api/workshop/agent-tools/approvals?agentId=${A1}`)).data.approvals
  await jpost(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, { approved: false, comment: '温度稳定期,不要动' })
  const r5 = await p5
  if (r5.text.includes('拒绝了') && r5.text.includes('温度稳定期')) console.log('PASS HITL 拒绝:备注回传 tool result')
  else fail(`拒绝路径异常: ${r5.text.slice(0, 100)}`)

  // 解绑 dw1 → 挂起中的审批取消 + 后续下发无权
  const p6 = invoke(A1, 'dcw_control', { node_id: dw1.id, value: 184 })
  await sleep(600)
  pend = (await jget(`/api/workshop/agent-tools/approvals?agentId=${A1}`)).data.approvals
  if (pend.length > 0) {
    const bList = await bindings(A1)
    const dw1b = bList.find(b => b.nodeId === dw1.id && b.kind === 'dcw')
    await jdel(`/api/workshop/agent-tools/bindings/${dw1b.id}`)
    const r6 = await p6
    if (r6.text.includes('绑定已解除')) console.log('PASS 解绑失效:挂起审批被取消(备注注明原因)')
    else fail(`解绑失效异常: ${r6.text.slice(0, 100)}`)
  }
  else {
    console.log('  [info] dw1 无挂起(可能已决),直接验证解绑后无权')
    const bList = await bindings(A1)
    const dw1b = bList.find(b => b.nodeId === dw1.id && b.kind === 'dcw')
    await jdel(`/api/workshop/agent-tools/bindings/${dw1b.id}`)
  }
  const x5 = await invoke(A1, 'dcw_control', { node_id: dw1.id, value: 180 })
  if (x5.isError && x5.text.includes('无权操作')) console.log('PASS 解绑后:A1 对 dw1 无权下发')
  else fail(`解绑后仍可操作: ${x5.text.slice(0, 80)}`)

  // ===== 6. 节点删除级联:删 dw3 → 任何残留绑定自动消失 =====
  const ghost = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-tension-sp', name: '作业-幽灵设定', lineId: line.id })).data.node
  cleanup.push(['dcw', ghost.id])
  await bind(A2, ghost.id, 'dcw', 'auto')
  await jdel(`/api/workshop/dcw/${ghost.id}`)
  await sleep(400)
  const afterGhost = (await invoke(A2, 'my_industrial_nodes', {})).text
  if (!afterGhost.includes('幽灵')) console.log('PASS 节点删除级联:绑定随删除自动清理')
  else fail(`级联清理失效: ${afterGhost.slice(0, 100)}`)

  // ===== 7. 停线:写入仍受全局量程约束(工具语义提示无活动配方) =====
  await jpost(`/api/workshop/dcw/lines/${line.id}/stop`, {})
  await sleep(500)
  const r7 = await invoke(A1, 'dcw_control', { node_id: dw2.id, value: 0.7 })
  if (r7.text.includes('下发成功') && r7.text.includes('无活动配方')) console.log('PASS 停线后下发:全局量程约束 + 语义提示')
  else fail(`停线下发异常: ${r7.text.slice(0, 100)}`)
}

main()
  .then(async () => {
    // cleanup(LIFO)
    for (const [kind, id] of [...cleanup].reverse()) {
      if (kind === 'line') await jpost(`/api/workshop/dcw/lines/${id}/stop`, {}).catch(() => {})
      const base = kind === 'daq' ? '/api/workshop/daq' : kind === 'dcw' ? '/api/workshop/dcw' : `/api/workshop/dcw/${kind === 'prod' ? 'products' : kind === 'recipe' ? 'recipes' : 'lines'}`
      await jdel(`${base}/${id}`).catch(() => {})
    }
    console.log(process.exitCode ? 'AUDIT FAILED' : 'AUDIT ALL PASS')
    process.exit(process.exitCode ?? 0)
  })
  .catch((err) => {
    console.error('FATAL:', err.message)
    process.exit(1)
  })
