// 授权配方:MES 直取两节点入参数面 → 工艺工程师 mes_fetch 可见(仅取数面,不下发本配方)
import { readFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3001'
const prov = JSON.parse(readFileSync('tmp-e2e/anneal-onboarding/provision-result.log', 'utf8').split('\n').find(l => l.startsWith('{')))
let TOKEN = (await (await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }) })).json()).data?.token
const H = { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` }
const api = async (m, u, b) => (await fetch(BASE + u, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) })).json()

// 找工艺工程师(持基线配方绑定的成员)
const bs = await api('GET', '/api/workshop/agent-tools/bindings')
const workerId = (bs?.data?.bindings ?? []).find(b => b.kind === 'recipe' && b.nodeId === prov.recipeId)?.agentId
console.log('worker(工艺工程师):', workerId?.slice(0, 8))

// 授权配方(产品归属沿用基线配方)
const recipes = await api('GET', '/api/workshop/dcw/recipes')
const base = (recipes?.data?.recipes ?? []).find(r => r.id === prov.recipeId)
const prod = { id: base?.productId }
const r = await api('POST', '/api/workshop/dcw/recipes', {
  name: 'MES序列取数授权配方', productId: prod?.id, lineId: prov.lineId, opIntervalMs: 0,
  params: [
    { nodeId: Object.entries(prov.dcw).find(([k]) => k === 'MES温度序列')?.[1], value: 210 },
    { nodeId: Object.entries(prov.dcw).find(([k]) => k === 'MES压力序列')?.[1], value: 8.4 },
  ],
  reason: 'MES 直取节点可见面授权(仅取数面;不下发本配方)',
})
const rc = r?.data?.recipe?.id ?? ''
console.log('grant recipe:', rc || JSON.stringify(r).slice(0, 150))

const b = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: workerId, nodeId: rc, kind: 'recipe', mode: 'manual' })
console.log('bind:', b?.code === 0 || b?.data?.binding ? 'ok ' + (b.data?.binding?.id ?? '').slice(0, 8) : JSON.stringify(b).slice(0, 140))
