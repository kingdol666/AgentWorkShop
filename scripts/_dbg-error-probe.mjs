/** 线上错误响应探针:固化信封契约(形状/状态码/消息非空),任何破坏信封的改动都会在此失败 */
const BASE = 'http://127.0.0.1:3000'
let failed = 0
const okIf = (m, c) => { if (c) console.log(`PASS ${m}`); else { console.log(`FAIL ${m}`); failed++ } }
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const probe = async (name, url, init, expectStatus, expectCode) => {
  const r = await fetch(`${BASE}${url}`, init)
  const j = await r.json().catch(() => null)
  const envelopeOk = j && 'code' in j && 'message' in j && 'data' in j && j.message
  okIf(`${name} → HTTP ${r.status} (${expectStatus}) 信封完整 code=${j?.code} msg="${String(j?.message ?? '').slice(0, 40)}"`,
    r.status === expectStatus && envelopeOk && (!expectCode || String(j?.code) === expectCode))
}

// ① 无 token → 401 USER_UNAUTHORIZED
await probe('① 无 token PATCH', '/api/workshop/daq/dn-43f55a32', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' }, 401, 'USER_UNAUTHORIZED')
// ② 坏输入 → 400 VALIDATION_ERROR
await probe('② 缺 templateRef', '/api/workshop/daq', { method: 'POST', headers: H, body: '{}' }, 400, 'VALIDATION_ERROR')
// ③ 未匹配路由 → 404 NOT_FOUND(nitro catch-all 信封)
await probe('③ 未匹配路由 404', '/api/workshop/daq/dn-notexist/write', { method: 'POST', headers: H, body: '{}' }, 404, 'NOT_FOUND')
// ④ 越窗下发 → 400 VALIDATION_ERROR 且消息带配方窗口
{
  const r = await fetch(`${BASE}/api/workshop/dcw/dw-322b1978/write`, { method: 'POST', headers: H, body: JSON.stringify({ value: 500 }) })
  const j = await r.json().catch(() => null)
  okIf(`④ 越窗/超量程下发 → HTTP ${r.status}, 消息含量程或窗口语义("${String(j?.message ?? '').slice(0, 46)}...")`, r.status === 400 && /窗口|量程|188|200/.test(j?.message ?? ''))
}
// ⑤ 越权 channel → 404 NOT_FOUND
await probe('⑤ 越权 channel', '/api/workshop/channels/00000000-0000-0000-0000-000000000000/tasks', { headers: H }, 404, 'NOT_FOUND')
// ⑥ Agent 工具:未绑定节点 → 工具级权限拒绝文本
{
  const login2 = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
  const H2 = { authorization: `Bearer ${login2.data.token}`, 'content-type': 'application/json' }
  const ch = await fetch(`${BASE}/api/workshop/channels`, { headers: H2 }).then(r => r.json())
  const channels = Array.isArray(ch.data) ? ch.data : ch.data?.channels ?? []
  let deniedSeen = false
  for (const c of channels.slice(0, 12)) {
    const agents = await fetch(`${BASE}/api/workshop/channels/${c.id}/agents`, { headers: H2 }).then(r => r.json()).catch(() => null)
    const arr = agents?.data ?? []
    const ompWorker = arr.find(a => a.harness === 'omp' && a.role === 'worker')
    if (!ompWorker) continue
    const r = await fetch(`${BASE}/api/workshop/agent-tools/invoke`, { method: 'POST', headers: H2, body: JSON.stringify({ agentId: ompWorker.id, tool: 'dcw_control', args: { node_id: 'dw-notexist', value: 1 } }) }).then(r => r.json()).catch(() => null)
    const text = String(r?.data?.result?.text ?? '')
    if (/无权|不存在/.test(text)) { deniedSeen = true; console.log(`⑥ Agent 工具权限拒绝: ${text.slice(0, 70)}`) }
    break
  }
  okIf('⑥ Agent 工具对未知节点返回可读拒绝(非静默)', deniedSeen)
}

console.log(failed ? `ERROR PROBE FAILED(${failed})` : 'ERROR PROBE ALL PASS')
process.exit(failed ? 1 : 0)
