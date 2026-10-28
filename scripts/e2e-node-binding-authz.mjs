#!/usr/bin/env node
/**
 * 节点级写授权(双轨授权)实机 E2E —— 隔离实例 + 真实 HTTP + agent token 自证。
 *
 * 覆盖 docs/plans/2026-10-28-node-scoped-binding-plan.md 的 US-01..US-05:
 *   M1 REST 恢复 kind='dcw' 绑定(operate 权限 + 首绑 manual + confirm 切 auto)
 *   M2 双轨授权:trial 覆盖集 ⊆ 节点绑定面 / apply 全覆盖 / update 版本权仍归配方绑定
 *   M3 换配方:line_id 解析活动配方,节点绑定 Agent 无需新绑定继续操作
 *   M4 委派建/撤 dcw 绑定 + 在飞审批收回即失活 + 频道 manual 钳位叠加
 *   M5 回归:越线绑定拒绝、tool-verify 写面拒绝、直写工具仍不可达
 *
 * 运行:node scripts/e2e-node-binding-authz.mjs
 * 证据:docs/audit/evidence/2026-10-28-node-binding-authz/report.json(可用 AW_E2E_EVIDENCE 覆盖)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TAG = `nb${Date.now().toString(36).slice(-4)}`
const ROOT = join(tmpdir(), `aw-node-binding-e2e-${TAG}`)
mkdirSync(join(ROOT, 'home'), { recursive: true })
writeFileSync(join(ROOT, 'home', 'runtime-settings.json'), JSON.stringify({
  version: 1,
  overrides: { 'security.hitl_timeout_ms': 20_000 },
}))
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 600)}`}`)
  return Boolean(cond)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port = 0
for (const p of [3983, 3982, 3981, 3980]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1200) })
    if (r.ok) continue
  }
  catch { /* 空闲 */ }
  port = p
  break
}
if (!port) {
  console.error('无空闲端口')
  process.exit(1)
}
const BASE = `http://127.0.0.1:${port}`
process.env.NO_PROXY = '127.0.0.1,localhost'
const logFd = openSync(join(ROOT, 'dev.log'), 'a')
const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', String(port)], {
  cwd: REPO,
  env: {
    ...process.env,
    AW_MODE: 'home',
    AW_HOME: join(ROOT, 'home'),
    AW_RATE_LIMIT_OFF: '1',
    AW_TRIAL_INTERVAL_MS: '0',
    NUXT_SESSION_PASSWORD: 'NodeBinding#2026-e2e-key',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

async function api(method, path, body, token, extraHeaders = {}, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...json }
}
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)
const dbPath = join(ROOT, 'home', 'data', 'workshop.sqlite')
const agentTokenOf = (agentId) => {
  const db = new DatabaseSync(dbPath)
  try {
    return String(db.prepare('SELECT token FROM channel_agents WHERE id = ?').get(agentId)?.token ?? '')
  }
  finally {
    db.close()
  }
}

async function waitPending(agentId, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const r = await api('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(agentId)}`, undefined, admin)
    const card = (r?.data?.approvals ?? []).find(a => a.status === 'pending')
    if (card) return card
    await sleep(300)
  }
  return null
}

async function decide(cardId, approved, comment) {
  return api('POST', `/api/workshop/agent-tools/approvals/${cardId}/decide`, { approved, comment }, admin)
}

