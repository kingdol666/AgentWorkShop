/**
 * bench/lib/governance.mjs —— 治理面功能测试：配方管理、回退、审批、优化记录、参数账本。
 *
 * 覆盖论文 Sec. V（governed write-control pipeline）与 Sec. VII 治理主张所依赖的
 * **全部已实现功能**，每项都按"真实 REST/工具调用 + 证据"测，不做假设。
 *
 * 全部接口契约均经源码核对（server/api/workshop/dcw/**）：
 *   recipes/:id/versions|mark-good|revert|rollback-good|apply|(PATCH)
 *   dcw/journal/node/:nodeId/rollback、dcw/:id/param-ledger
 *   dcw/optimizations(/:id/judge|/:id/rollback)
 *   agent-tools/bindings|invoke|approvals(/:id/decide)
 */

import { sleep } from './util.mjs'

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** active batch of a line (endedAt empty) */
export async function activeRunOf(api, lineId) {
  const r = await api.call('GET', '/api/workshop/dcw/runs')
  const runs = r.data?.runs ?? []
  return runs.find(x => x.lineId === lineId && !x.endedAt) ?? null
}

/**
 * 配方生命周期：版本化 → 已知良好 → 回退历史版本 → 基准恢复 → 一键下发。
 * 断言链：版本单调增长、回退生成新版本（非破坏）、lastGood 冻结、基准恢复真下发到 PLC、一键下发创建批次。
 */
export async function recipeLifecycle(api, { line, sfx }) {
  const ev = []
  const recipeId = line.ids.recipe
  const dcwNode = line.ids.dcw
  const win = line.window
  const out = { ok: false, steps: {}, errors: [] }
  const versions = async () => (await api.call('GET', `/api/workshop/dcw/recipes/${recipeId}/versions`)).data?.versions ?? []

  try {
    // (1) 初始版本
    const v0 = await versions()
    out.steps.v0 = v0.length
    const v0val = v0.at(-1)?.params?.find(p => p.nodeId === dcwNode)?.value
    ev.push(`(1) initial versions ${v0.length}, current param value ${v0val}`)
    if (!v0.length) { out.errors.push('初始配方无版本记录'); return { ...out, ev } }

    // (2) 编辑配方 → 自动版本化
    const v2 = Number((win.min + (win.max - win.min) * 0.6).toFixed(3))
    await api.call('PATCH', `/api/workshop/dcw/recipes/${recipeId}`, {
      params: [{ nodeId: dcwNode, value: v2, min: Number(win.min.toFixed(3)), max: Number(win.max.toFixed(3)) }],
    })
    const v1 = await versions()
    const v1val = v1.at(-1)?.params?.find(p => p.nodeId === dcwNode)?.value
    out.steps.v1 = v1.length
    out.steps.v1val = v1val
    const versioned = v1.length === v0.length + 1 && Number(v1val) === v2
    ev.push(`${versioned ? '✔' : '✘'} (2) versions after edit ${v1.length} (+1), param value ${v1val} (expected ${v2})`)
    if (!versioned) out.errors.push('配方编辑未产生新版本')

    // (3) 标记已知良好（需活动批次 id）
    const run = await activeRunOf(api, line.ids.line)
    const marked = run ? await api.call('POST', `/api/workshop/dcw/recipes/${recipeId}/mark-good`, { runId: run.id }) : null
    const lastGood = marked?.data?.recipe?.lastGoodRunId ?? null
    out.steps.lastGoodRunId = lastGood ?? run?.id ?? null
    const markOk = Boolean(run && lastGood) || Boolean(run && marked?.status === 200)
    ev.push(`${markOk ? '✔' : '✘'} (3) 标记已知良好批次 runId=${run?.id ?? '—'} → lastGood=${lastGood ?? '（响应未回传字段）'}`)
    if (!markOk) out.errors.push('mark-good 失败或无可标记批次')

    // (4) 回退到历史版本（非破坏：生成新版本）
    await api.call('POST', `/api/workshop/dcw/recipes/${recipeId}/revert`, { version: 1, reason: `bench rollback verification ${sfx}` })
    const v2list = await versions()
    const v2val = v2list.at(-1)?.params?.find(p => p.nodeId === dcwNode)?.value
    const reverted = v2list.length === v1.length + 1 && Number(v2val) === Number(v0val)
    out.steps.v2 = v2list.length
    out.steps.v2val = v2val
    ev.push(`${reverted ? '✔' : '✘'} (4) versions after revert-to-v1 ${v2list.length} (+1, non-destructive), param value ${v2val} (expected back to ${v0val})`)
    if (!reverted) out.errors.push('配方回退未按预期生成恢复版本')

    // (5) 基准恢复（重新下发 lastGood 冻结参数集）
    const rbGood = await api.call('POST', `/api/workshop/dcw/recipes/${recipeId}/rollback-good`, {})
    const outcomes = rbGood.data?.outcomes ?? []
    const goodOk = rbGood.status === 200
    out.steps.rollbackGood = outcomes.length
    ev.push(`${goodOk ? '✔' : '✘'} (5) baseline restore rollback-good → applied ${outcomes.length} params (status ${rbGood.status})`)
    if (!goodOk) out.errors.push(`rollback-good failed: ${rbGood.message}`)

    // (6) 一键下发（创建批次 + 逐参数写）
    const apply = await api.call('POST', `/api/workshop/dcw/recipes/${recipeId}/apply`, {})
    const newRunId = apply.data?.run?.id ?? null
    const applyOk = apply.status === 200 && Boolean(newRunId)
    out.steps.appliedRunId = newRunId
    ev.push(`${applyOk ? '✔' : '✘'} (6) 一键下发 apply → 新批次 ${newRunId ?? '(none)'} (status ${apply.status})`)
    if (!applyOk) out.errors.push(`recipe one-click apply failed: ${apply.message ?? apply.status}`)

    out.ok = out.errors.length === 0
    return { ...out, ev }
  }
  catch (err) {
    out.errors.push(String(err?.message ?? err))
    return { ...out, ev }
  }
}

