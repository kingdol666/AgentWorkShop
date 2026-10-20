#!/usr/bin/env node
/**
 * harness-team-line-e2e.mjs —— 真实团队作业 + 产线/配方/HITL 端到端验收。
 *
 * 场景(使用现有多协议孪生产线 ln-dd6c9135):
 *  1) 频道:mock lead + mock worker(确定性调度)+ omp 分析师 + copilot 操作员;
 *  2) 任务派发:root 任务 → mock lead 自动 dispatch → worker 完成;
 *  3) mailbox:lead 经 send_message_to_agent 发信,分析师 poll_messages 收到;
 *  4) 数采分析:omp 分析师 line_context + daq_query 取真实样本并 complete_task;
 *  5) 配方/下发:copilot 操作员 recipe_update(manual 绑定 → 人工审批)→
 *     recipe_apply(再次人工审批)→ PLC 回读一致;
 *  6) 工具注入:以上所有动作都经 host tools 完成(无 MCP 直连客户端)。
 *
 * 用法:
 *   AW_E2E_TOKEN=<admin token> node scripts/harness-team-line-e2e.mjs \
 *     [--base http://127.0.0.1:3001] [--out evidence.json]
 */
const args = process.argv.slice(2)
const argOf = (k, d = '') => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const BASE = argOf('--base', process.env.AW_BASE ?? 'http://127.0.0.1:3001')
const TOKEN = process.env.AW_E2E_TOKEN ?? process.env.AW_TOKEN ?? ''
const OUT = argOf('--out', '')
const LINE_ID = argOf('--line', 'ln-dd6c9135')
const RECIPE_ID = argOf('--recipe', 'rc-2be5c50c')
const SPEED_NODE = argOf('--speed-node', 'dw-d0b66f73')
const TAG = Date.now().toString(36)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const checks = []
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ` | ${String(detail).slice(0, 240)}` : ''}`)
  checks.push({ name, ok: !!cond, detail: String(detail).slice(0, 500) })
  cond ? pass++ : fail++
  return cond
}
if (!TOKEN) {
  console.error('缺少 AW_E2E_TOKEN / AW_TOKEN')
  process.exit(1)
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
async function waitTask(id, timeoutMs = 300000) {
  const end = Date.now() + timeoutMs
  let last = null
  while (Date.now() < end) {
    await sleep(3000)
    const r = await api('GET', `/api/workshop/tasks/${id}`)
    last = r.data ?? last
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(last?.state)) return last
  }
  return last
}
const artifactText = t => (t?.artifacts ?? []).flatMap(a => a.parts ?? []).map(p => String(p.text ?? '')).join('\n')

/** 轮询并批准本 channel 的 dcw-approval 待办;返回批准次数 */
async function approveLoop(channelId, timeoutMs, comment, maxApprovals = 2) {
  const end = Date.now() + timeoutMs
  let approved = 0
  let idleSince = 0
  while (Date.now() < end && approved < maxApprovals) {
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`)
    const items = (p.data?.items ?? []).filter(i => i.kind === 'dcw-approval')
    if (items.length > 0) {
      idleSince = 0
      for (const it of items) {
        const r = await api('POST', '/api/workshop/hitl/respond', { kind: it.kind, id: it.id, confirmed: true, comment })
        if (r.code === 0) approved++
        console.log(`  · HITL 批准 ${it.id.slice(0, 8)} ${String(it.title ?? '').slice(0, 100)}`)
      }
    }
    else {
      idleSince ||= Date.now()
      // 已批过至少一次且 20s 内没有下一张卡 → 认为操作链结束,避免空等满窗
      if (approved > 0 && Date.now() - idleSince > 20000) break
    }
    await sleep(2000)
  }
  return approved
}

