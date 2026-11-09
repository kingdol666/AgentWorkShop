/**
 * 真实 LLM 冒烟 v2：走群聊面 @lead（人类↔Agent 正确入口），等待真实回复。
 * 用法：node scripts/_live-rsi-llm-smoke2.mjs
 */
process.env.NO_PROXY = '127.0.0.1,localhost'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = JSON.parse(readFileSync(join(REPO, '.rsi-demo-state.json'), 'utf8'))
const BASE = state.base
const H = { 'authorization': `Bearer ${state.token}`, 'content-type': 'application/json' }
const A = state.channels.A
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (method, path, body, timeoutMs = 60_000) => {
  const r = await fetch(BASE + path, {
    method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}

const tag = `hi${Date.now().toString(36).slice(-5)}`
const sent = await api('POST', `/api/workshop/channels/${A.channelId}/chat/messages`, {
  text: `【冒烟】请用一句话确认在线，并调用 line_status 工具报出当前绑定的产线是否在运行（不要编造）。标记 ${tag}`,
  mentions: [{ type: 'agent', id: A.leadId, label: 'Lead' }],
  clientMessageId: `smoke-${tag}`,
})
console.log(`sent=${sent.status} deliveries=${JSON.stringify(sent.data?.deliveries ?? [])}`)

const t0 = Date.now()
let reply = null
for (let i = 0; i < 100; i++) {
  await sleep(4000)
  const hist = await api('GET', `/api/workshop/channels/${A.channelId}/chat/messages?limit=20`)
  const items = hist.data?.messages ?? []
  const hit = items.find(m => m.senderKind === 'agent' && JSON.stringify(m.parts ?? m).includes(tag))
  if (hit) { reply = hit; break }
}
if (!reply) {
  console.error(`[smoke2] ${Math.round((Date.now() - t0) / 1000)}s 内无 lead 群聊回复`)
  process.exit(1)
}
const text = (reply.parts ?? []).map(p => p.text ?? '').join('\n')
console.log(`[smoke2] PASS 真实回复 ${Math.round((Date.now() - t0) / 1000)}s：${text.slice(0, 300)}`)
state.smoke2 = { tag, seconds: Math.round((Date.now() - t0) / 1000), text: text.slice(0, 260) }
writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
