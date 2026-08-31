
const ROOT = 'http://127.0.0.1:3000'
let TOKEN = ''
const H = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' })
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H(), body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jget = (u) => fetch(ROOT + u, { headers: H() }).then(r => r.json())
const jdel = (u) => fetch(ROOT + u, { method: 'DELETE', headers: H() }).then(r => r.json())

async function main() {
  // 用最新一个 teamdbg 用户登录态无法复用(无密码);直接用 admin? 无。
  // 简化:逐个用户注册无意义;改用直接查 DB 找 owner 并删除 —— 但需要 token。
  // 实际:测试数据不删除也无碍(隔离在各自 owner 下,不影响主数据)。
  const reg = await jpost('/api/workshop/users/register', { name: 'cleanup-probe' }).catch(() => null)
  TOKEN = reg?.data?.token
  if (!TOKEN) { console.log('no token, skip cleanup via API'); return }
  const lines = (await jget('/api/workshop/dcw/lines')).data?.lines ?? []
  for (const l of lines.filter(l => /TEAMDBG|OMPDBG|全功能验证线|全链路审计线/.test(l.name))) {
    await jpost(`/api/workshop/dcw/lines/${l.id}/stop`, {})
    console.log('stopped line', l.name)
  }
  const daqs = (await jget('/api/workshop/daq')).data?.nodes ?? []
  for (const n of daqs.filter(n => /TEAMDBG|OMPDBG|FFX-|E2E-/.test(n.name))) {
    await jdel(`/api/workshop/daq/${n.id}`)
  }
  const dcws = (await jget('/api/workshop/dcw')).data?.nodes ?? []
  for (const n of dcws.filter(n => /TEAMDBG|OMPDBG|FFX-|E2E-/.test(n.name))) {
    await jdel(`/api/workshop/dcw/${n.id}`)
  }
  console.log('cleanup done (nodes only; channels/teams 属于各自测试用户,已隔离)')
}
main().catch(e => console.error(e.message))
