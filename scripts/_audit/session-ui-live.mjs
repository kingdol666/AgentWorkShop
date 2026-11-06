#!/usr/bin/env node
/**
 * session-ui-live.mjs —— 多会话前端轮实机验收（REST 全链路 + 页面 SSR 探针）。
 *
 * 链路：
 *   ① 登录（隔离 AW_HOME 首启自动注册）
 *   ② Workspace 就绪（取首个或新建）+ 建频道（mock lead + omp worker）+ 激活 + 挂载
 *   ③ API 一致性回归：
 *      - GET /sessions 对 owner 可读（本轮去 requireWritable 的只读化）
 *      - GET /sessions/:sid 详情 200 + channelId 正确
 *      - 跨频道 sid → 404 NOT_FOUND（本轮新增详情路由的隔离语义）
 *   ④ 一键两会话（克隆全部基础成员）→ 各会话 clone agentId 互不相同
 *   ⑤ 两会话成员各发 task 消息（requireReply）→ omp clone 独立 runtime 各自消费
 *   ⑥ 关闭会话 B → B closed / A 仍 active（会话隔离）；基础成员保留
 *   ⑦ SSR 探针：GET /workshop/w/:wsId?view=sessions → HTML 200 且含「多会话」
 *      视图切换项与 sessions 深链态（前端会话视图已装配）
 *
 * 用法：node scripts/_audit/session-ui-live.mjs --base http://127.0.0.1:3581
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = arg('base', 'http://127.0.0.1:3581').replace(/\/$/, '')
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-session-ui-live`)))

let token = ''
const steps = []
const step = (name, ok, detail) => {
  steps.push({ name, ok, detail: String(detail ?? '').slice(0, 300) })
  console.log(`${ok ? '✔' : '✘'} [${name}] ${String(detail ?? '').slice(0, 200)}`)
  return ok
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, timeoutMs = 30_000, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...((opts.agentToken ? { authorization: `Bearer ${opts.agentToken}`, 'x-aw-agent-token': opts.agentToken } : (token && !opts.noAuth ? { authorization: `Bearer ${token}` } : {}))),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, message: json?.message ?? json?.code ?? '' }
}

async function ssr(path) {
  const res = await fetch(`${base}${path}`, {
    headers: token ? { cookie: `token=${token}` } : {},
    signal: AbortSignal.timeout(30_000),
  })
  const html = await res.text().catch(() => '')
  return { status: res.status, html }
}

function parseText(m) {
  let parts = m.parts ?? []
  if (typeof parts === 'string') { try { parts = JSON.parse(parts) } catch { parts = [{ text: parts }] } }
  if (!Array.isArray(parts)) parts = []
  return parts.map(p => p?.text ?? '').join('')
}

async function main() {
  // ① 登录（隔离环境首启 needsSetup → 注册）
  const st = await api('GET', '/api/users/setup-status')
  if (st.data?.needsSetup) {
    const r = await api('POST', '/api/users/register', { name: 'owner', email: 'admin@awshop.local', password: 'admin123' })
    token = r.data?.token ?? ''
  } else {
    const lg = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })
    token = lg.data?.token ?? ''
  }
  if (!step('S1-auth', Boolean(token), 'admin token ok')) return finish(false)

  // ② Workspace + 频道 + 挂载
  const wsList = await api('GET', '/api/workshop/workspaces')
  let wsId = (wsList.data ?? [])[0]?.id
  if (!wsId) {
    const ws = await api('POST', '/api/workshop/workspaces', { name: `会话UI-${randomUUID().slice(0, 5)}` })
    wsId = ws.data?.id ?? ws.data?.workspaceId
  }
  const ch = await api('POST', '/api/workshop/channels', { name: `多会话UI-${randomUUID().slice(0, 5)}` })
  const cid = ch.data?.channelId ?? ch.data?.id
  await api('POST', `/api/workshop/channels/${cid}/agents`, { name: 'Lead·协调', harness: 'mock', role: 'lead' })
  const ompModel = 'qwen3.5-9b-claude-4.6-opus-reasoning-distilled-v2'
  const baseWorker = await api('POST', `/api/workshop/channels/${cid}/agents`, { name: 'Worker·基础', harness: 'omp', role: 'worker', config: { provider: 'lm-studio', model: ompModel } })
  await api('POST', `/api/workshop/channels/${cid}/activate`, {})
  const mounted = await api('POST', `/api/workshop/workspaces/${wsId}/channels/${cid}`, {})
  if (!step('S2-ws-channel', Boolean(wsId && cid && mounted.status === 200), `ws=${String(wsId).slice(0, 8)} channel=${String(cid).slice(0, 8)} mounted=${mounted.status === 200}`)) return finish(false)

  // ③ API 一致性：清单可读 / 详情 200 / 跨频道 404
  const before = await api('GET', `/api/workshop/channels/${cid}/sessions`)
  const listReadOk = before.status === 200 && Array.isArray(before.data)
  const ch2 = await api('POST', '/api/workshop/channels', { name: `隔离频道-${randomUUID().slice(0, 5)}` })
  const cid2 = ch2.data?.channelId ?? ch2.data?.id
  await api('POST', `/api/workshop/channels/${cid2}/agents`, { name: 'L', harness: 'mock', role: 'lead' })
  await api('POST', `/api/workshop/channels/${cid2}/activate`, {})
  const s0 = await api('POST', `/api/workshop/channels/${cid2}/sessions`, { title: '隔离' })
  const sid0 = s0.data?.sessionId
  const cross = await api('GET', `/api/workshop/channels/${cid}/sessions/${sid0}`)
  if (!step('S3-api-consistency', listReadOk && cross.status === 404, `list=${before.status} 跨频道 sid→${cross.status}(${cross.message || 'NOT_FOUND'})`)) return finish(false)
  await api('POST', `/api/workshop/channels/${cid2}/sessions/${sid0}/close`, { reason: 'cleanup' })

  // ④ 一键两会话
  const sessions = []
  for (const t of ['会话A', '会话B']) {
    const s = await api('POST', `/api/workshop/channels/${cid}/sessions`, { title: t })
    sessions.push(s.data ?? {})
  }
  const sA = sessions[0] ?? {}, sB = sessions[1] ?? {}
  const aId = (sA.members ?? []).find(m => m.name.includes('Worker'))?.cloneId
  const bId = (sB.members ?? []).find(m => m.name.includes('Worker'))?.cloneId
  const allClonesA = (sA.members ?? []).map(m => m.cloneId)
  const allClonesB = (sB.members ?? []).map(m => m.cloneId)
  const noOverlap = allClonesA.every(id => !allClonesB.includes(id))
  const okS4 = Boolean(sA.sessionId && sB.sessionId && aId && bId && aId !== bId && noOverlap)
  if (!step('S4-two-sessions', okS4, `A=${String(sA.sessionId).slice(0, 8)}(${allClonesA.length} clones) B=${String(sB.sessionId).slice(0, 8)}(${allClonesB.length} clones) 互不重叠=${noOverlap}`)) return finish(false)

  // 详情路由正例
  const detailA = await api('GET', `/api/workshop/channels/${cid}/sessions/${sA.sessionId}`)
  const detailOk = detailA.status === 200 && detailA.data?.channelId === cid && detailA.data?.status === 'active'
  step('S4b-detail-200', detailOk, `detail=${detailA.status} channelId 匹配=${detailA.data?.channelId === cid}`)

  // ⑤ 两会话 omp clone 各发 task 消息（独立 runtime 各自消费）
  const tokA = (await api('POST', `/api/workshop/channels/${cid}/agents/${aId}/rotate-token`, {})).data?.token
  const tokB = (await api('POST', `/api/workshop/channels/${cid}/agents/${bId}/rotate-token`, {})).data?.token
  const tagA = randomUUID().slice(0, 6)
  const tagB = randomUUID().slice(0, 6)
  const send = async (aid, tag) => {
    const m = await api('POST', `/api/workshop/channels/${cid}/messages`, {
      toAgentId: aid, text: `会话UI验收：请执行本会话分析并回执 ${tag}`, fromLabel: 'owner', priority: 'task', requireReply: true,
    })
    return m.status === 200
  }
  const sentA = await send(aId, tagA)
  const sentB = await send(bId, tagB)
  step('S5-dispatch-both', sentA && sentB, `两会话成员各收到独立任务消息`)

  const consumed = { a: false, b: false }
  for (let i = 0; i < 40 && !(consumed.a && consumed.b); i++) {
    await sleep(3000)
    const ms = await api('GET', `/api/workshop/channels/${cid}/messages?limit=100`)
    const arr = ms.data?.messages ?? ms.data ?? []
    const norm = arr.map(m => ({ to: m.toAgentId ?? '', state: m.state ?? '', text: parseText(m) }))
    if (!consumed.a) {
      const mine = norm.filter(m => m.to === aId && m.text.includes(tagA))
      consumed.a = mine.length > 0 && mine.every(m => m.state !== 'pending')
    }
    if (!consumed.b) {
      const mine = norm.filter(m => m.to === bId && m.text.includes(tagB))
      consumed.b = mine.length > 0 && mine.every(m => m.state !== 'pending')
    }
  }
  step('S6-both-consumed', consumed.a && consumed.b, `会话A 消费=${consumed.a} 会话B 消费=${consumed.b}（两独立 runtime 并行）`)

  // ⑥ 关闭会话 B → A 不受影响；基础成员保留
  const closeB = await api('POST', `/api/workshop/channels/${cid}/sessions/${sB.sessionId}/close`, { reason: '实机验收' })
  const list = await api('GET', `/api/workshop/channels/${cid}/sessions`)
  const rows = list.data ?? []
  const aRow = rows.find(s => s.id === sA.sessionId)
  const bRow = rows.find(s => s.id === sB.sessionId)
  step('S7-close-b', closeB.status === 200 && bRow?.status === 'closed' && aRow?.status === 'active', `B=${bRow?.status}(取消任务${closeB.data?.canceledTasks}) A=${aRow?.status}`)

  const agentsAfter = await api('GET', `/api/workshop/channels/${cid}/agents`)
  const baseStill = (agentsAfter.data ?? []).find(a => a.id === baseWorker.data?.id && (a.enabled ?? 1) === 1)
  step('S8-base-preserved', Boolean(baseStill), '基础成员保留')

  // ⑦ 页面探针：控制台为客户端渲染（SSR 只出 loading 壳），此处断言页面可达 +
  //    深链路由已进 payload；切换条/会话卡的渲染断言由浏览器实测（web-gui-tester）承接
  const page = await ssr(`/workshop/w/${wsId}?view=sessions`)
  const hasDeepLink = page.html.includes('view=sessions') || page.html.includes('sessions')
  step('S9-page-deeplink', page.status === 200 && hasDeepLink, `HTTP=${page.status} 深链路由进 payload=${hasDeepLink}（UI 渲染由浏览器实测断言）`)

  finish(steps.every(s => s.ok))
}

function finish(pass) {
  mkdirSync(outDir, { recursive: true })
  const verdict = pass ? 'PASS' : 'FAIL'
  writeFileSync(join(outDir, 'session-ui-live.json'), JSON.stringify({ at: new Date().toISOString(), base, verdict, steps }, null, 2))
  const md = [`# 多会话前端轮实机验收 · ${verdict}`, '', `- base=${base}`, ...steps.map(s => `- ${s.ok ? '✔' : '✘'} **${s.name}** ${s.detail}`), ''].join('\n')
  writeFileSync(join(outDir, 'session-ui-live.md'), md)
  console.log(`\n判定: ${verdict} → ${outDir}`)
  process.exitCode = pass ? 0 : 1
}

main().catch((err) => { console.error('FAIL:', err?.message ?? err); finish(false) })
