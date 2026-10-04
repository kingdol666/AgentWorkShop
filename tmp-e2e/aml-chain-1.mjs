// AML 孪生链 驱动 batch1: discover → compile → freeze
const B = 'http://localhost:3001'
const TOK = (await (await fetch(`${B}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }),
})).json()).data?.token
const H = { 'authorization': `Bearer ${TOK}`, 'content-type': 'application/json' }
const LEAD = '8e5ce1b7-43ee-41f2-b9e7-b6a6346085d9'
const invoke = async (tool, args) => {
  const r = await (await fetch(`${B}/api/workshop/agent-tools/invoke`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: LEAD, tool, args }) })).json()
  const text = r.data?.result?.text ?? r.message ?? JSON.stringify(r).slice(0, 200)
  console.log(`\n### ${tool} (code=${r.code})\n` + String(text).slice(0, 700))
  return text
}
await invoke('twin_scene_discover', { line_id: 'ln-83cfc594' })
await invoke('twin_provider_catalog', {})
