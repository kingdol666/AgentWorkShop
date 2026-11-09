/**
 * 真实 LLM 频道装配：omp + ustc/deepseek-flash 的 lead/worker，绑 WWTP 产线，绑定面授权。
 * 用法：node scripts/_live-rsi-channels.mjs
 */
process.env.NO_PROXY = '127.0.0.1,localhost'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = JSON.parse(readFileSync(join(REPO, '.rsi-demo-state.json'), 'utf8'))
const BASE = state.base
const TOKEN = state.token
const H = { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const LLM = { provider: 'deepseek', model: 'deepseek-flash', effort: 'low' }

const mkChannel = async (name, lineId) => {
  const ch = await api('POST', '/api/workshop/channels', {
    name, lineId, leadAgent: { name: `${name}-Lead`, harness: 'omp', config: LLM },
  })
  const channelId = ch.data?.channelId
  const leadId = ch.data?.leadAgentId
  const worker = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    name: `${name}-Worker`, role: 'worker', harness: 'omp', config: LLM,
  })
  const workerId = worker.data?.id ?? worker.data?.agentId
  const act = await api('POST', `/api/workshop/channels/${channelId}/activate`)
  // 绑定面：line-recipe（产线配方管理权，覆盖 trial/update 全族）+ 全部 SP 点位 dcw 授权
  const b1 = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadId, nodeId: lineId, kind: 'line-recipe' })
  const b2 = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: workerId, nodeId: lineId, kind: 'line-recipe' })
  const tok = await api('POST', `/api/workshop/channels/${channelId}/agents/${leadId}/rotate-token`)
  return { channelId, leadId, workerId, act: act.status, bind: [b1.status, b2.status], leadToken: tok.data?.token }
}

console.log('── 频道 A（作业频道）──')
const A = await mkChannel(`WWTP-运行频道-${state.line.sfx}`, state.line.lineId)
console.log(`  A=${JSON.stringify({ ...A, leadToken: A.leadToken ? 'ok' : null })}`)
console.log('── 频道 B（同产线观摩频道，跨频道互读用）──')
const B = await mkChannel(`WWTP-协同频道-${state.line.sfx}`, state.line.lineId)
console.log(`  B=${JSON.stringify({ ...B, leadToken: B.leadToken ? 'ok' : null })}`)

state.channels = { A, B }
writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
console.log('[state] channels saved')
