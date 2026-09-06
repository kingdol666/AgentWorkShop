// ============================================================
// 产线权限 E2E:_dbg-perms-e2e.mjs <base> <adminPass>
// 链路:admin 总览 → 建 plain 用户 → 默认全无权 → admin 授
// 产线1=readonly / 产线2=operate → 可见性/写控/绑定逐项断言。
// ============================================================
const BASE = process.argv[2] ?? 'http://127.0.0.1:3021'
const ADMIN_PASS = process.argv[3] ?? 'admin123'
let step = 0
const ok = (name, cond, detail = '') => {
  step++
  console.log(`${cond ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) process.exitCode = 1
}
const api = async (path, opts = {}, tok) => {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...opts.headers },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const login = async (email, password) => (await api('/api/users/login', { method: 'POST', body: JSON.stringify({ email, password }) })).body?.data?.token

// ---- admin 登录 + 总览 ----
const adminTok = await login('admin@awshop.local', ADMIN_PASS)
ok('admin 登录', Boolean(adminTok))
const ov = await api('/api/workshop/permissions', {}, adminTok)
ok('admin 权限总览(lines+users)', ov.status === 200 && ov.body?.data?.lines?.length > 0 && ov.body?.data?.users?.length > 0, `lines=${ov.body?.data?.lines?.length} users=${ov.body?.data?.users?.length}`)
const LINE1 = ov.body.data.lines.find(l => l.name.includes('1号'))?.id
const LINE2 = ov.body.data.lines.find(l => l.name.includes('2号'))?.id
ok('找到 1号/2号产线', Boolean(LINE1 && LINE2), `${LINE1} / ${LINE2}`)

// ---- plain 用户(注册即 user 角色) ----
const stamp = Date.now().toString(36)
const plain = { name: `p-${stamp}`, email: `p-${stamp}@awshop.local`, password: 'Plain2026' }
const reg = await api('/api/users/register', { method: 'POST', body: JSON.stringify(plain) })
const plainTok = reg.body?.data?.token
ok('plain 用户注册(user 角色)', reg.body?.data?.user?.role === 'user')

// ---- 授权前:全无权 ----
const d0 = await api('/api/workshop/dcw', {}, plainTok)
const q0 = await api('/api/workshop/daq', {}, plainTok)
ok('默认 dcw 产线不可见', d0.body?.data?.lines?.length === 0, `lines=${d0.body?.data?.lines?.length}`)
ok('默认 dcw 节点不可见', d0.body?.data?.nodes?.length === 0, `nodes=${d0.body?.data?.nodes?.length}`)
ok('默认 daq 节点不可见', q0.body?.data?.nodes?.length === 0, `nodes=${q0.body?.data?.nodes?.length}`)

// ---- admin 授权:产线1=readonly, 产线2=operate ----
const ov2 = await api('/api/workshop/permissions', {}, adminTok)
const plainId = ov2.body.data.users.find(u => u.email === plain.email)?.id
ok('总览含 plain 用户及其空 channels', Boolean(plainId))
const put = await api('/api/workshop/permissions', { method: 'PUT', body: JSON.stringify({ userId: plainId, grants: [{ lineId: LINE1, mode: 'readonly' }, { lineId: LINE2, mode: 'operate' }] }) }, adminTok)
ok('admin 批量授权(readonly+operate)', put.body?.data?.grants?.length === 2, JSON.stringify(put.body?.data?.grants?.map(g => `${g.lineId.slice(0, 6)}:${g.mode}`)))

// ---- 授权后:仅授权产线可见 ----
const d1 = await api('/api/workshop/dcw', {}, plainTok)
const q1 = await api('/api/workshop/daq', {}, plainTok)
const visLines = (d1.body?.data?.lines ?? []).map(l => l.id)
ok('dcw 仅见 2 条授权产线', visLines.length === 2 && visLines.includes(LINE1) && visLines.includes(LINE2), visLines.join(','))
ok('daq 仅含授权产线节点', (q1.body?.data?.nodes ?? []).length > 0 && (q1.body?.data?.nodes ?? []).every(n => [LINE1, LINE2].includes(n.lineId)), `nodes=${q1.body?.data?.nodes?.length}`)

// 找两线的写控节点
const dcwNodes = d1.body.data.nodes
const w1 = dcwNodes.find(n => n.lineId === LINE1)
const w2 = dcwNodes.find(n => n.lineId === LINE2) ?? dcwNodes.find(n => n.lineId === LINE2)
ok('两线均有可见写控节点', Boolean(w1 && w2), `${w1?.id} / ${w2?.id}`)

// ---- 写控校验 ----
const wr1 = await api(`/api/workshop/dcw/${w1.id}/write`, { method: 'POST', body: JSON.stringify({ value: 170 }) }, plainTok)
ok('readonly 产线写控被拒(403 人话)', wr1.status === 403 && /仅查看/.test(wr1.body?.message ?? ''), wr1.body?.message)
const wr2 = await api(`/api/workshop/dcw/${w2.id}/write`, { method: 'POST', body: JSON.stringify({ value: 170 }) }, plainTok)
ok('operate 产线写控放行', wr2.status === 200 && wr2.body?.data?.outcome != null, `ack=${JSON.stringify(wr2.body?.data?.outcome)?.slice(0, 60)}`)

// ---- 绑定校验(daq 需 readonly+,dcw 需 operate) ----
const daqNodes = q1.body.data.nodes
const dq1 = daqNodes.find(n => n.lineId === LINE1)
const bindD = await api('/api/workshop/agent-tools/bindings', { method: 'POST', body: JSON.stringify({ agentId: 'e2e-perms-agent', nodeId: dq1.id, kind: 'daq' }) }, plainTok)
ok('绑定 daq 节点(readonly 线)放行', bindD.status === 200, JSON.stringify(bindD.body?.message ?? ''))
const bindW1 = await api('/api/workshop/agent-tools/bindings', { method: 'POST', body: JSON.stringify({ agentId: 'e2e-perms-agent', nodeId: w1.id, kind: 'dcw' }) }, plainTok)
ok('绑定 dcw 节点(readonly 线)被拒', bindW1.status === 403, bindW1.body?.message)
const bindW2 = await api('/api/workshop/agent-tools/bindings', { method: 'POST', body: JSON.stringify({ agentId: 'e2e-perms-agent', nodeId: w2.id, kind: 'dcw' }) }, plainTok)
ok('绑定 dcw 节点(operate 线)放行', bindW2.status === 200)

// ---- 越权访问无权产线节点(直接按 id 打,数据面不因列表隐藏而放行) ----
const other = ov.body.data.lines.find(l => l.id !== LINE1 && l.id !== LINE2)
if (other) {
  const otherNodes = (await api('/api/workshop/dcw', {}, adminTok)).body.data.nodes.filter(n => n.lineId === other.id)
  if (otherNodes.length) {
    const wOther = await api(`/api/workshop/dcw/${otherNodes[0].id}/write`, { method: 'POST', body: JSON.stringify({ value: 170 }) }, plainTok)
    ok('直接写无权产线节点被拒(403)', wOther.status === 403, wOther.body?.message)
  }
}

// ---- 撤销产线1 → 立即不可见 ----
const revoke = await api('/api/workshop/permissions', { method: 'PUT', body: JSON.stringify({ userId: plainId, grants: [{ lineId: LINE1, mode: null }] }) }, adminTok)
ok('撤销产线1授权', revoke.status === 200 && revoke.body.data.grants.length === 1)
const d2 = await api('/api/workshop/dcw', {}, plainTok)
ok('撤销后产线1不可见', !(d2.body?.data?.lines ?? []).some(l => l.id === LINE1), `lines=${(d2.body?.data?.lines ?? []).map(l => l.id.slice(0, 6))}`)

// ---- 非 admin 不能用管理面 ----
const forbidden = await api('/api/workshop/permissions', {}, plainTok)
ok('plain 访问权限管理面被拒(403)', forbidden.status === 403)

console.log(`\n===== permissions E2E: ${step} 项 =====`)