let admin = ''
try {
  let healthy = false
  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    try {
      const h = await api('GET', '/api/health', undefined, undefined, {}, 3000)
      if (h?.data?.status === 'ok' && h?.data?.workshop === 'ready') {
        healthy = true
        break
      }
    }
    catch { /* 未就绪 */ }
  }
  ok('T0', '隔离实例启动 + workshop ready', healthy, `port=${port}`)
  if (!healthy) throw new Error('实例未就绪')

  admin = (await api('POST', '/api/users/register', { name: `nb-admin-${TAG}`, email: `nb-${TAG}@awshop.local`, password: 'NbAdmin#2026' })).data?.token
  ok('T0b', 'admin 注册', Boolean(admin))

  // 普通用户(只读授权)用于验证 dcw 写向绑定需要 operate
  const plainEmail = `nb-plain-${TAG}@awshop.local`
  const created = await api('POST', '/api/users', { name: `nb-plain-${TAG}`, email: plainEmail, password: 'NbPlain#2026', role: 'user' }, admin)
  const plainId = created?.data?.id ?? created?.data?.user?.id ?? ''
  const plain = (await api('POST', '/api/users/login', { email: plainEmail, password: 'NbPlain#2026' })).data?.token
  ok('T0c', '普通用户创建+登录', Boolean(plainId && plain), `create=${created.status} id=${plainId}`)

  // ── 场景:产线 + 3 个数控节点 + 产品 + 配方 A,开跑 ──
  const line = (await api('POST', '/api/workshop/dcw/lines', { name: `节点授权线-${TAG}` }, admin)).data?.line?.id
  await api('PUT', '/api/workshop/permissions', { userId: plainId, grants: [{ lineId: line, mode: 'readonly' }] }, admin)
  // 自定义参数模板(0~100℃):内置模板的安全量程是 150~200℃,与本场景候选值不匹配
  const tpl = (await api('POST', '/api/workshop/dcw/templates', { name: `授权参数-${TAG}`, ch: '温度', unit: '℃', min: 0, max: 100, decimals: 1 }, admin)).data?.template?.key
  const nodeBody = i => ({
    templateRef: tpl,
    name: `授权节点${i}-${TAG}`,
    driver: 'mock',
    lineId: line,
    stepLimit: 20,
    writeLockSeconds: 0,
    readIntervalMs: 0,
    driverConfig: { key: `nb-${TAG}-${i}` },
  })
  const n1 = (await api('POST', '/api/workshop/dcw', nodeBody(1), admin)).data?.node?.id
  const n2 = (await api('POST', '/api/workshop/dcw', nodeBody(2), admin)).data?.node?.id
  const n3 = (await api('POST', '/api/workshop/dcw', nodeBody(3), admin)).data?.node?.id
  const product = (await api('POST', '/api/workshop/dcw/products', { lineId: line, name: `授权产品-${TAG}` }, admin)).data?.product?.id
  const recipeA = (await api('POST', '/api/workshop/dcw/recipes', {
    productId: product,
    name: `配方A-${TAG}`,
    opIntervalMs: 0,
    params: [{ nodeId: n1, value: 50 }, { nodeId: n2, value: 50 }],
  }, admin)).data?.recipe?.id
  ok('T1', '产线/参数模板/3 数控节点/产品/配方A 就绪', Boolean(line && tpl && n1 && n2 && n3 && product && recipeA), JSON.stringify({ line, tpl, n1, n2, n3, recipeA }))
  const startA = await api('POST', `/api/workshop/dcw/lines/${line}/start`, { recipeId: recipeA }, admin)
  ok('T1b', '产线开跑(配方A 整批下发,活动批次建立)', startA.status === 200 && Boolean(startA?.data?.run?.id), `status=${startA.status} msg=${String(startA?.message ?? '').slice(0, 160)}`)

  // 产线总闸切 auto(绑定 manual 仍是 manual;后续显式 PATCH 绑定)
  const lineAuto = await api('PATCH', `/api/workshop/dcw/lines/${line}`, { controlMode: 'auto', confirm: true }, admin)
  ok('T1c', '产线 controlMode 切 auto(confirm)', lineAuto.status === 200 && lineAuto?.data?.line?.controlMode === 'auto', `status=${lineAuto.status}`)

  // ── 频道(绑线)+ lead + 3 worker ──
  const ch = (await api('POST', '/api/workshop/channels', { name: `节点授权频道-${TAG}`, leadAgent: { name: `nb-lead-${TAG}`, harness: 'mock' } }, admin)).data
  const channelId = ch?.channelId
  const leadId = String(ch?.leadAgent?.id ?? ch?.leadAgentId ?? '')
  await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId: line }, admin)
  const w1raw = (await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: `nb-w1-${TAG}`, harness: 'mock', role: 'worker' }, admin)).data
  const w2raw = (await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: `nb-w2-${TAG}`, harness: 'mock', role: 'worker' }, admin)).data
  const w3raw = (await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: `nb-w3-${TAG}`, harness: 'mock', role: 'worker' }, admin)).data
  const w1 = String(w1raw?.id ?? w1raw?.agentId ?? '')
  const w2 = String(w2raw?.id ?? w2raw?.agentId ?? '')
  const w3 = String(w3raw?.id ?? w3raw?.agentId ?? '')
  ok('T2', '频道绑线 + lead + 3 worker', Boolean(channelId && leadId && w1 && w2 && w3), JSON.stringify({ channelId, leadId, w1, w2, w3 }))
  const tok = { lead: agentTokenOf(leadId), w1: agentTokenOf(w1), w2: agentTokenOf(w2), w3: agentTokenOf(w3) }
  ok('T2b', 'Agent token 自证可用(4 个独立 token)', Object.values(tok).every(t => t.length > 20), JSON.stringify(Object.fromEntries(Object.entries(tok).map(([k, v]) => [k, v.length]))))

  const callAs = (agentId, token, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, undefined, { 'x-aw-agent-token': token })
  const bind = (agentId, nodeId, kind, mode) => api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId, kind, ...(mode ? { mode } : {}) }, admin)
  const setBindingMode = (id, mode, confirm = false) => api('PATCH', `/api/workshop/agent-tools/bindings/${id}`, confirm ? { mode, confirm: true } : { mode }, admin)

  // ── M1:dcw 绑定恢复 + 首绑 manual + readonly 403 + confirm 切 auto ──
  const b1 = await bind(w1, n1, 'dcw', 'auto')
  ok('T3', 'POST kind=dcw 绑定 → 200 且首绑强制 manual(modeForced 回执)',
    b1.status === 200 && b1?.data?.binding?.mode === 'manual' && b1?.data?.modeForced === 'manual',
    `status=${b1.status} mode=${b1?.data?.binding?.mode} forced=${b1?.data?.modeForced} msg=${String(b1?.message ?? '').slice(0, 160)}`)
  const b1Id = String(b1?.data?.binding?.id ?? '')

  const plainBind = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: w1, nodeId: n1, kind: 'dcw' }, plain)
  ok('T3b', '只读用户建 dcw 绑定 → 403(写授权面需 operate)', plainBind.status === 403, `status=${plainBind.status} code=${String(plainBind?.code ?? '')} msg=${String(plainBind?.message ?? '').slice(0, 160)}`)

  const noConfirm = await setBindingMode(b1Id, 'auto')
  ok('T3c', '绑定 manual→auto 无 confirm → 400 MODE_CONFIRM_REQUIRED', noConfirm.status === 400 && noConfirm?.code === 'MODE_CONFIRM_REQUIRED', `status=${noConfirm.status} code=${String(noConfirm?.code ?? '')}`)
  const withConfirm = await setBindingMode(b1Id, 'auto', true)
  ok('T3d', '绑定 manual→auto 携 confirm:true → 200 auto', withConfirm.status === 200 && withConfirm?.data?.binding?.mode === 'auto', `status=${withConfirm.status} mode=${withConfirm?.data?.binding?.mode}`)
  const listW1 = await api('GET', `/api/workshop/agent-tools/list?agentId=${encodeURIComponent(w1)}`, undefined, undefined, { 'x-aw-agent-token': tok.w1 })
  const trialDesc = String((listW1?.data?.tools ?? []).find(t => t.name === 'recipe_trial')?.description ?? '')
  ok('T3e', '工具注入面带点位写授权清单(模型无需探测绑定面)', trialDesc.includes(n1) && /写授权面/.test(trialDesc), trialDesc.slice(-240))

  // ── M4:频道 manual 钳位对节点绑定 Agent 同样生效(挂 HITL,批准后执行) ──
  const chManual = await api('PATCH', `/api/workshop/channels/${channelId}/execution-mode`, { mode: 'manual' }, admin)
  ok('T4', '频道切 manual(降险方向免 confirm)', chManual.status === 200 && chManual?.data?.executionMode === 'manual', `status=${chManual.status} mode=${chManual?.data?.executionMode}`)
  const trialP = callAs(w1, tok.w1, 'recipe_trial', {
    line_id: line,
    params: [{ node_id: n1, value: 55 }],
    hypothesis: 'E2E:频道 manual 钳位对节点绑定 Agent 生效',
  })
  const cardM = await waitPending(w1, 15_000)
  ok('T4b', '频道 manual + dcw auto 绑定 → trial 挂起人工审批', Boolean(cardM), cardM ? `card=${cardM.id}` : '未出现审批卡')
  if (cardM) await decide(cardM.id, true, 'E2E 批准:频道 manual 钳位验证')
  const trialM = await trialP
  ok('T4c', '人工批准后节点绑定 trial 执行成功(ACK 证实)', !invErr(trialM) && /试验已整批下发/.test(invText(trialM)), invText(trialM).slice(0, 240))
  const chAuto = await api('PATCH', `/api/workshop/channels/${channelId}/execution-mode`, { mode: 'auto', confirm: true }, admin)
  ok('T4d', '频道切回 auto(confirm)', chAuto.status === 200 && chAuto?.data?.executionMode === 'auto', `status=${chAuto.status} mode=${chAuto?.data?.executionMode}`)

  // ── M2:覆盖集判定 ──
  const trialOk = await callAs(w1, tok.w1, 'recipe_trial', { line_id: line, params: [{ node_id: n1, value: 56 }], hypothesis: 'E2E:节点绑定覆盖集内' })
  ok('T5', 'trial 覆盖集 ⊆ 节点绑定面 → 成功(line_id 解析活动配方)', !invErr(trialOk) && /试验已整批下发/.test(invText(trialOk)), invText(trialOk).slice(0, 220))
  const trialNo = await callAs(w1, tok.w1, 'recipe_trial', { line_id: line, params: [{ node_id: n2, value: 56 }], hypothesis: 'E2E:未授权节点' })
  ok('T5b', 'trial 含未授权节点 → 写面拒绝且点名节点', invErr(trialNo) && /写授权|绑定面/.test(invText(trialNo)) && invText(trialNo).includes(n2), invText(trialNo).slice(0, 260))
  const applyNo = await callAs(w1, tok.w1, 'recipe_apply', { line_id: line, reason: 'E2E:部分覆盖整批下发应被拒' })
  ok('T5c', 'apply 整批(2 参数)仅 1 节点绑定 → 拒绝并给出补绑指引', invErr(applyNo) && /补绑|绑定该配方|不在你的数控节点绑定面/.test(invText(applyNo)), invText(applyNo).slice(0, 260))
  const updateNo = await callAs(w1, tok.w1, 'recipe_update', { line_id: line, params: [{ node_id: n1, value: 57 }], reason: 'E2E:节点绑定不应授予版本权' })
  ok('T5d', 'recipe_update(版本操作)纯 dcw 绑定 → 拒绝', invErr(updateNo) && /版本操作|配方级操作权/.test(invText(updateNo)), invText(updateNo).slice(0, 240))

  // 绑定第二节点 → apply 全覆盖放行
  const b2 = await bind(w1, n2, 'dcw', 'auto')
  await setBindingMode(String(b2?.data?.binding?.id ?? ''), 'auto', true)
  ok('T6', '补齐第二节点绑定(auto)', b2.status === 200 && b2?.data?.binding?.kind === 'dcw', `status=${b2.status} id=${b2?.data?.binding?.id}`)
  const applyOk = await callAs(w1, tok.w1, 'recipe_apply', { line_id: line, reason: 'E2E:全覆盖整批下发' })
  ok('T6b', 'apply 全覆盖 → 成功(整批 ACK 证实)', !invErr(applyOk) && /已整批下发/.test(invText(applyOk)), invText(applyOk).slice(0, 240))

  // ── US-05:收权即失活 ──
  const revoke1 = await api('DELETE', `/api/workshop/agent-tools/bindings/${b1Id}`, undefined, admin)
  ok('T7', '删除 n1 绑定 200', revoke1.status === 200, `status=${revoke1.status}`)
  const afterRevoke = await callAs(w1, tok.w1, 'recipe_trial', { line_id: line, params: [{ node_id: n1, value: 58 }], hypothesis: 'E2E:收权后应拒绝' })
  ok('T7b', '撤销 n1 绑定后 trial n1 → 拒绝(收权即失活)', invErr(afterRevoke) && /写授权|绑定面/.test(invText(afterRevoke)), invText(afterRevoke).slice(0, 220))

  // ── M3:换配方(rc-A → rc-B),节点绑定 Agent 无需新绑定 ──
  const stopA = await api('POST', `/api/workshop/dcw/lines/${line}/stop`, undefined, admin)
  const recipeB = (await api('POST', '/api/workshop/dcw/recipes', {
    productId: product,
    name: `配方B-${TAG}`,
    opIntervalMs: 0,
    params: [{ nodeId: n1, value: 45 }, { nodeId: n3, value: 65 }],
  }, admin)).data?.recipe?.id
  const startB = await api('POST', `/api/workshop/dcw/lines/${line}/start`, { recipeId: recipeB }, admin)
  ok('T8', '换配方:停 A 开 B(活动批次切换)', stopA.status === 200 && startB.status === 200 && Boolean(recipeB), `stop=${stopA.status} start=${startB.status} recipeB=${recipeB}`)
  const b1again = await bind(w1, n1, 'dcw', 'auto')
  await setBindingMode(String(b1again?.data?.binding?.id ?? ''), 'auto', true)
  const b3 = await bind(w1, n3, 'dcw', 'auto')
  await setBindingMode(String(b3?.data?.binding?.id ?? ''), 'auto', true)
  ok('T8b', '为配方B 绑定 n1+n3 点位授权', b1again.status === 200 && b3.status === 200, `status=${b1again.status}/${b3.status}`)
  const trialB = await callAs(w1, tok.w1, 'recipe_trial', { line_id: line, params: [{ node_id: n3, value: 66 }], hypothesis: 'E2E:换配方后节点绑定继续生效' })
  ok('T8c', '换配方后同一 Agent 对 B 的已授权节点 trial 成功(无新配方绑定)', !invErr(trialB) && /试验已整批下发/.test(invText(trialB)), invText(trialB).slice(0, 240))
  const bW2 = await bind(w2, recipeA, 'recipe')
  ok('T8d', 'w2 绑定配方A(配方级操作权)', bW2.status === 200, `status=${bW2.status}`)
  const trialW2 = await callAs(w2, tok.w2, 'recipe_trial', { line_id: line, params: [{ node_id: n1, value: 47 }], hypothesis: 'E2E:配方绑定不随换配方生效' })
  ok('T8e', '配方绑定 Agent 对 B 仍被拒(授权是配方级,不随换配方漂移)', invErr(trialW2) && /绑定面|未绑定/.test(invText(trialW2)), invText(trialW2).slice(0, 240))

  // ── M4:委派建/撤 dcw 绑定 + 在飞审批收回即失活 ──
  const leadBind = await bind(leadId, n1, 'dcw', 'auto')
  await setBindingMode(String(leadBind?.data?.binding?.id ?? ''), 'auto', true)
  const grant = await callAs(leadId, tok.lead, 'team_grant_nodes', { agent_id: w3, node_ids: [n1], mode: 'auto' })
  ok('T9', 'lead 委派 dcw 节点给 worker(team_grant_nodes)成功', !invErr(grant) && /已把\s*1\s*条节点授权授予/.test(invText(grant)), invText(grant).slice(0, 240))
  const w3b = await api('GET', `/api/workshop/agent-tools/bindings?agentId=${encodeURIComponent(w3)}`, undefined, admin)
  const w3has = (w3b?.data?.bindings ?? []).some(b => b.nodeId === n1 && b.kind === 'dcw')
  ok('T9b', '委派落库:worker 绑定面出现 n1(dcw)', w3has, JSON.stringify(w3b?.data?.bindings ?? []).slice(0, 280))

  const chManual2 = await api('PATCH', `/api/workshop/channels/${channelId}/execution-mode`, { mode: 'manual' }, admin)
  ok('T9c', '频道 manual(为在飞审批收回测试)', chManual2.status === 200, `status=${chManual2.status}`)
  const trialW3P = callAs(w3, tok.w3, 'recipe_trial', { line_id: line, params: [{ node_id: n1, value: 46 }], hypothesis: 'E2E:委派绑定在飞审批' })
  const cardW3 = await waitPending(w3, 15_000)
  ok('T9d', '委派绑定(auto)在频道 manual 下仍挂人工审批', Boolean(cardW3), cardW3 ? `card=${cardW3.id}` : '未出现审批卡')
  const revoke = await callAs(leadId, tok.lead, 'team_revoke_nodes', { agent_id: w3, node_ids: [n1] })
  ok('T9e', 'lead 收回委派(dcw 写授权)', !invErr(revoke) && /已收回\s*1\s*条授权/.test(invText(revoke)), invText(revoke).slice(0, 220))
  const trialW3 = await trialW3P
  ok('T9f', '收回后在飞审批按拒收敛(trial 未执行)', /未批准|失效|授权/.test(invText(trialW3)), invText(trialW3).slice(0, 220))
  const pendW3 = await api('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(w3)}`, undefined, admin)
  ok('T9g', '审批面板无残留 pending(收回即失活)', (pendW3?.data?.approvals ?? []).filter(a => a.status === 'pending').length === 0, JSON.stringify((pendW3?.data?.approvals ?? []).slice(0, 3)).slice(0, 240))
  const trialW3After = await callAs(w3, tok.w3, 'recipe_trial', { line_id: line, params: [{ node_id: n1, value: 46 }], hypothesis: 'E2E:收回后再次提交' })
  ok('T9h', '收回后再提交 → 写面拒绝', invErr(trialW3After) && /写授权|绑定面/.test(invText(trialW3After)), invText(trialW3After).slice(0, 220))
  await api('PATCH', `/api/workshop/channels/${channelId}/execution-mode`, { mode: 'auto', confirm: true }, admin)

  // ── M5 回归:越线绑定拒绝 + 直写工具仍不可用 ──
  const lineB = (await api('POST', '/api/workshop/dcw/lines', { name: `节点授权线B-${TAG}` }, admin)).data?.line?.id
  const nB = (await api('POST', '/api/workshop/dcw', { ...nodeBody(9), lineId: lineB, name: `他线节点-${TAG}` }, admin)).data?.node?.id
  const cross = await bind(w2, nB, 'dcw')
  ok('T10', '频道绑 A 线 → 成员绑定 B 线节点被拒(403 产线隔离)', cross.status === 403, `status=${cross.status} code=${String(cross?.code ?? '')}`)
  const direct = await callAs(w1, tok.w1, 'dcw_control', { node_id: n1, value: 50, hypothesis: 'E2E:直写工具必须仍不可达' })
  ok('T10b', '直写工具 dcw_control 仍不可达(未注册/禁写)', invErr(direct) || /未知工具|不可用|停用|拒绝/.test(invText(direct)), invText(direct).slice(0, 200))
}
catch (err) {
  ok('FATAL', 'E2E 未捕获异常', false, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
}
finally {
  try {
    child.kill()
  }
  catch { /* noop */ }
  const passed = results.filter(r => r.pass).length
  const total = results.length
  const evidenceDir = process.env.AW_E2E_EVIDENCE
    ? dirname(process.env.AW_E2E_EVIDENCE)
    : join(REPO, 'docs', 'audit', 'evidence', '2026-10-28-node-binding-authz')
  mkdirSync(evidenceDir, { recursive: true })
  const evidencePath = process.env.AW_E2E_EVIDENCE
    ? process.env.AW_E2E_EVIDENCE
    : join(evidenceDir, 'report.json')
  writeFileSync(evidencePath, JSON.stringify({
    at: new Date().toISOString(),
    env: { base: BASE, home: join(ROOT, 'home'), devLog: join(ROOT, 'dev.log'), mode: 'isolated' },
    summary: { total, passed, failed: total - passed, verdict: passed === total ? 'PASS' : 'FAIL' },
    results,
  }, null, 2))
  console.log(`\n结论:${passed === total ? 'PASS' : 'FAIL'}(${passed}/${total})`)
  console.log(`证据:${evidencePath}`)
  process.exit(passed === total ? 0 : 1)
}