async function main() {
  console.log(`━━━ 团队/产线/HITL 真实 E2E @ ${BASE} (tag=${TAG}) ━━━`)
  const ch = await api('POST', '/api/workshop/channels', {
    name: `ht-${TAG}`,
    description: `harness-team-line-e2e ${TAG}`,
    leadAgent: { name: 'ht-lead', harness: 'mock', config: { delayMs: 50 } },
  })
  const channelId = ch.data?.channelId
  const leadId = ch.data?.leadAgentId
  ok('频道创建(mock lead)', Boolean(channelId && leadId), channelId ?? ch.message)

  const bindLine = await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId: LINE_ID })
  ok('频道绑定产线', bindLine.code === 0, bindLine.data?.lineId ?? bindLine.message)

  const add = async (name, harness) => (await api('POST', `/api/workshop/channels/${channelId}/agents`, { name, harness, role: 'worker' })).data
  const analyst = await add('omp-analyst', 'omp')
  const operator = await add('copilot-operator', 'copilot')
  const mockWorker = await add('mock-worker', 'mock')
  ok('成员部署(mock/omp/copilot)', Boolean(analyst?.id && operator?.id && mockWorker?.id), `${analyst?.id?.slice(0, 8)}/${operator?.id?.slice(0, 8)}/${mockWorker?.id?.slice(0, 8)}`)

  // 绑定:分析师读数采节点;操作员绑定配方(manual → 每次写入/下发 HITL)
  const daqNodes = ['dn-6f96cbec', 'dn-bcee0027', 'dn-bafca691', 'dn-4de6b1de', 'dn-02c099a8']
  let daqBound = 0
  for (const nodeId of daqNodes) {
    const b = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: analyst.id, nodeId, kind: 'daq' })
    if (b.code === 0 || b.data?.binding) daqBound++
  }
  ok('分析师数采绑定', daqBound === daqNodes.length, `${daqBound}/${daqNodes.length}`)
  const rb = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: operator.id, nodeId: RECIPE_ID, kind: 'recipe', mode: 'manual' })
  ok('操作员配方绑定(manual)', Boolean(rb.data?.binding), rb.data?.binding?.mode ?? rb.message)

  // ── mailbox:lead → analyst ──
  const probe = `MAILBOX-PROBE-${TAG}`
  const send = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: leadId, tool: 'send_message_to_agent', args: { to_agent_id: analyst.id, message: probe },
  })
  ok('mailbox 发送(lead→analyst)', send.code === 0 && !send.data?.result?.isError, send.data?.result?.text ?? send.message)
  // 真实 Agent 会由运行时消费 mailbox 并起回合,poll_messages 可能已空;
  // 以 lead 的 mail 全览(含已消费/任务投递)作为投递证据。
  await sleep(2500)
  const members = await api('GET', `/api/workshop/channels/${channelId}/agents`)
  const leadRow = (members.data ?? []).find(a => a.id === leadId)
  const mailRes = leadRow?.token
    ? await fetch(`${BASE}/api/workshop/mailbox/all?limit=100`, { headers: { authorization: `Bearer ${leadRow.token}` } }).then(r => r.json())
    : null
  const delivered = (mailRes?.data ?? []).find(m => (m.parts ?? []).some(p => String(p.text ?? '').includes(probe)))
  ok('mailbox 投递(lead→analyst 消息落库)',
    Boolean(delivered) && delivered?.fromAgentId === leadId && delivered?.toAgentId === analyst.id,
    delivered ? `${delivered.fromAgentId?.slice(0, 8)}→${delivered.toAgentId?.slice(0, 8)} state=${delivered.state} ${probe}` : '未找到投递消息')

  // ── 任务派发:root → mock lead dispatch → mock worker ──
  const root = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    title: `dispatch-${TAG}`,
    description: 'Mock team dispatch probe: complete this task through the team.',
  })
  ok('root 任务提交(派发给 lead)', root.code === 0 && Boolean(root.data?.id), root.data?.id ?? root.message)
  const rootDone = await waitTask(root.data?.id, 120000)
  ok('lead 自动派发并完成', rootDone?.state === 'COMPLETED', `state=${rootDone?.state}`)

  // ── 数采分析:omp analyst ──
  const daqTask = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    assigneeId: analyst.id,
    title: `daq-${TAG}`,
    description: `Use line_context to confirm the line, then daq_query with line_id="${LINE_ID}" and node_id="dn-4de6b1de" (last_minutes=10). `
      + `Report the latest value and sample count, then call complete_task with summary "TEAM-DAQ-OK latest=<value>".`,
  })
  const daqDone = await waitTask(daqTask.data?.id, 300000)
  const daqText = artifactText(daqDone)
  ok('omp 数采分析任务完成', daqDone?.state === 'COMPLETED' && /daq_query|TEAM-DAQ-OK/i.test(daqText), `state=${daqDone?.state} deliverable=${daqText.slice(0, 160)}`)

  // ── 配方写入 + 下发(copilot,manual 绑定 → HITL)──
  const writeTask = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    assigneeId: operator.id,
    title: `recipe-${TAG}`,
    description: `You are the line operator. Use recipe_update with recipe_id="${RECIPE_ID}" and params=[{node_id:"${SPEED_NODE}", value:47}] `
      + `and reason="TEAM-WRITE-HITL ${TAG}: raised line speed within the 38-48 window based on stable DAQ". `
      + `The platform will ask a human to approve; wait for the tool result. Then call recipe_apply with recipe_id="${RECIPE_ID}" `
      + `and reason="TEAM-APPLY-HITL ${TAG}: apply the approved v+1 recipe". After both tools return success, call complete_task with summary "TEAM-WRITE-OK".`,
  })
  const writeTaskId = writeTask.data?.id
  // 与 agent 并行:批准两次人工卡(update → apply)
  const approved = await approveLoop(channelId, 240000, `TEAM-HITL ${TAG}: approved by acceptance operator`)
  const writeDone = await waitTask(writeTaskId, 60000)
  const writeText = artifactText(writeDone)
  ok('copilot 配方写入/下发任务完成', writeDone?.state === 'COMPLETED' && /recipe_update|recipe_apply|TEAM-WRITE-OK/i.test(writeText), `state=${writeDone?.state} deliverable=${writeText.slice(0, 160)}`)
  ok('manual 配方操作触发 HITL 并获批', approved >= 1, `approved=${approved}`)

  // ── 回读核验 ──
  const read = await api('POST', `/api/workshop/dcw/${SPEED_NODE}/read`, {})
  const readback = read.data?.read?.value
  ok('PLC 回读=47(下发真实生效)', Number(readback) === 47, `readback=${readback}`)
  const agg = await api('GET', '/api/workshop/dcw')
  const recipe = (agg.data?.recipes ?? []).find(r => r.id === RECIPE_ID)
  ok('配方版本递增', Number(recipe?.version ?? 0) >= 2, `version=${recipe?.version}`)

  console.log(`\n=== 团队/产线/HITL: ${pass} PASS / ${fail} FAIL ===`)
  if (OUT) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), channelId, lineId: LINE_ID, recipeId: RECIPE_ID, pass, fail, checks }, null, 2))
  }
  process.exit(fail > 0 ? 1 : 0)
}
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
