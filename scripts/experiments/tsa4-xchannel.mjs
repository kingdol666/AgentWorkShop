// tsa4 round — explicit inter-channel communication probe.
// New line channel lead (4bbf5d97/ec2758d0) sends a cross-channel message to the legacy
// line channel lead (830b81f3/9e77484b); verifies delivery on the target and replies.
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const EV = join(process.cwd(), 'docs', 'audit', 'evidence', '2026-11-20-tsa4-v0140-round')
mkdirSync(EV, { recursive: true })
const BASE = 'http://127.0.0.1:3021'
const TOKEN = process.env.AW_TOKEN
const NEW_CH = '4bbf5d97-b677-499f-abaf-9698ac76a234'
const NEW_LEAD = 'ec2758d0-53cc-41ff-8a98-e64a812dfa75'
const OLD_CH = '830b81f3-5359-463d-b998-4ac99f360ca2'
const OLD_LEAD = '9e77484b-2eb4-4eac-b854-331b28de9a44'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const save = (name, obj) => writeFileSync(join(EV, name), JSON.stringify(obj, null, 1))

async function api(method, path, body, timeoutMs = 240_000) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  const text = await r.text()
  let json; try { json = JSON.parse(text) }
  catch { json = { raw: text.slice(0, 300) } }
  return { status: r.status, json }
}

const marker = `TSA4-跨频道联动-${Date.now().toString(36)}`
console.log('invoke send_cross_channel_message…')
const inv = await api('POST', '/api/workshop/agent-tools/invoke', {
  agentId: NEW_LEAD,
  tool: 'send_cross_channel_message',
  args: { to_channel_id: OLD_CH, message: `${marker}:新线(ln-a80dfb0d)已重建并完成冒烟闭环(回读72=72),请旧线班组确认收到本条跨频道口径同步,并用 poll_messages 回执一句话即可。`, require_reply: true },
})
save('xch-invoke.json', { status: inv.status, resultHead: String(inv.json?.data?.result?.text ?? '').slice(0, 600) })
console.log('invoke status=', inv.status, String(inv.json?.data?.result?.text ?? '').slice(0, 160).replace(/\n/g, ' '))

let arrived = null
const t0 = Date.now()
while (Date.now() - t0 < 10 * 60_000) {
  const list = (await api('GET', `/api/workshop/channels/${OLD_CH}/messages?limit=30`, undefined, 20_000)).json?.data ?? []
  const items = Array.isArray(list) ? list : (list.items ?? [])
  arrived = items.find(m => (m.parts ?? []).some(p => String(p.text ?? '').includes(marker)))
  if (arrived) break
  await sleep(15_000)
}
save('xch-arrival.json', { arrived: Boolean(arrived), at: arrived?.createdAt ?? null, from: arrived?.fromAgentId ?? null })
console.log('arrival on old channel:', Boolean(arrived), arrived?.createdAt ?? 'timeout')

let reply = null
const t1 = Date.now()
while (Date.now() - t1 < 10 * 60_000) {
  const list = (await api('GET', `/api/workshop/channels/${OLD_CH}/messages?limit=30`, undefined, 20_000)).json?.data ?? []
  const items = Array.isArray(list) ? list : (list.items ?? [])
  const idx = items.findIndex(m => (m.parts ?? []).some(p => String(p.text ?? '').includes(marker)))
  if (idx >= 0) {
    const after = items.slice(0, idx).find(m => m.fromAgentId && Date.parse(m.createdAt ?? '') > Date.parse(items[idx].createdAt ?? '') && (m.parts ?? []).some(p => String(p.text ?? '').length > 10))
    if (after) { reply = after; break }
  }
  await sleep(20_000)
}
save('xch-reply.json', { replied: Boolean(reply), from: reply?.fromAgentId ?? null, head: reply ? (reply.parts ?? []).map(p => p.text ?? '').join('').slice(0, 200) : null })
console.log('old-lead reply:', Boolean(reply))
console.log('XCH-RESULT ' + JSON.stringify({ invoke: inv.status, arrived: Boolean(arrived), replied: Boolean(reply) }))
