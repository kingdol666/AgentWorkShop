/**
 * 真实 LLM 冒烟：向频道 A lead 发一条消息，等待真实回复（omp + ustc/deepseek-flash）。
 * 用法：node scripts/_live-rsi-llm-smoke.mjs
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

const tag = `smoke${Date.now().toString(36).slice(-5)}`
const msg = await api('POST', `/api/workshop/channels/${A.channelId}/messages`, {
  toAgentId: A.leadId,
  text: `【冒烟】请只回复一句话确认你在线，并报出你当前绑定的产线名称（用 line_status 或 line_context 工具查证，不要编造）。标记 ${tag}`,
})
console.log(`msg=${msg.status} code=${msg.code}`)

let reply = null
for (let i = 0; i < 90; i++) {
  await sleep(4000)
  const hist = await api('GET', `/api/workshop/channels/${A.channelId}/messages?limit=30`)
  const items = hist.data ?? []
  const hit = items.find(m => m.role === 'ROLE_AGENT' && JSON.stringify(m.parts ?? []).includes(tag))
  if (hit) { reply = hit; break }
}
if (!reply) {
  console.error('[smoke] 6 分钟内无真实回复')
  process.exit(1)
}
const text = (reply.parts ?? []).map(p => p.text ?? '').join('\n')
console.log(`[smoke] PASS 真实回复(${Math.round((Date.now() - Date.parse(reply.createdAt ?? new Date())) / 1000)}s 内): ${text.slice(0, 400)}`)
state.smoke = { tag, replyAt: reply.createdAt, text: text.slice(0, 200) }
writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
