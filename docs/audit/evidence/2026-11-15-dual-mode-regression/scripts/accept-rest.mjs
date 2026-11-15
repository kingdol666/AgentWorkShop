/**
 * Dual-mode (generic vs production_line_integrated) live REST acceptance.
 * Runs against an isolated home-mode instance:
 *   AW_MODE=home AW_HOME=<fresh> PORT=3033 AW_DAQ_STARTINFRASTRUCTURE=never
 * Simulated lines only; no physical line, no HIL, no line start/stop, no DCW write,
 * no recipe apply. Read/tool-surface/memory/mailbox/task/session-snapshot surfaces only.
 */
const BASE = process.env.ACCEPT_BASE ?? 'http://127.0.0.1:3033'
const results = []
let seq = 0

function check(name, ok, detail) {
  seq += 1
  results.push({ no: seq, name, ok: !!ok, detail: detail === undefined ? null : detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} #${seq} ${name}${ok ? '' : ' :: ' + JSON.stringify(detail)?.slice(0, 500)}`)
  return ok
}

async function api(method, path, { token, body, expectStatus } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* empty body */ }
  return { status: res.status, json }
}

async function ok(method, path, opts = {}) {
  const { status, json } = await api(method, path, opts)
  if (status < 200 || status >= 300 || !json || json.code !== 0) {
    throw new Error(`${method} ${path} -> ${status} ${JSON.stringify(json).slice(0, 300)}`)
  }
  return json.data
}

async function expectFail(method, path, token, body, name, allowedCodes) {
  const { status, json } = await api(method, path, { token, body })
  const code = json?.code ?? json?.data?.code ?? status
  const okFail = status >= 400 || (json && json.code !== 0)
  check(name, okFail, { status, code, message: json?.message })
  return { status, code, json }
}

const INDUSTRIAL_TOOLS = ['daq_query', 'line_context', 'mes_fetch', 'exp_collect', 'recipe_catalog', 'ops_log', 'recipe_versions']
// aml_node_catalog 属 AML 训练族:legacy 档位设计性摘除,须 AML 训练 profile 才注入(generic 负例保留)
const INDUSTRIAL_GENERIC_DENIED = [...INDUSTRIAL_TOOLS, 'aml_node_catalog']
const GENERIC_CORE_TOOLS = ['save_memory', 'search_memory', 'send_message_to_agent', 'poll_messages', 'read_channel_mail', 'submit_task', 'get_my_task_queue']
const WORKER_CORE_TOOLS = ['save_memory', 'search_memory', 'send_message_to_agent', 'poll_messages', 'get_my_task_queue']

