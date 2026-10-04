// 收取 T7/T9 交付消息(健壮形状)
const B = 'http://localhost:3001'
const TOK = (await (await fetch(`${B}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }),
})).json()).data?.token
const H = { authorization: `Bearer ${TOK}` }
const pick = async (ch, n) => {
  const ms = await (await fetch(`${B}/api/workshop/channels/${ch}/messages?limit=${n}`, { headers: H })).json()
  const d = ms.data
  const items = Array.isArray(d) ? d : (d?.items ?? d?.messages ?? [])
  return [...items].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
}
const show = (label, arr, n = 1) => {
  console.log(`=== ${label} ===`)
  for (const m of arr.slice(-n)) {
    const who = m.fromAgentName ?? m.fromLabel ?? m.from ?? '?'
    const txt = (m.parts ?? []).map(p => p.text ?? '').join(' ')
    console.log(`[${String(m.createdAt ?? '').slice(11, 19)}] ${String(who).slice(0, 16)} :: ${txt.replace(/\n/g, ' | ').slice(0, 520)}`)
  }
}
show('T7 产线管理(lead)', await pick('06e6880e-7f6a-4d86-9dd1-088944468b90', 6))
show('T9a MQTT 测厚', await pick('ad44dbe4-10b3-445f-b956-2ac6e443df53', 5))
show('T9b HTTP CCD', await pick('cc06b794-23b3-4bfb-aed0-fd1270ad92ab', 5))
