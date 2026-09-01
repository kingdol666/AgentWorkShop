const login = await fetch('http://127.0.0.1:3000/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}` }
const nodes = (await fetch('http://127.0.0.1:3000/api/workshop/daq', { headers: H }).then(r => r.json())).data.nodes.filter(n => /采集-/.test(n.name))
for (const n of nodes.slice(0, 8)) console.log(n.name.slice(0, 22), '| driver:', n.driver, '| state:', n.state, '| value:', n.value, '| enabled:', n.enabled, '| line:', (n.lineId ?? '').slice(0, 8))
process.exit(0)
