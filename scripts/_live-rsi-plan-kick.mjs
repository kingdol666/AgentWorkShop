/**
 * 推进项目计划：@Project Leader（真实 omp）提出 v1 计划 → owner 批准。
 * 用法：node scripts/_live-rsi-plan-kick.mjs
 */
process.env.NO_PROXY = '127.0.0.1,localhost'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = JSON.parse(readFileSync(join(REPO, '.rsi-demo-state.json'), 'utf8'))
const BASE = state.base
const H = { 'authorization': `Bearer ${state.token}`, 'content-type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (method, path, body, timeoutMs = 60_000) => {
  const r = await fetch(BASE + path, {
    method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const P = state.project
const deliverableId = state.project.deliverableId
const workItemId = state.project.workItemId

const tag = `plan${Date.now().toString(36).slice(-5)}`
const sent = await api('POST', `/api/workshop/channels/${P.officeChannelId}/chat/messages`, {
  text: `【计划请求】请为本项目提出 plan v1：facts 说明已确认产线 ${state.line.lineId} 与受治理整定路径；deliverables 只引用既有交付物 ${deliverableId}（key 用其 id，channelId=" + A.channelId + ")；不要新增 work_items（工作项已存在 ${workItemId}）。完成后确认。标记 ${tag}`,
  mentions: [{ type: 'agent', id: P.leadAgentId, label: 'Project Leader' }],
  clientMessageId: `plan-${tag}`,
})
console.log(`sent=${sent.status} deliveries=${JSON.stringify((sent.data?.deliveries ?? []).map(d => d.status))}`)

let approval = null
for (let i = 0; i < 60; i++) {
  await sleep(8000)
  const items = (await api('GET', `/api/workshop/projects/${P.id}/approvals`)).data ?? []
  approval = items.find(x => x.kind === 'plan_approval' && x.status === 'pending') ?? null
  if (approval) break
}
if (!approval) {
  console.error('[plan] 8 分钟内 leader 未产出计划提案')
  process.exit(1)
}
console.log(`[plan] 提案已生成 approval=${approval.id}`)
const dec = await api('POST', `/api/workshop/projects/${P.id}/approvals/${approval.id}/decide`, { approve: true, reason: 'RSI live demo 计划批准' })
console.log(`[plan] owner 批准 status=${dec.status}`)
const proj = (await api('GET', `/api/workshop/projects/${P.id}`)).data
console.log(`[plan] planVersion=${proj?.planVersion}`)
state.project.planApproved = dec.status === 200
writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
