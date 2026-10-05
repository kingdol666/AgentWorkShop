/* eslint-disable @stylistic/max-statements-per-line */
// IDD × rag-knowledge 集成 CI 冒烟(Plan-D):服务健康 + 插件装载 + 平台 token 配置 + 最小调用
// 用法: node scripts/testing/idd-kb-smoke.mjs [baseUrl=3001]
const B = process.argv[2] ? `http://127.0.0.1:${process.argv[2]}` : 'http://127.0.0.1:3001'
let pass = 0, fail = 0
const ok = (n, c, d = '') => { console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); c ? pass++ : fail++ }
const j = async (u, opt) => {
  const r = await fetch(B + u, opt)
  return { s: r.status, body: await r.json() }
}

// ① 依赖服务健康
const idd = await fetch('http://127.0.0.1:3210/api/health').then(r => r.json()).catch(() => null)
ok('IDD :3210 健康', !!idd?.status || !!idd?.data?.status, JSON.stringify(idd).slice(0, 60))
const kbWeb = await fetch('http://127.0.0.1:6789/').then(r => r.ok).catch(() => false)
ok('rag-knowledge web :6789', kbWeb === true)
const kbApi = await fetch('http://127.0.0.1:8770/health').then(r => r.ok).catch(() => false)
ok('rag-knowledge backend :8770', kbApi === true)

// ② 平台登录 + 插件在装
const login = await j('/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }) })
const tok = login.body?.data?.token
ok('平台登录', !!tok)
const H = { authorization: `Bearer ${tok}` }
const pl = await j('/api/workshop/plugins', { headers: H })
const names = (pl.body?.plugins ?? []).map(p => p.name)
ok('idd-closedloop-bridge 装载', names.includes('idd-closedloop-bridge'))
ok('rag-bridge 装载', names.includes('rag-bridge'))

// ③ token 配置非空(未配置则工具调用必 401)
const st = await j('/api/system/settings', { headers: H })
const eff = JSON.stringify(st.body?.data?.effective ?? {})
ok('idd token 已配置', /plugins\.idd-closedloop-bridge\.token":"idd_/.test(eff))
ok('rag token 已配置', /plugins\.rag-bridge\.token":"sk-/.test(eff))

// ④ 最小调用:经验检索(只读、轻量、需鉴权链全通)
const WORKER = '80dc9b41-6ae3-4dce-a185-21537f0ad7c7'
const inv = async (tool, args) => {
  const r = await fetch(B + '/api/workshop/agent-tools/invoke', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ agentId: WORKER, tool, args }) })
  return (await r.json())?.data?.result?.text ?? ''
}
const rec = await inv('experience_recommend', { anomalous_params: [{ parameter: 'smoke_probe', direction: 'high' }] })
ok('IDD experience_recommend 可达', !rec.includes('401') && !rec.includes('缺少认证'), rec.slice(0, 60))

console.log(`\n=== IDD×KB 集成冒烟: ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail > 0 ? 1 : 0)
