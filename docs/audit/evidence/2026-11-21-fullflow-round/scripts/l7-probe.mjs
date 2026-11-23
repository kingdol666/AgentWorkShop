#!/usr/bin/env node
/**
 * L7-lite acceptance (no external model/twin needed):
 *  1) save_memory → search_memory round-trip on a real lead agent;
 *  2) send_cross_channel_message → arrival on the target channel.
 * Reply generation is NOT asserted (requires a live model), recorded as NOT_RUN.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3021'
const EVIDENCE = process.argv[2] ?? 'D:/tmp/aw-e2e-1121/evidence'
const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin
const SRC_LEAD = 'ec2758d0-53cc-41ff-8a98-e64a812dfa75'
const SRC_CH = '4bbf5d97-b677-499f-abaf-9698ac76a234'
const DST_CH = '830b81f3-5359-463d-b998-4ac99f360ca2'
mkdirSync(EVIDENCE, { recursive: true })

const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`${ok ? '✔' : '✖'} ${id}${detail ? ` — ${detail}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, timeoutMs = 60000) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* ignore */ }
  return { status: r.status, json, text }
}

const marker = `FULLFLOW-${Date.now().toString(36)}`

// 1) memory round-trip
const save = await api('POST', '/api/workshop/agent-tools/invoke', {
  agentId: SRC_LEAD,
  tool: 'save_memory',
  args: { title: `fullflow memory ${marker}`, content: `验收记忆标记 ${marker}:克重闭环读数以设备实读为基准。`, scope: 'private' },
})
const saveText = String(save.json?.data?.result?.text ?? '')
check('save_memory_accepted', save.json?.data?.result?.isError !== true && /已/.test(saveText), `status=${save.status} text=${saveText.slice(0, 60)}`)

const search = await api('POST', '/api/workshop/agent-tools/invoke', {
  agentId: SRC_LEAD,
  tool: 'search_memory',
  args: { query: marker, scope: 'auto', limit: 5 },
})
const searchText = String(search.json?.data?.result?.text ?? '')
check('search_memory_hits_own_write', search.json?.data?.result?.isError !== true && searchText.includes(marker), `hits=${/条/.exec(searchText)?.[0] ?? '?'}`)

// 2) cross-channel delivery
const xch = await api('POST', '/api/workshop/agent-tools/invoke', {
  agentId: SRC_LEAD,
  tool: 'send_cross_channel_message',
  args: { to_channel_id: DST_CH, message: `跨频道验收标记 ${marker}:仅验证到达,不要求模型回执。` },
}, 120000)
const xchText = String(xch.json?.data?.result?.text ?? '')
check('cross_channel_send_accepted', xch.json?.data?.result?.isError !== true, `status=${xch.status} text=${xchText.slice(0, 80)}`)

let arrived = null
const t0 = Date.now()
while (Date.now() - t0 < 90000) {
  const list = await api('GET', `/api/workshop/channels/${DST_CH}/messages?limit=50`, undefined, 20000)
  const data = list.json?.data
  const items = Array.isArray(data) ? data : (data?.items ?? [])
  arrived = items.find(m => (m.parts ?? []).some(p => String(p.text ?? '').includes(marker)))
  if (arrived) break
  await sleep(5000)
}
check('cross_channel_message_arrived', Boolean(arrived), arrived ? `createdAt=${arrived.createdAt ?? '-'}` : '90s timeout')

const summary = { total: checks.length, pass: checks.filter(c => c.status === 'PASS').length, fail: checks.filter(c => c.status !== 'PASS').length, notRun: ['cross_channel_reply_generation (needs live model)'] }
writeFileSync(join(EVIDENCE, 'l7-checks.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, marker, srcChannel: SRC_CH, dstChannel: DST_CH, checks, summary }, null, 2))
console.log(`RESULT ${JSON.stringify(summary)}`)
process.exit(summary.fail === 0 ? 0 : 1)
