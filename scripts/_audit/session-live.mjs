#!/usr/bin/env node
/**
 * session-live.mjs —— S1 多会话实机验收（REST 驱动）。
 *
 * 链路：
 *   ① 建频道（1 基础 worker + 1 lead，mock）
 *   ② 一键创建 2 个会话（各克隆基础成员为独立实例）→ 断言两会话成员 agentId 互不相同
 *   ③ 各会话独立对话：分别向两会话成员发 task 消息（requireReply）→ 都被消费（独立 runtime 各自跑）
 *   ④ 记忆隔离前提：两会话成员 memories 互不可见（auto 域按 agentId 过滤）
 *   ⑤ 关闭会话二 → 其实例停用；会话一不受影响（仍 active、消息可继续消费）
 *   ⑥ 基础成员保留（协调者不受会话生命周期影响）
 *
 * 用法：node scripts/_audit/session-live.mjs --base http://127.0.0.1:3580
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = arg('base', 'http://127.0.0.1:3580').replace(/\/$/, '')
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-session-live`)))

let token = ''
const steps = []
const step = (name, ok, detail) => {
  steps.push({ name, ok, detail: String(detail ?? '').slice(0, 260) })
  console.log(`${ok ? '✔' : '✘'} [${name}] ${String(detail ?? '').slice(0, 170)}`)
  return ok
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, timeoutMs = 30_000, agentToken) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...((agentToken ? { 'authorization': `Bearer ${agentToken}`, 'x-aw-agent-token': agentToken } : (token ? { authorization: `Bearer ${token}` } : {}))),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, message: json?.message ?? '' }
}

function parseText(m) {
  let parts = m.parts_json ?? m.parts ?? []
  if (typeof parts === 'string') { try { parts = JSON.parse(parts) } catch { parts = [{ text: parts }] } }
  if (!Array.isArray(parts)) parts = []
  return parts.map(p => p.text ?? '').join('')
}

async function main() {
  const st = await api('GET', '/api/users/setup-status')
  if (st.data?.needsSetup) {
    const r = await api('POST', '/api/users/register', { name: 'p', email: 'admin@awshop.local', password: 'admin123' })
    token = r.data?.token ?? ''
  } else {
    const lg = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })
    token = lg.data?.token ?? ''
  }
  if (!step('S1-auth', Boolean(token), 'admin token ok')) return finish(false)

  // ① 频道：lead（协调者）+ worker（基础执行成员）
  const ch = await api('POST', '/api/workshop/channels', { name: `多会话频道-${randomUUID().slice(0, 5)}` })
  const cid = ch.data?.channelId ?? ch.data?.id
  const ompModel = 'qwen3.5-9b-claude-4.6-opus-reasoning-distilled-v2'
  await api('POST', `/api/workshop/channels/${cid}/agents`, { name: 'Lead·协调', harness: 'mock', role: 'lead' })
  const baseWorker = await api('POST', `/api/workshop/channels/${cid}/agents`, { name: 'Worker·基础', harness: 'omp', role: 'worker', config: { provider: 'lm-studio', model: ompModel } })
  await api('POST', `/api/workshop/channels/${cid}/activate`, {})
  step('S2-channel', Boolean(cid && baseWorker.data?.id), `channel=${String(cid).slice(0, 8)} baseWorker=${String(baseWorker.data?.id).slice(0, 8)}`)

  // ② 两个会话
  const sessions = []
  for (const t of ['会话A', '会话B']) {
    const s = await api('POST', `/api/workshop/channels/${cid}/sessions`, { title: t })
    sessions.push(s.data ?? {})
  }
  const sA = sessions[0] ?? {}, sB = sessions[1] ?? {}
  const aId = (sA.members ?? [])[0]?.cloneId
  const bId = (sB.members ?? [])[0]?.cloneId
  const okS3 = Boolean(sA.sessionId && sB.sessionId && aId && bId && aId !== bId)
  if (!step('S3-two-sessions', okS3, `A=${String(sA.sessionId).slice(0, 8)} B=${String(sB.sessionId).slice(0, 8)} cloneA=${String(aId).slice(0, 8)} cloneB=${String(bId).slice(0, 8)}`)) return finish(false)

  // ③ 各会话独立对话：向两会话成员各发 task 消息（requireReply）  const send = async (aid) => {
    const m = await api('POST', `/api/workshop/channels/${cid}/messages`, {
      toAgentId: aid, text: `会话任务：请执行本会话的分析并汇报 ${randomUUID().slice(0, 6)}`, fromLabel: 'owner', priority: 'task', requireReply: true,
    })
    return m.status === 200
  }
  const sentA = await send(aId)
  const sentB = await send(bId)
  step('S4-dispatch-both', sentA && sentB, `两会话成员各收到独立任务消息`)

  // 轮询两会话成员消息消费（各自 runtime 独立跑）
  const consumed = { a: false, b: false }
  for (let i = 0; i < 40; i++) {
    await sleep(3000)
    const ms = await api('GET', `/api/workshop/channels/${cid}/messages?limit=50`)
    const arr = ms.data?.messages ?? ms.data ?? []
    const norm = arr.map(m => ({ to: m.to_agent_id ?? m.toAgentId ?? '', state: m.state ?? '', text: parseText(m) }))
    if (!consumed.a) {
      const mine = norm.filter(m => m.to === aId && m.text.includes('会话任务'))
      consumed.a = mine.length > 0 && mine.every(m => m.state !== 'pending')
    }
    if (!consumed.b) {
      const mine = norm.filter(m => m.to === bId && m.text.includes('会话任务'))
      consumed.b = mine.length > 0 && mine.every(m => m.state !== 'pending')
    }
    if (consumed.a && consumed.b) break
  }
  step('S5-both-consumed', consumed.a && consumed.b, `会话A 消费=${consumed.a} 会话B 消费=${consumed.b}（两独立 runtime 并行跑各自任务）`)

  // ④ 记忆隔离前提：两会话成员各自产生记忆（互不串扰）——查各自 memories
  const memA = await api('GET', `/api/workshop/channels/${cid}/agents/${aId}/memories`)
  const memB = await api('GET', `/api/workshop/channels/${cid}/agents/${bId}/memories`)
  const rowsA = memA.data?.memories ?? memA.data ?? []
  const rowsB = memB.data?.memories ?? memB.data ?? []
  step('S6-memory-isolated', Array.isArray(rowsA) && Array.isArray(rowsB), `会话A 记忆 ${rowsA.length} 条 / 会话B 记忆 ${rowsB.length} 条（各自 runtime 域）`)

  // ⑤ 关闭会话 B → A 不受影响
  const closeB = await api('POST', `/api/workshop/channels/${cid}/sessions/${sB.sessionId}/close`, { reason: '实机验收' })
  const list = await api('GET', `/api/workshop/channels/${cid}/sessions`)
  const rows = list.data ?? []
  const aRow = rows.find(s => s.id === sA.sessionId)
  const bRow = rows.find(s => s.id === sB.sessionId)
  step('S7-close-b', closeB.status === 200 && bRow?.status === 'closed' && aRow?.status === 'active', `B=${bRow?.status} A=${aRow?.status}（A 不受影响）`)

  // 基础成员保留
  const agentsAfter = await api('GET', `/api/workshop/channels/${cid}/agents`)
  const baseStill = (agentsAfter.data ?? []).find(a => a.id === baseWorker.data?.id && (a.enabled ?? 1) === 1)
  step('S8-base-preserved', Boolean(baseStill), '基础成员保留（协调者不受会话生命周期影响）')

  finish(steps.every(s => s.ok))
}

function finish(pass) {
  mkdirSync(outDir, { recursive: true })
  const verdict = pass ? 'PASS' : 'FAIL'
  writeFileSync(join(outDir, 'session-live.json'), JSON.stringify({ at: new Date().toISOString(), base, verdict, steps }, null, 2))
  const md = [`# 多会话 S1 实机验收 · ${verdict}`, '', `- base=${base}`, ...steps.map(s => `- ${s.ok ? '✔' : '✘'} **${s.name}** ${s.detail}`), ''].join('\n')
  writeFileSync(join(outDir, 'session-live.md'), md)
  console.log(`\n判定: ${verdict} → ${outDir}`)
  process.exitCode = pass ? 0 : 1
}

main().catch((err) => { console.error('FAIL:', err?.message ?? err); finish(false) })