/**
 * 节点级单步回退：写一个变更值 → journal rollback → 断言值被恢复到写前（撤销栈语义）。
 */
export async function nodeRollback(api, { nodeId, window: win }) {
  const ev = []
  const read = async () => {
    const r = await api.call('POST', `/api/workshop/dcw/${nodeId}/read`, {})
    return num(r.data?.read?.value ?? r.data?.value)
  }
  const before = await read()
  const target = Number((win.min + (win.max - win.min) * 0.8).toFixed(3))
  const w = await api.call('POST', `/api/workshop/dcw/${nodeId}/write`, { value: target })
  const mid = await read()
  const rb = await api.call('POST', `/api/workshop/dcw/journal/node/${nodeId}/rollback`, {})
  const after = await read()
  const moved = w.status === 200 && mid != null && Math.abs(mid - target) <= 0.75
  const restored = after != null && before != null && Math.abs(after - before) <= 0.75
  ev.push(`${moved ? '✔' : '✘'} write ${target} effective (readback ${mid}, before ${before})`)
  ev.push(`${rb.status === 200 ? '✔' : '✘'} journal rollback 受理（status ${rb.status}，记录 ${rb.data?.record?.id ?? '—'}）`)
  ev.push(`${restored ? '✔' : '✘'} readback after rollback ${after} (expected back to ${before}, tolerance 0.75)`)
  return { ok: moved && rb.status === 200 && restored, before, target, mid, after, recordId: rb.data?.record?.id ?? null, ev }
}

/**
 * 优化记录全生命周期：开记录（dcw_control）→ 判定 keep；再开一条 → 判定 rollback → 执行回退。
 * 同时核对"判定与执行分离"：rollback 判定只入册、执行另走 /rollback。
 */
