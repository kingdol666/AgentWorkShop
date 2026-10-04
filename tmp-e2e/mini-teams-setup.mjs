// 线3(MQTT 测厚)/ 线4(HTTP CCD)各建绑线小队(lead+worker),走 v3 线域授权
const B = 'http://localhost:3001'
const TOK = (await (await fetch(`${B}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }),
})).json()).data?.token
const H = { 'authorization': `Bearer ${TOK}`, 'content-type': 'application/json' }
const api = async (m, u, b) => {
  const r = await fetch(B + u, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) })
  return r.json()
}
const WORKER_TPL = '00f3c815-e623-4aa4-9ec6-b5ac01fd1b3f'

async function miniTeam(name, lineId, daqNodeIds) {
  const ch = await api('POST', '/api/workshop/channels', {
    name, lineId, leadAgent: { name: `${name}-lead`, harness: 'omp' },
  })
  const channelId = ch.data?.channelId
  const leadId = ch.data?.leadAgentId
  if (!channelId) {
    console.error(name, '建频道失败', ch.code, ch.message)
    return null
  }
  const w = await api('POST', `/api/workshop/channels/${channelId}/agents`, { agentId: WORKER_TPL, name: `${name}-worker` })
  const workerId = w.data?.id ?? w.data?.agentId
  for (const nodeId of daqNodeIds) {
    const g = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadId, nodeId, kind: 'daq', mode: 'auto' })
    if (g.code !== 0) console.error(`lead bind ${nodeId}`, g.code, g.message)
  }
  const grant = await api('POST', '/api/workshop/agent-tools/bindings/grant', { channelId, agentId: workerId, nodeIds: daqNodeIds, mode: 'auto' })
  console.log(`${name}: ch=${channelId.slice(0, 8)} lead=${leadId.slice(0, 8)} worker=${workerId?.slice(0, 8)} grant=${grant.code}`)
  return { channelId, leadId, workerId }
}

const L3 = await miniTeam('终测-线3测厚MQTT', 'ln-3fe5c1d9', ['dn-b8ee4f86'])
const L4 = await miniTeam('终测-线4CCD-HTTP', 'ln-7ca7874f', ['dn-79957615'])
console.log('RESULT ' + JSON.stringify({ L3, L4 }))
