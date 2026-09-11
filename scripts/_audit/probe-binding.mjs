/**
 * 定点探针:为什么「绑定成功后 dcw_control 仍报未绑定」?
 * 只构造最小夹具(channel + agent + dcw 节点),逐步打印服务端状态。
 * 只读观测 + 最小必要写入;跑完自行清理。
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3111'
const TAG = Math.random().toString(36).slice(2, 7)

async function api(method, path, { body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  }
  catch { data = text }
  // 统一拆包:{code,message,data:{...}} → payload
  const payload = data && typeof data === 'object' && 'data' in data ? data.data : data
  return { status: res.status, data: payload, raw: data, message: data?.message, code: data?.code, headers: res.headers }
}

const log = (...a) => console.log(...a)

// 1) 账号:优先用显式管理员登录(空实例首位注册也是 admin)
const ADMIN_EMAIL = process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local'
const ADMIN_PASS = process.env.AW_ADMIN_PASS ?? 'admin123'
let token = process.env.AW_PROBE_TOKEN ?? ''
if (!token) {
  const lg = await api('POST', '/api/users/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASS } })
  token = lg.data?.token
  log('login:', lg.status, 'role=', lg.data?.user?.role, 'token?', Boolean(token))
}
if (!token) {
  const reg = await api('POST', '/api/users/register', { body: { name: `probe-${TAG}`, email: `probe-${TAG}@w.local`, password: 'ProbePass!2026' } })
  token = reg.data?.token
  log('fallback register:', reg.status, 'role=', reg.data?.user?.role)
}
if (!token) {
  log('无法取得 token,退出')
  process.exit(1)
}
const me = await api('GET', '/api/workshop/users/me', { token })
log('me:', JSON.stringify(me.data))

// 2) 产线 + 数控模板 + 数控节点
const line = await api('POST', '/api/workshop/dcw/lines', { body: { name: `probe-line-${TAG}` }, token })
log('line:', line.status, JSON.stringify(line.data)?.slice(0, 200))
const lineId = line.data?.line?.id ?? line.data?.id

const tpl = await api('POST', '/api/workshop/dcw/templates', { body: { key: `cw-probe-${TAG}`, name: `probe-${TAG}`, ch: '温度', unit: '℃', min: 0, max: 300, decimals: 1 }, token })
log('dcw template:', tpl.status, JSON.stringify(tpl.data)?.slice(0, 200))
const tplKey = tpl.data?.template?.key
log('  服务端分配 templateKey =', tplKey)

const node = await api('POST', '/api/workshop/dcw', {
  body: { name: `probe-node-${TAG}`, lineId, templateRef: tplKey, driver: 'mock', unit: '℃', min: 0, max: 300, decimals: 1, holdIntervalMs: 0 },
  token,
})
log('dcw node:', node.status, JSON.stringify(node.data)?.slice(0, 260))
const nodeId = node.data?.node?.id ?? node.data?.id
if (!nodeId) {
  log('建节点失败,退出')
  process.exit(1)
}

// 3) channel + agent 模板 + 入队
const ch = await api('POST', '/api/workshop/channels', { body: { name: `probe-ch-${TAG}` }, token })
const channelId = ch.data?.channelId ?? ch.data?.id
log('channel:', ch.status, channelId)

const agentTpl = await api('POST', '/api/workshop/agents', { body: { name: `probe-agent-${TAG}`, harness: 'opencode', config: {} }, token })
const templateId = agentTpl.data?.id
log('agent 模板 id (=templateId):', templateId, 'status:', agentTpl.status)

const join = await api('POST', `/api/workshop/channels/${channelId}/agents`, { body: { agentId: templateId, role: 'worker' }, token })
const instanceId = join.data?.id
log('入队返回 id (=instanceId):', instanceId, 'status:', join.status)
log('  ⚠ templateId !== instanceId ?', templateId !== instanceId)

// 4) 用 instanceId 绑定
const bind = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: instanceId, nodeId, kind: 'dcw', mode: 'auto' }, token })
log('bind(instanceId):', bind.status, JSON.stringify(bind.data)?.slice(0, 300))
const bindingAgentId = bind.data?.binding?.agentId
log('  ⚠ 服务端存下的 agentId =', bindingAgentId)
log('  ⚠ 与 instanceId 相同 ?', bindingAgentId === instanceId, '| 与 templateId 相同 ?', bindingAgentId === templateId)

// 5) 直读绑定表
const listInst = await api('GET', `/api/workshop/agent-tools/bindings?agentId=${instanceId}`, { token })
log('GET bindings?agentId=instanceId:', listInst.status, JSON.stringify(listInst.data)?.slice(0, 300))
const listTpl = await api('GET', `/api/workshop/agent-tools/bindings?agentId=${templateId}`, { token })
log('GET bindings?agentId=templateId:', listTpl.status, JSON.stringify(listTpl.data)?.slice(0, 300))

// 6) 关键:工具调用用哪个 id?
const haveRec = (await api('GET', '/api/workshop/dcw/optimizations', { token })).data
log('optimizations 原始:', JSON.stringify(haveRec)?.slice(0, 300))
for (const [label, id] of [['instanceId', instanceId], ['templateId', templateId]]) {
  const inv = await api('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: id, tool: 'my_industrial_nodes', args: {} }, token,
  })
  log(`invoke my_industrial_nodes @${label}:`, inv.status, String(inv.data?.result?.text ?? JSON.stringify(inv.data)).slice(0, 200))
  const ctl = await api('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: id, tool: 'dcw_control', args: { node_id: nodeId, value: 100, hypothesis: 'probe' } }, token,
  })
  log(`invoke dcw_control @${label}:`, ctl.status, String(ctl.data?.result?.text ?? JSON.stringify(ctl.data)).slice(0, 220))
}

// 7) 清理
await api('DELETE', `/api/workshop/agent-tools/bindings/${bind.data?.binding?.id}`, { token })
await api('DELETE', `/api/workshop/dcw/${nodeId}`, { token })
log('清理完成')