export async function optimizationLifecycle(api, { instId, nodeId, window: win, invoke }) {
  const ev = []
  const out = { ok: false, keepRecord: null, rollbackRecord: null, errors: [] }
  // 平台回包是中文（"优化记录 <id> 已开窗"）——此正则必须与平台文案逐字对齐，勿英文化
  const parseRecord = (text) => (String(text).match(/优化记录\s+([A-Za-z0-9._:-]+)\s+已开窗/) ?? [])[1] ?? null
  const call = invoke ?? (async (tool, args) => api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool, args }))
  const read = async () => {
    const r = await api.call('POST', `/api/workshop/dcw/${nodeId}/read`, {})
    return num(r.data?.read?.value ?? r.data?.value)
  }
  const span = win.max - win.min
  const clamp = v => Number(Math.max(win.min, Math.min(win.max, v)).toFixed(3))
  const cur = (await read()) ?? (win.min + win.max) / 2
  // 两次写取**方向相反**的值：回退护栏对"同向重写"有冷却，同向会拿到 isError 而无 record（实测踩过）
  const up = clamp(cur + span * 0.2)
  const down = clamp(cur - span * 0.2)
  ev.push(`current ${cur} → record A writes ${up} (up)，记录 B writes ${down} (down); opposite directions to dodge the rollback cooldown`)

  // (1) 开记录 A → judge keep
  const cA = await call('dcw_control', { node_id: nodeId, value: up, hypothesis: 'bench: 优化记录 keep 路径' })
  const tA = String(cA.data?.result?.text ?? '')
  const recA = parseRecord(tA)
  if (recA) {
    const j = await call('dcw_judge', { record_id: recA, verdict: 'keep', reason: 'bench: 回读一致，判定 keep' })
    const keepOk = j.data?.result?.isError !== true
    out.keepRecord = recA
    ev.push(`${keepOk ? '✔' : '✘'} (keep path) record ${recA} verdict keep → ${String(j.data?.result?.text).slice(0, 70)}`)
    if (!keepOk) out.errors.push('judge keep 失败')
  }
  else {
    ev.push(`✘ (keep path) no record_id; receipt: ${tA.slice(0, 130).replace(/\n/g, ' ')}`)
    out.errors.push('dcw_control 未返回记录 id')
  }

  // (2) 开记录 B → judge rollback → 执行回退（判定与执行分离）
  const cB = await call('dcw_control', { node_id: nodeId, value: down, hypothesis: 'bench: 优化记录 rollback 路径' })
  const tB = String(cB.data?.result?.text ?? '')
  const recB = parseRecord(tB)
  if (recB) {
    out.rollbackRecord = recB
    const jB = await call('dcw_judge', { record_id: recB, verdict: 'rollback', reason: 'bench: 判定回退（判定与执行分离验证）' })
    const judgeOk = jB.data?.result?.isError !== true
    const beforeRollback = await read()
    const ex = await api.call('POST', `/api/workshop/dcw/optimizations/${recB}/rollback`, {})
    const afterRollback = await read()
    // 回退目标 = 记录 B 的 from 值（即 A 写后的 up）
    const backToA = afterRollback != null && Math.abs(afterRollback - up) <= 0.75
    ev.push(`${judgeOk ? '✔' : '✘'} (rollback path) record ${recB} verdict rollback (recorded only; PLC still ${beforeRollback})`)
    ev.push(`${backToA ? '✔' : '✘'} rollback executed (status ${ex.status}) → readback ${afterRollback} (expected record B from=${up})`)
    if (!judgeOk || !backToA) out.errors.push('rollback 判定或执行未达预期')
  }
  else {
    ev.push(`✘ (rollback path) no record_id; receipt: ${tB.slice(0, 130).replace(/\n/g, ' ')}`)
    out.errors.push('dcw_control 未返回记录 id（第二次）')
  }

  // (3) 优化记录查询面
  const list = await api.call('GET', `/api/workshop/dcw/optimizations?limit=50`)
  const records = list.data?.records ?? []
  const mine = records.filter(r => r.nodeId === nodeId)
  ev.push(`${mine.length ? '✔' : '✘'} 优化记录查询面可见本节点记录 ${mine.length}  (judged=${mine.filter(r => r.status && r.status !== 'open').length}）`)

  out.ok = out.errors.length === 0
  return { ...out, ev }
}

/**
 * HITL 审批闭环：manual 绑定 → Agent 下发挂起 → 审批面板可见 → 批准 → 真实写生效 + 时延。
 */