async function main() {
  const stamp = Date.now().toString(36).slice(-6)

  // ---- 0. auth bootstrap -------------------------------------------------
  const admin = await ok('POST', '/api/workshop/users/register', { body: { name: `acc-admin-${stamp}` } })
  check('register admin returns token', !!admin.token && !!admin.id, { id: admin.id })
  const me = await ok('GET', '/api/workshop/users/me', { token: admin.token })
  check('first user is bootstrap admin', me.user?.role === 'admin' || me.role === 'admin', me)
  // 注册闸门:首 admin 就位后自助注册关闭 → 第二用户走 admin 建号 + 登录
  const memberCreated = await ok('POST', '/api/users', {
    token: admin.token,
    body: { name: `acc-member-${stamp}`, email: `acc-member-${stamp}@accept.local`, password: 'Accept#2026-member', role: 'user' },
  })
  const memberLogin = await ok('POST', '/api/users/login', { body: { email: `acc-member-${stamp}@accept.local`, password: 'Accept#2026-member' } })
  const member = { id: memberCreated.id ?? memberCreated.user?.id, token: memberLogin.token }
  check('second non-owner user created & logged in', !!member.token, { id: member.id })

  // ---- 1. simulated lines & products (same-line pair + foreign line) -----
  const l1 = await ok('POST', '/api/workshop/dcw/lines', { token: admin.token, body: { name: `SIM-L1-${stamp}`, simulated: true } })
  const l2 = await ok('POST', '/api/workshop/dcw/lines', { token: admin.token, body: { name: `SIM-L2-${stamp}`, simulated: true } })
  const line1 = l1.line ?? l1
  const line2 = l2.line ?? l2
  check('line L1 created simulated', !!line1.id && line1.simulated === true, line1)
  const pA = (await ok('POST', '/api/workshop/dcw/products', { token: admin.token, body: { name: `PA-${stamp}`, lineId: line1.id } })).product
  const pB = (await ok('POST', '/api/workshop/dcw/products', { token: admin.token, body: { name: `PB-${stamp}`, lineId: line1.id } })).product
  const pC = (await ok('POST', '/api/workshop/dcw/products', { token: admin.token, body: { name: `PC-${stamp}`, lineId: line2.id } })).product
  check('products PA/PB on L1, PC on L2', !!pA?.id && !!pB?.id && !!pC?.id && pA.lineId === line1.id && pC.lineId === line2.id, { pA: pA?.id, pB: pB?.id, pC: pC?.id })

  // ---- 2. channels --------------------------------------------------------
  const cgRes = await ok('POST', '/api/workshop/channels', {
    token: admin.token,
    body: { name: `CG-generic-${stamp}`, channelMode: 'generic', description: 'generic regression', leadAgent: { name: 'Lead·通用', harness: 'mock', config: {} } },
  })
  const cgId = cgRes.channel?.id ?? cgRes.channelId ?? cgRes.id
  check('generic channel created with mode generic', !!cgId, cgRes)
  const cgView = await ok('GET', `/api/workshop/channels/${cgId}`, { token: admin.token })
  const cgRow = cgView.channel ?? cgView
  check('generic channel GET exposes channelMode=generic', cgRow.channelMode === 'generic', { channelMode: cgRow.channelMode })

  const ciRes = await ok('POST', '/api/workshop/channels', {
    token: admin.token,
    body: { name: `CI-line-${stamp}`, channelMode: 'production_line_integrated', lineId: line1.id, description: 'integrated regression', leadAgent: { name: 'Lead·产线', harness: 'mock', config: {} } },
  })
  const ciId = ciRes.channel?.id ?? ciRes.channelId ?? ciRes.id
  check('integrated channel created', !!ciId, ciRes)
  const ciView = await ok('GET', `/api/workshop/channels/${ciId}`, { token: admin.token })
  const ciRow = ciView.channel ?? ciView
  check('integrated channel GET exposes mode + line', ciRow.channelMode === 'production_line_integrated' && ciRow.lineId === line1.id, { channelMode: ciRow.channelMode, lineId: ciRow.lineId })

  // 两种模式都放一个基础 worker：验证 worker 核心工具面与 mailbox/task 协作面
  const cgWorkerRes = await ok('POST', `/api/workshop/channels/${cgId}/agents`, { token: admin.token, body: { name: 'Worker·通用', role: 'worker', harness: 'mock', config: {} } })
  const ciWorkerRes = await ok('POST', `/api/workshop/channels/${ciId}/agents`, { token: admin.token, body: { name: 'Worker·产线', role: 'worker', harness: 'mock', config: {} } })
  const cgWorkerIdBase = cgWorkerRes.id ?? cgWorkerRes.agentId
  const ciWorkerIdBase = ciWorkerRes.id ?? ciWorkerRes.agentId
  check('both modes accept a base worker member', Boolean(cgWorkerIdBase && ciWorkerIdBase), { cgWorkerIdBase, ciWorkerIdBase })

  // ---- 3. product binding lifecycle --------------------------------------
  const bind0 = await ok('GET', `/api/workshop/channels/${ciId}/products`, { token: admin.token })
  const rev0 = bind0.revision
  check('initial product binding empty with revision', Array.isArray(bind0.productIds) && bind0.productIds.length === 0 && Number.isInteger(rev0), bind0)
  const bind1 = await ok('PUT', `/api/workshop/channels/${ciId}/products`, { token: admin.token, body: { productIds: [pA.id, pB.id], expectedRevision: rev0 } })
  const rev1 = bind1.revision
  check('PUT binding accepts same-line pair, bumps revision', rev1 === rev0 + 1, { rev0, rev1 })
  const bind1v = await ok('GET', `/api/workshop/channels/${ciId}/products`, { token: admin.token })
  check('GET binding returns sorted bound products', JSON.stringify([...bind1v.productIds].sort()) === JSON.stringify([pA.id, pB.id].sort()), bind1v)
  await expectFail('PUT', `/api/workshop/channels/${ciId}/products`, admin.token, { productIds: [pA.id], expectedRevision: rev0 }, 'stale revision rejected (409 CHANNEL_PRODUCT_BINDING_STALE)', [])
  await expectFail('PUT', `/api/workshop/channels/${ciId}/products`, admin.token, { productIds: [pA.id, pC.id], expectedRevision: rev1 }, 'mixed-line product set rejected', [])
  await expectFail('PUT', `/api/workshop/channels/${ciId}/products`, member.token, { productIds: [pA.id], expectedRevision: rev1 }, 'non-owner cannot edit bindings', [])

  // ---- 4. sessions ---------------------------------------------------------
  const sg = await ok('POST', `/api/workshop/channels/${cgId}/sessions`, { token: admin.token, body: { title: 'SG-通用会话' } })
  check('generic session created', !!sg.sessionId && sg.channelMode === 'generic', sg)
  const sgList = await ok('GET', `/api/workshop/channels/${cgId}/sessions`, { token: admin.token })
  const sgRow = (sgList.sessions ?? sgList).find?.(s => s.id === sg.sessionId) ?? (sgList.sessions ?? sgList)[0]
  check('session list shows generic mode, no product', sgRow?.channelMode === 'generic' && !sgRow?.productId, sgRow)
  const sg2 = await ok('POST', `/api/workshop/channels/${cgId}/sessions`, { token: admin.token, body: { productId: pA.id } })
  const sg2Detail = await ok('GET', `/api/workshop/channels/${cgId}/sessions/${sg2.sessionId}`, { token: admin.token })
  const sg2Row = sg2Detail.session ?? sg2Detail
  check('generic session ignores caller productId (stays generic/null)', sg2Row.channelMode === 'generic' && !sg2Row.productId, { channelMode: sg2Row.channelMode, productId: sg2Row.productId })

  await expectFail('POST', `/api/workshop/channels/${ciId}/sessions`, admin.token, {}, 'integrated session without product rejected (SESSION_PRODUCT_REQUIRED)', [])
  await expectFail('POST', `/api/workshop/channels/${ciId}/sessions`, admin.token, { productId: pC.id }, 'unbound product rejected (SESSION_PRODUCT_NOT_BOUND)', [])
  await expectFail('POST', `/api/workshop/channels/${ciId}/sessions`, admin.token, { productId: 'no-such-product' }, 'unknown product rejected', [])
  const siA = await ok('POST', `/api/workshop/channels/${ciId}/sessions`, { token: admin.token, body: { productId: pA.id, title: 'SI-产品A' } })
  check('integrated session PA created with frozen snapshot', !!siA.sessionId && siA.productId === pA.id && siA.lineId === line1.id && !!siA.bindingSnapshotHash && siA.bindingSnapshotRevision === rev1, siA)
  const siB = await ok('POST', `/api/workshop/channels/${ciId}/sessions`, { token: admin.token, body: { productId: pB.id } })
  check('integrated session PB created on same line', !!siB.sessionId && siB.productId === pB.id && siB.lineId === line1.id, { sessionId: siB.sessionId, productId: siB.productId })
  const siADetail = await ok('GET', `/api/workshop/channels/${ciId}/sessions/${siA.sessionId}`, { token: admin.token })
  const siARow = siADetail.session ?? siADetail
  check('session detail exposes mode/product/line/snapshot projection', siARow.channelMode === 'production_line_integrated' && siARow.productId === pA.id && siARow.lineId === line1.id && !!siARow.bindingSnapshotHash && siARow.bindingSnapshotRevision === rev1, siARow)

  // ---- 5. snapshot immutability across binding change ---------------------
  const bind2 = await ok('PUT', `/api/workshop/channels/${ciId}/products`, { token: admin.token, body: { productIds: [pA.id], expectedRevision: rev1 } })
  const rev2 = bind2.revision
  check('binding rebind drops PB, revision bumps', rev2 === rev1 + 1, { rev1, rev2 })
  const siAAfter = await ok('GET', `/api/workshop/channels/${ciId}/sessions/${siA.sessionId}`, { token: admin.token })
  const siAAfterRow = siAAfter.session ?? siAAfter
  check('PA session snapshot unchanged after rebind', siAAfterRow.productId === pA.id && siAAfterRow.bindingSnapshotHash === siARow.bindingSnapshotHash && siAAfterRow.bindingSnapshotRevision === rev1, { before: siARow.bindingSnapshotHash, after: siAAfterRow.bindingSnapshotHash })
  const siBAfter = await ok('GET', `/api/workshop/channels/${ciId}/sessions/${siB.sessionId}`, { token: admin.token })
  const siBAfterRow = siBAfter.session ?? siBAfter
  check('PB session keeps frozen product/line/revision after PB unbound', siBAfterRow.productId === pB.id && siBAfterRow.lineId === line1.id && siBAfterRow.bindingSnapshotRevision === rev1, { productId: siBAfterRow.productId, revision: siBAfterRow.bindingSnapshotRevision })
  await ok('PUT', `/api/workshop/channels/${ciId}/products`, { token: admin.token, body: { productIds: [pA.id, pB.id], expectedRevision: rev2 } })

  // ---- 6. tool surface gating (same-source as omp injection) --------------
  const cgAgents = await ok('GET', `/api/workshop/channels/${cgId}/agents`, { token: admin.token })
  const ciAgents = await ok('GET', `/api/workshop/channels/${ciId}/agents`, { token: admin.token })
  const cgLead = (cgAgents.agents ?? cgAgents).find(a => a.role === 'lead')
  const ciLead = (ciAgents.agents ?? ciAgents).find(a => a.role === 'lead')
  check('both channels expose lead member', !!cgLead?.id && !!ciLead?.id, { cgLead: cgLead?.id, ciLead: ciLead?.id })
  const cgTools = (await ok('GET', `/api/workshop/agent-tools/list?agentId=${cgLead.id}`, { token: admin.token })).tools ?? []
  const ciTools = (await ok('GET', `/api/workshop/agent-tools/list?agentId=${ciLead.id}`, { token: admin.token })).tools ?? []
  const cgNames = new Set(cgTools.map(t => t.name))
  const ciNames = new Set(ciTools.map(t => t.name))
  const cgLeak = INDUSTRIAL_GENERIC_DENIED.filter(n => cgNames.has(n))
  check('generic lead surface has NO industrial tools', cgLeak.length === 0, { leaked: cgLeak })
  const cgMissingCore = GENERIC_CORE_TOOLS.filter(n => !cgNames.has(n))
  check('generic lead keeps framework core tools (memory/mailbox/task)', cgMissingCore.length === 0, { missing: cgMissingCore })
  const ciMissingInd = INDUSTRIAL_TOOLS.filter(n => !ciNames.has(n))
  check('integrated lead surface injects industrial tools', ciMissingInd.length === 0, { missing: ciMissingInd })
  const ciMissingCore = GENERIC_CORE_TOOLS.filter(n => !ciNames.has(n))
  check('integrated lead keeps framework core tools too', ciMissingCore.length === 0, { missing: ciMissingCore })

  // worker 面:两种模式都必须保留协作/记忆/自身任务队列;工业工具按模式门控
  const cgWorker = (cgAgents.agents ?? cgAgents).find(a => a.role === 'worker' && !String(a.name ?? '').includes('·session·'))
  const ciWorker = (ciAgents.agents ?? ciAgents).find(a => a.role === 'worker' && !String(a.name ?? '').includes('·session·'))
  check('both channels expose worker member', !!cgWorker?.id && !!ciWorker?.id, { cgWorker: cgWorker?.id, ciWorker: ciWorker?.id })
  if (cgWorker && ciWorker) {
    const cgw = new Set(((await ok('GET', `/api/workshop/agent-tools/list?agentId=${cgWorker.id}`, { token: admin.token })).tools ?? []).map(x => x.name))
    const ciw = new Set(((await ok('GET', `/api/workshop/agent-tools/list?agentId=${ciWorker.id}`, { token: admin.token })).tools ?? []).map(x => x.name))
    check('generic worker: worker core kept, no industrial', WORKER_CORE_TOOLS.every(n => cgw.has(n)) && INDUSTRIAL_GENERIC_DENIED.every(n => !cgw.has(n)) && !cgw.has('submit_task'), { missing: WORKER_CORE_TOOLS.filter(n => !cgw.has(n)), leaked: INDUSTRIAL_GENERIC_DENIED.filter(n => cgw.has(n)) })
    check('integrated worker: worker core + industrial tools', WORKER_CORE_TOOLS.every(n => ciw.has(n)) && INDUSTRIAL_TOOLS.every(n => ciw.has(n)), { missingCore: WORKER_CORE_TOOLS.filter(n => !ciw.has(n)), missingInd: INDUSTRIAL_TOOLS.filter(n => !ciw.has(n)) })
  }

  // ---- 6b. direct execution gate (not just injection surface) -------------
  const invokeTool = async (agentId, tool, args = {}) => {
    const r = await api('POST', '/api/workshop/agent-tools/invoke', { token: admin.token, body: { agentId, tool, args } })
    const text = JSON.stringify(r.json ?? '')
    return { status: r.status, json: r.json, text, rejected: r.status >= 400 || /"isError":true/.test(text) }
  }
  const gLineDirect = await invokeTool(cgLead.id, 'line_context', { line_id: line1.id })
  check('generic lead direct line_context rejected by execution gate', gLineDirect.rejected && gLineDirect.text.includes('通用频道'), gLineDirect)
  const gDaqDirect = await invokeTool(cgLead.id, 'daq_query', { node_id: 'none', last_minutes: 5 })
  check('generic lead direct daq_query rejected by execution gate', gDaqDirect.rejected && gDaqDirect.text.includes('通用频道'), gDaqDirect)
  const gMemDirect = await invokeTool(cgLead.id, 'save_memory', { title: `DIRECT-G-${stamp}`, content: `DIRECT-G-${stamp}`, scope: 'shared' })
  check('generic lead direct save_memory executes (memory tool is mode-independent)', !gMemDirect.rejected, gMemDirect)
  const gQueueDirect = await invokeTool(cgLead.id, 'get_my_task_queue', {})
  check('generic lead direct get_my_task_queue executes', !gQueueDirect.rejected, gQueueDirect)
  const iLineDirect = await invokeTool(ciLead.id, 'line_context', { line_id: line1.id })
  check('integrated lead direct line_context executes', !iLineDirect.rejected && iLineDirect.text.includes(line1.name ?? line1.id), iLineDirect)
  const iMemDirect = await invokeTool(ciLead.id, 'save_memory', { title: `DIRECT-I-${stamp}`, content: `DIRECT-I-${stamp}`, scope: 'shared' })
  check('integrated lead direct save_memory executes', !iMemDirect.rejected, iMemDirect)
  const iQueueDirect = await invokeTool(ciLead.id, 'get_my_task_queue', {})
  check('integrated lead direct get_my_task_queue executes', !iQueueDirect.rejected, iQueueDirect)
  if (cgWorker && ciWorker) {
    const gPoll = await invokeTool(cgWorker.id, 'poll_messages', { limit: 1, wait_seconds: 0 })
    const iPoll = await invokeTool(ciWorker.id, 'poll_messages', { limit: 1, wait_seconds: 0 })
    check('generic worker mailbox poll executes', !gPoll.rejected, gPoll)
    check('integrated worker mailbox poll executes', !iPoll.rejected, iPoll)
    const gSend = await invokeTool(cgLead.id, 'send_message_to_agent', { to_agent_id: cgWorker.id, message: `TOOL-MBX-G-${stamp}`, require_reply: false })
    const iSend = await invokeTool(ciLead.id, 'send_message_to_agent', { to_agent_id: ciWorker.id, message: `TOOL-MBX-I-${stamp}`, require_reply: false })
    check('generic lead mailbox send tool executes', !gSend.rejected, gSend)
    check('integrated lead mailbox send tool executes', !iSend.rejected, iSend)
  }

  // Session 克隆成员(真实会话执行单元)的工具面:generic 会话无工业工具,集成会话保留
  const cgClone = (cgAgents.agents ?? cgAgents).find(a => String(a.name ?? '').includes('·session·'))
  const ciClones = (ciAgents.agents ?? ciAgents).filter(a => String(a.name ?? '').includes('·session·'))
  check('session clones exist on both channels', !!cgClone && ciClones.length >= 2, { cgClone: cgClone?.name, ciClones: ciClones.length })
  if (cgClone) {
    const t = new Set(((await ok('GET', `/api/workshop/agent-tools/list?agentId=${cgClone.id}`, { token: admin.token })).tools ?? []).map(x => x.name))
    const leak = INDUSTRIAL_GENERIC_DENIED.filter(n => t.has(n))
    // 克隆是 worker 定位:submit_task 属 lead-only(设计);worker 核心面=记忆/协作/自身任务队列
    const missingCore = WORKER_CORE_TOOLS.filter(n => !t.has(n))
    check('generic session clone: no industrial tools, worker core kept', leak.length === 0 && missingCore.length === 0 && !t.has('submit_task'), { leak, missingCore })
  }
  if (ciClones.length) {
    const t = new Set(((await ok('GET', `/api/workshop/agent-tools/list?agentId=${ciClones[0].id}`, { token: admin.token })).tools ?? []).map(x => x.name))
    const missingInd = INDUSTRIAL_TOOLS.filter(n => !t.has(n))
    const missingCore = WORKER_CORE_TOOLS.filter(n => !t.has(n))
    check('integrated session clone: industrial + worker core tools present', missingInd.length === 0 && missingCore.length === 0, { missingInd, missingCore })
  }

  // ---- 7. memory parity ----------------------------------------------------
  const cgMem = await ok('POST', `/api/workshop/channels/${cgId}/agents/${cgLead.id}/memories`, { token: admin.token, body: { title: '通用记忆', content: `通用频道记忆锚点 GEXACT-${stamp} 越用越聪明`, scope: 'shared', importance: 0.8 } })
  check('generic agent memory write ok', cgMem.ok === true, cgMem)
  const cgSearch = await ok('POST', `/api/workshop/channels/${cgId}/agents/${cgLead.id}/memories/search`, { token: admin.token, body: { query: `GEXACT-${stamp}` } })
  const cgHit = JSON.stringify(cgSearch).includes(`GEXACT-${stamp}`)
  check('generic memory search recalls written anchor', cgHit, { top: JSON.stringify(cgSearch).slice(0, 200) })
  const ciMem = await ok('POST', `/api/workshop/channels/${ciId}/agents/${ciLead.id}/memories`, { token: admin.token, body: { title: '产线记忆', content: `产线集成记忆锚点 IEXACT-${stamp} 产品A工艺`, scope: 'shared', importance: 0.8 } })
  check('integrated agent memory write ok', ciMem.ok === true, ciMem)
  const ciSearch = await ok('POST', `/api/workshop/channels/${ciId}/agents/${ciLead.id}/memories/search`, { token: admin.token, body: { query: `IEXACT-${stamp}` } })
  check('integrated memory search recalls written anchor', JSON.stringify(ciSearch).includes(`IEXACT-${stamp}`), null)
  const cgTeam = await ok('POST', `/api/workshop/channels/${cgId}/memories`, { token: admin.token, body: { title: `TEAM-G-${stamp}`, content: '通用频道团队共享记忆', dedupKey: `tg-${stamp}` } })
  check('generic team memory (lead curation) ok', !!cgTeam, cgTeam)
  const ciTeam = await ok('POST', `/api/workshop/channels/${ciId}/memories`, { token: admin.token, body: { title: `TEAM-I-${stamp}`, content: '产线频道团队共享记忆', dedupKey: `ti-${stamp}` } })
  check('integrated team memory ok', !!ciTeam, ciTeam)
  const cgCross = await ok('POST', `/api/workshop/channels/${cgId}/agents/${cgLead.id}/memories/search`, { token: admin.token, body: { query: `IEXACT-${stamp}` } })
  check('generic channel cannot recall integrated channel anchor', !JSON.stringify(cgCross).includes(`IEXACT-${stamp}`), null)
  const expStatsG = await ok('GET', `/api/workshop/channels/${cgId}/memories/experience-stats`, { token: admin.token })
  const expStatsI = await ok('GET', `/api/workshop/channels/${ciId}/memories/experience-stats`, { token: admin.token })
  check('RSI experience observation surface available on both modes', !!expStatsG && !!expStatsI, { g: Object.keys(expStatsG ?? {}).slice(0, 5), i: Object.keys(expStatsI ?? {}).slice(0, 5) })

  // ---- 8. mailbox parity ---------------------------------------------------
  const cgMsg = await ok('POST', `/api/workshop/channels/${cgId}/messages`, { token: admin.token, body: { toAgentId: cgLead.id, text: `MBX-G-${stamp} 通用频道邮箱链路验收`, priority: 'task' } })
  check('generic mailbox send accepted', !!cgMsg, cgMsg)
  const ciMsg = await ok('POST', `/api/workshop/channels/${ciId}/messages`, { token: admin.token, body: { toAgentId: ciLead.id, text: `MBX-I-${stamp} 产线频道邮箱链路验收`, priority: 'task' } })
  check('integrated mailbox send accepted', !!ciMsg, ciMsg)
  const cgMsgs = await ok('GET', `/api/workshop/channels/${cgId}/messages`, { token: admin.token })
  check('generic mailbox message retrievable', JSON.stringify(cgMsgs).includes(`MBX-G-${stamp}`), null)
  const ciMsgs = await ok('GET', `/api/workshop/channels/${ciId}/messages`, { token: admin.token })
  check('integrated mailbox message retrievable', JSON.stringify(ciMsgs).includes(`MBX-I-${stamp}`), null)
  check('generic mailbox tool send visible in channel mail log', JSON.stringify(cgMsgs).includes(`TOOL-MBX-G-${stamp}`), null)
  check('integrated mailbox tool send visible in channel mail log', JSON.stringify(ciMsgs).includes(`TOOL-MBX-I-${stamp}`), null)

  // ---- 9. task system parity ------------------------------------------------
  const cgTask = await ok('POST', `/api/workshop/channels/${cgId}/tasks`, { token: admin.token, body: { title: `TASK-G-${stamp}`, description: '通用频道任务链路验收', parts: [{ text: '请确认任务链路' }] } })
  check('generic channel task submitted & routed', !!cgTask, cgTask)
  const ciTask = await ok('POST', `/api/workshop/channels/${ciId}/tasks`, { token: admin.token, body: { title: `TASK-I-${stamp}`, description: '产线频道任务链路验收', parts: [{ text: '请确认任务链路' }] } })
  check('integrated channel task submitted & routed', !!ciTask, ciTask)
  const cgTasks = await ok('GET', `/api/workshop/channels/${cgId}/tasks`, { token: admin.token })
  const ciTasks = await ok('GET', `/api/workshop/channels/${ciId}/tasks`, { token: admin.token })
  check('generic task list contains submitted task', JSON.stringify(cgTasks).includes(`TASK-G-${stamp}`), null)
  check('integrated task list contains submitted task', JSON.stringify(ciTasks).includes(`TASK-I-${stamp}`), null)

  // ---- summary ---------------------------------------------------------------
  const fails = results.filter(r => !r.ok)
  const out = { base: BASE, stamp, total: results.length, pass: results.length - fails.length, fail: fails.length, results }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(out, null, 2))
  console.log(`\n==== SUMMARY: ${out.pass}/${out.total} PASS, ${out.fail} FAIL ====`)
  if (fails.length) {
    console.log('FAILED CHECKS:')
    for (const f of fails) console.log(`  #${f.no} ${f.name}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('ACCEPTANCE ABORTED:', err)
  process.exitCode = 2
})
