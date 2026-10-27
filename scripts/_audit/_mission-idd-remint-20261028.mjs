// 一次性:IDD 重启后重铸 token(mission 账号不存在则注册),分发到 mission 设置与套件文件
import fs from 'node:fs'

process.env.NO_PROXY = '127.0.0.1,localhost'
const IDD = 'http://127.0.0.1:3210'
const post = async (p, body, tok) => {
  const r = await fetch(IDD + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}
let login = await post('/api/auth/login', { username: 'mission-acc-20261028', password: 'MissionAcc#2026' })
if (!login.success) {
  console.log('login fail → register:', login.error ?? '')
  await post('/api/auth/register', { username: 'mission-acc-20261028', password: 'MissionAcc#2026', email: 'mission-acc-20261028@awshop.local' })
  login = await post('/api/auth/login', { username: 'mission-acc-20261028', password: 'MissionAcc#2026' })
}
if (!login.success) { console.error('login failed', JSON.stringify(login).slice(0, 150)); process.exit(1) }
const st = login.data.session_token
const mint = await post('/api/auth/tokens', { name: `mission-accept-${Date.now().toString(36)}`, expires_days: 7 }, st)
const tok = mint?.data?.token
if (!tok) { console.error('mint failed', JSON.stringify(mint).slice(0, 150)); process.exit(1) }
fs.writeFileSync('.e2e-tmp/live-mission-3470/idd-token.txt', `${tok}\n`)
fs.copyFileSync('.e2e-tmp/live-mission-3470/idd-token.txt', 'D:/tmp/idd-token.txt')
const me = await fetch(`${IDD}/api/auth/me`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json())
console.log('token ok, me=', me?.data?.username ?? JSON.stringify(me).slice(0, 80))
// 热更平台设置
const plat = await fetch('http://127.0.0.1:3470/api/users/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@mission.local', password: 'Mission#2026Acc' }) }).then(r => r.json())
await fetch('http://127.0.0.1:3470/api/system/settings', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${plat.data.token}` },
  body: JSON.stringify({ 'plugins.diag-bridge.token': tok }),
})
console.log('platform settings patched + suite file written')