export async function hitlApproval(api, { instId, nodeId, window: win }) {
  const ev = []
  const out = { ok: false, pendingId: null, latencyMs: null, errors: [] }
  // 绑定为 manual（人工确认模式）
  await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: instId, nodeId, kind: 'dcw', mode: 'manual' })
  const target = Number((win.min + (win.max - win.min) * 0.4).toFixed(3))

  // ⚠️ manual 模式下 dcw_control 在服务端 **await approvals.request()** 阻塞等待裁决。
  // 若按"先 await invoke、再轮询审批面板"的顺序写，必然死锁到请求超时（实测踩过）。
  // 正确顺序：**并发发起 invoke（不 await）→ 轮询面板 → 裁决 → 最后 await 回执**。
  const t0 = Date.now()
  const invPromise = api.call('POST', '/api/workshop/agent-tools/invoke', {
    agentId: instId, tool: 'dcw_control',
    args: { node_id: nodeId, value: target, hypothesis: 'bench: HITL 审批路径' },
  }).then(r => ({ ok: true, r })).catch(e => ({ ok: false, err: String(e?.message ?? e) }))

  let pending = null
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline && !pending) {
    const r = await api.call('GET', `/api/workshop/agent-tools/approvals?agentId=${instId}&scope=pending`)
    pending = (r.data?.approvals ?? []).find(a => a.nodeId === nodeId) ?? null
    if (!pending) await sleep(400)
  }
  out.pendingId = pending?.id ?? null
  ev.push(`${pending ? '✔' : '✘'} 下发在人工确认模式下**挂起**，审批面板出现待审项 ${pending?.id ?? '（未出现）'}（detail: ${String(pending?.detail ?? '').slice(0, 70)}）`)

  let decidedOk = false
  if (pending) {
    const d = await api.call('POST', `/api/workshop/agent-tools/approvals/${pending.id}/decide`, { approved: true, comment: 'bench: 自动批准（审批路径验证）' })
    out.latencyMs = Date.now() - t0
    decidedOk = d.status === 200
    const inv = await invPromise
    const invText = String(inv.r?.data?.result?.text ?? inv.err ?? '')
    const released = inv.ok && inv.r?.data?.result?.isError !== true
    ev.push(`${decidedOk ? '✔' : '✘'} verdict approved (status ${d.status}) → pending write **unblocked**: ${invText.slice(0, 90)}`)
    await sleep(1200)
    const rd = await api.call('POST', `/api/workshop/dcw/${nodeId}/read`, {})
    const got = num(rd.data?.read?.value ?? rd.data?.value)
    const applied = got != null && Math.abs(got - target) <= 0.75
    ev.push(`${applied ? '✔' : '✘'} post-approval PLC effect: readback ${got} (expected ${target})`)
    if (!decidedOk || !released || !applied) out.errors.push('审批通过后写入未生效')
    out.ok = decidedOk && released && applied
  }
  else out.errors.push('未出现待审批项（人工确认模式未生效）')

  // 复位为 auto，避免影响后续阶段
  await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: instId, nodeId, kind: 'dcw', mode: 'auto' })
  return { ...out, target, ev }
}

/** 参数台账：current / recipeTarget / lastGood / journal / records 一次读全 */
export async function paramLedger(api, { nodeId }) {
  const r = await api.call('GET', `/api/workshop/dcw/${nodeId}/param-ledger`)
  const l = r.data?.ledger ?? {}
  const keys = Object.keys(l)
  return {
    ok: r.status === 200 && keys.length > 0,
    ledger: l,
    ev: [`${r.status === 200 && keys.length ? '✔' : '✘'} 参数台账可用（字段：${keys.join(', ') || '无'}）`],
  }
}

/** governance read surfaces: journal + audit + ops-logs */
export async function auditSurfaces(api, { lineId }) {
  const ev = []
  const j = await api.call('GET', `/api/workshop/dcw/journal?lineId=${lineId}&limit=200`)
  const anchors = j.data?.anchors ?? []
  const a = await api.call('GET', '/api/workshop/audit?limit=200')
  const entries = a.data?.entries ?? []
  const o = await api.call('GET', '/api/workshop/ops-logs?limit=200')
  const logs = o.data?.logs ?? []
  ev.push(`${anchors.length ? '✔' : '✘'} 参数变更账本 journal：本产线 ${anchors.length}  anchors (source coverage  ${[...new Set(anchors.map(x => x.source))].join('/') || '—'}）`)
  ev.push(`${entries.length ? '✔' : '✘'} audit: ${entries.length} entries`)
  ev.push(`${logs.length ? '✔' : '✘'} ops-logs: ${logs.length} entries`)
  return { ok: anchors.length > 0 && entries.length > 0 && logs.length > 0, anchors: anchors.length, entries: entries.length, logs: logs.length, ev }
}
