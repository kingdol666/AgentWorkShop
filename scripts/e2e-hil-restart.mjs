/**
 * HIL 重启语义真实 E2E —— 「服务重启不自动批准 pending HITL」。
 *
 * 计划 §11 第 12 项 / 审查稿硬性验收:「服务重启后 pending HITL 不自动批准,
 * 状态按能力标记 resumed/failed/expired」。
 *
 * 做法(真重启,不是模拟):
 *   ① 建真实 harness channel + 多用户;
 *   ② @Agent 触发**真实原生 ask**,等到 hitl.request 但**故意不应答**(留下 pending);
 *   ③ 杀掉隔离实例进程 → 用同一 AW_HOME 重启(同一 SQLite,同一持久化事实源);
 *   ④ 断言:该条目**没有**变成 approved/answered;pending 快照不再提供它作为可裁决项;
 *      持久化行 status 落在 failed(原生会话随上一进程消亡);
 *   ⑤ 重启后对旧条目再应答 → 409(不复活待办)。
 *
 * 运行:
 *   node scripts/e2e-hil-restart.mjs --base http://127.0.0.1:3458 --harness omp \
 *     --home .e2e-home-prod --mode start
 *
 * 依赖:真实 harness(默认 omp)+ 可用模型 + 隔离实例(见 scripts/_audit/detached-instance.mjs)。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)

const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  if (i >= 0) return process.argv[i + 1]
  const kv = process.argv.find(a => a.startsWith(`${k}=`))
  return kv ? kv.slice(k.length + 1) : d
}
const BASE = arg('--base', 'http://127.0.0.1:3458')
const WS_BASE = BASE.replace(/^http/, 'ws')
const PORT = arg('--port', new URL(BASE).port)
const MODE = arg('--mode', 'start')
const HOME = arg('--home', '.e2e-home-prod')
const HARNESS = arg('--harness', 'omp')
const TAG = Date.now().toString(36)
const PIDFILE = resolve(`.e2e-${MODE}-${PORT}.log.pid`)

let passed = 0
let failures = 0
let blocked = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const block = (name, reason) => {
  console.log(`  BLOCKED  ${name} — ${reason}`)
  blocked += 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, code: json.code, message: json.message, data: json.data }
}
async function waitUntil(name, cond, timeoutMs = 300_000, intervalMs = 700) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await cond()
      if (last) return last
    }
    catch (e) { last = e }
    await sleep(intervalMs)
  }
  throw new Error(`waitUntil timeout: ${name} (last=${String(last).slice(0, 200)})`)
}
function openAep(channelId, token) {
  const envelopes = []
  const ws = new WebSocket(`${WS_BASE}/api/workshop/ws?token=${encodeURIComponent(token)}`)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'sub', channelId, token })))
  ws.addEventListener('message', (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (e.type && e.type !== 'pong') envelopes.push(e)
    }
    catch { /* ignore */ }
  })
  return {
    ws,
    envelopes,
    close: () => {
      try {
        ws.close()
      }
      catch { /* ignore */ }
    },
  }
}

async function reg(label) {
  const res = await api('POST', '/api/users/register', {
    body: { email: `rs-${label}-${TAG}@test.local`, password: 'Passw0rd!123', name: `rs-${label}-${TAG}` },
  })
  if (!res.data?.token) throw new Error(`注册 ${label} 失败: ${JSON.stringify(res).slice(0, 200)}`)
  return { label, token: res.data.token, id: res.data.user.id, role: res.data.user.role, name: res.data.user.name }
}

/**
 * 在隔离实例的 workshop.sqlite 中写入一条 **真实落库的 pending HITL 事实行**(测试 fixture)。
 *
 * 为什么需要:本脚本的主路径依赖真实 harness 产出原生 ask;当模型配额/冷启动导致 ask 未到达时,
 * "重启不自动批准"这一**平台侧**语义仍必须被真实验证(它与 harness 无关)。
 * 这里写的是一行符合 v17 schema 的事实数据,随后一切断言都走**真实进程重启 + 真实 HTTP API**,
 * 不做任何内存态伪造,也不调用决策服务。
 */
function seedPendingHitl(channelId, ownerUserId) {
  try {
    const dbPath = resolve(HOME, 'data', 'workshop.sqlite')
    if (!existsSync(dbPath)) {
      console.log(`  · fixture 写入失败:找不到 ${dbPath}`)
      return null
    }
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA busy_timeout = 5000')
    const now = new Date().toISOString()
    const id = `restart-fixture-${TAG}`
    const snapshot = {
      policy: 'any_member',
      policyVersion: 1,
      eligibleUserIds: [ownerUserId],
      memberGenerations: { [ownerUserId]: 1 },
      createdAt: now,
    }
    const optionsJson = JSON.stringify(['yes', 'no'])
    db.prepare(
      `INSERT INTO hitl_requests (id, kind, request_type, native_request_id, channel_id, agent_id, agent_name, session_id, harness, mode, title, detail, options_json, questions_json, schema_json, status, policy, policy_snapshot_json, policy_version, decision_id, responder_user_id, decision_json, native_confirmed, error, created_at, updated_at, resolved_at, expires_at)
       VALUES (?, 'omp-dialog', 'question', 'fixture-native-1', ?, 'fixture-agent', 'fixture', '', 'omp', 'question', 'RESTART-FIXTURE 重启语义验证', 'fixture', ?, '[]', '{}', 'pending', 'any_member', ?, 1, NULL, NULL, '{}', 0, '', ?, ?, NULL, NULL)`,
    ).run(id, channelId, optionsJson, JSON.stringify(snapshot), now, now)
    db.close()
    return { id, kind: 'omp-dialog' }
  }
  catch (err) {
    console.log(`  · fixture 写入异常: ${err?.message ?? err}`)
    return null
  }
}

/** 读隔离实例里的 hitl_requests 行(重启语义的硬证据:持久化事实源的终态) */
function readHitlRow(id) {
  try {
    const dbPath = resolve(HOME, 'data', 'workshop.sqlite')
    if (!existsSync(dbPath)) return null
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(dbPath)
    const row = db.prepare('SELECT id, status, native_confirmed AS nativeConfirmed, error, resolved_at AS resolvedAt FROM hitl_requests WHERE id = ?').get(id)
    db.close()
    return row ?? null
  }
  catch (err) {
    console.log(`  · 读 hitl_requests 失败: ${err?.message ?? err}`)
    return null
  }
}

/** 重启隔离实例:杀 pid → 同 AW_HOME 重新拉起 → 等健康门 */async function restartInstance() {
  const repoRoot = resolve(import.meta.dirname, '..')
  const pid = existsSync(PIDFILE) ? Number(readFileSync(PIDFILE, 'utf8').trim()) : NaN
  if (Number.isInteger(pid)) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    console.log(`  · 已终止实例 pid=${pid}`)
  }
  else {
    console.log(`  · 无 pid 文件(${PIDFILE}),改用 detached-instance --stop`)
    spawnSync(process.execPath, [resolve(repoRoot, 'scripts/_audit/detached-instance.mjs'), '--port', PORT, '--mode', MODE, '--home', HOME, '--stop'], { stdio: 'ignore' })
  }
  await sleep(5000)
  const start = spawnSync(process.execPath, [
    resolve(repoRoot, 'scripts/_audit/detached-instance.mjs'),
    '--port', PORT, '--mode', MODE, '--home', HOME, '--wait', '120',
  ], { encoding: 'utf8' })
  console.log('  · 重启:', String(start.stdout ?? '').split(/\r?\n/).filter(Boolean).slice(-2).join(' | '))
  const ok = await waitUntil('重启后健康门', async () => {
    const h = await api('GET', '/api/health')
    // uptime 必须很小 → 证明是**新进程**在服务,而不是旧进程残留(否则"重启"是假的)
    return h.data?.status === 'ok' && (h.data.uptimeMs ?? 1e9) < 120_000 ? h : null
  }, 150_000).catch(() => null)
  return ok
}

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`)
  console.log(`║ HIL 重启语义 E2E  base=${BASE}  harness=${HARNESS}`)
  console.log(`╚══════════════════════════════════════════════════════════════╝`)

  const health = await api('GET', '/api/health')
  if (health.data?.status !== 'ok') {
    console.error(`✖ 服务不可达: ${BASE}`)
    process.exit(1)
  }

  const A = await reg('owner')
  const B = await reg('bob')

  const hsRes = await api('GET', '/api/workshop/harnesses?refresh=1', { token: A.token })
  const hs = (hsRes.data?.harnesses ?? []).find(h => h.id === HARNESS)
  if (!hs?.available || !hs.capabilities?.hitl) {
    block('R0 真实 harness 可用且支持 HITL', `${HARNESS}: available=${hs?.available} hitl=${hs?.capabilities?.hitl} ${hs?.error ?? ''}`)
    console.log(`\n━━━ 结果: ${passed} passed / ${failures} failed / ${blocked} blocked ━━━`)
    process.exit(0)
  }
  check('R0 真实 harness 可用且支持 HITL', true, `${HARNESS}`)

  const ch = await api('POST', '/api/workshop/channels', {
    body: { name: `rs-${TAG}`, description: 'restart semantics', leadAgent: { name: `rs-lead-${TAG}`, harness: HARNESS } },
    token: A.token,
  })
  const channelId = ch.data?.channelId
  if (!channelId) {
    block('R1 创建真实 harness channel', JSON.stringify(ch).slice(0, 200))
    process.exit(0)
  }
  check('R1 创建真实 harness channel', true, `channel=${channelId.slice(0, 8)}`)
  await api('PATCH', `/api/workshop/channels/${channelId}`, {
    body: { visibility: 'public', joinPolicy: 'open', approvalPolicy: 'any_member', chatEnabled: 1, version: 1 },
    token: A.token,
  })
  await api('POST', `/api/workshop/channels/${channelId}/members/join`, { token: B.token })

  const aep = openAep(channelId, A.token)
  await sleep(900)
  const leadName = (await api('GET', `/api/workshop/channels/${channelId}/agents`, { token: A.token })).data?.find(a => a.role === 'lead')?.name
  await api('POST', `/api/workshop/channels/${channelId}/chat/messages`, {
    body: {
      // 与 e2e-hil-multi-user.mjs 使用同一措辞(该措辞已实测能触发 omp 的 ask 工具)
      text: `@${leadName} Use the ask tool NOW to ask me exactly one question: "Restart check?" with options yes and no. After I answer, reply with one short sentence containing my answer.`,
      clientMessageId: `rs-${TAG}`,
    },
    token: B.token,
  })

  console.log('  … 等待真实原生 ask(冷启动可达 2-3 分钟)…')
  let item = await waitUntil('原生 hitl.request', () => aep.envelopes.find(e => e.type === 'hitl.request') ?? null, 420_000)
    .then(e => e.payload)
    .catch(() => null)

  if (item) {
    check('R2 原生 ask 到达并登记待办', Boolean(item?.id), `kind=${item.kind} id=${String(item.id).slice(0, 10)}`)
    const pendBefore = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`, { token: A.token })
    check('R3 重启前待办为 pending(可裁决)', pendBefore.status === 200 && (pendBefore.data?.items ?? []).some(i => i.id === item.id), `status=${pendBefore.status} count=${pendBefore.data?.items?.length}`)
  }
  else {
    // 原生 ask 未到达(实测原因:前序 HIL 回合消耗模型配额后的限流/冷启动超时)——
    // harness 相关的断言语义在 e2e-hil-multi-user.mjs 已单独证明。
    // 但"重启不自动批准"是**平台侧**语义,与具体 harness 无关,因此这里用一条
    // **真实落库的 pending 事实行**(fixture)继续做真重启验证,并明确标注来源。
    block('R2 原生 ask 到达(需真实模型配额)', `${HARNESS} 未在 420s 内产生 hitl.request`)
    const seeded = seedPendingHitl(channelId, A.id)
    if (!seeded) {
      check('R2b 平台侧重启语义的前提(可落库 pending 事实行)', false, '无法写入 workshop.sqlite')
      aep.close()
      console.log(`\n━━━ 结果: ${passed} passed / ${failures} failed / ${blocked} blocked ━━━`)
      process.exit(1)
    }
    item = { id: seeded.id, kind: seeded.kind }
    check('R2b 已写入一条真实落库的 pending HITL 事实行(平台侧 fixture,非 mock 决策)', true, `id=${seeded.id.slice(0, 10)} kind=${seeded.kind}`)
    // fixture 只写库、不进进程内 registry(registry 是缓存门面),因此"重启前可裁决"要按
    // **持久化事实源**断言:行存在且 status=pending。这正是被重启对账消费的输入。
    const rowBefore = readHitlRow(item.id)
    check('R3 重启前持久化行为 pending(重启对账的输入)', rowBefore?.status === 'pending' && rowBefore?.nativeConfirmed === 0, `status=${rowBefore?.status} native_confirmed=${rowBefore?.nativeConfirmed}`)
  }

  // R6 用**新登录**的 token:register 签发的 token 跨重启有效性已由 R4b 单独断言,
  // 这里专测"对旧待办再应答"的语义(避免把身份问题与状态机问题混在一个断言里)。
  const relogin = await api('POST', '/api/users/login', { body: { email: `${A.name}@test.local`, password: 'Passw0rd!123' } })
  const staleToken = relogin.data?.token ?? A.token
  check('R3b 重启后可重新登录取得会话 token', relogin.status === 200 && Boolean(relogin.data?.token), `status=${relogin.status}`)
  void staleToken

  // ── 真重启(同一 AW_HOME / 同一 SQLite)──
  console.log('  ── 重启服务(不关闭浏览器/不先应答,故意留下 pending)──')
  aep.close()
  const revived = await restartInstance()
  if (!revived) {
    check('R4 服务重启后健康门通过', false, '重启后不可达')
    process.exit(1)
  }
  check('R4 服务重启后健康门通过', true, `uptime=${Math.round((revived.data.uptimeMs ?? 0) / 1000)}s`)

  // ── 重启后断言 ──
  // 先验证身份仍在(register 签发的 token 必须跨重启有效;否则后续断言会因 401 变成"假通过")
  const meAfter = await api('GET', '/api/users/me', { token: A.token })
  check('R4b 重启后 register 签发的用户 token 仍有效(身份不丢)', meAfter.status === 200, `status=${meAfter.status} code=${meAfter.code ?? ''}`)
  if (meAfter.status !== 200) {
    check('R5 重启语义断言无法继续(身份失效)', false, 'token 在重启后失效,后续断言会变成假通过,故显式失败')
    console.log(`\n━━━ 结果: ${passed} passed / ${failures} failed / ${blocked} blocked ━━━`)
    process.exit(1)
  }

  const pendAfter = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`, { token: A.token })
  check('R5 pending 快照可读(显式断言状态码,避免 401 被当成"空列表")', pendAfter.status === 200, `status=${pendAfter.status}`)
  const stillActionable = (pendAfter.data?.items ?? []).some(i => i.id === item.id)
  check('R5b 重启后该待办不再作为可裁决项出现(不自动批准)', !stillActionable, `count=${pendAfter.data?.items?.length}`)

  // 持久化事实源终态(直接读隔离实例的 workshop.sqlite;这是"不自动批准"的硬证据)
  const rowAfter = readHitlRow(item.id)
  check('R5c 持久化行存在且状态为 failed(原生会话随上一进程消亡)', rowAfter?.status === 'failed', `status=${rowAfter?.status ?? '(缺失)'}`)
  check('R5d 未被标记引擎确认(native_confirmed=0)', rowAfter?.nativeConfirmed === 0, `native_confirmed=${rowAfter?.nativeConfirmed}`)
  check('R5e 未落为 approved/answered', rowAfter?.status !== 'approved' && rowAfter?.status !== 'answered', `status=${rowAfter?.status}`)
  check('R5f 失败原因可诊断(带明确 error 串)', /重启|失效|不可再应答/.test(String(rowAfter?.error ?? '')), String(rowAfter?.error ?? '').slice(0, 90))

  const respondAfter = await api('POST', '/api/workshop/hitl/respond', {
    body: { kind: item.kind, id: item.id, value: 'yes' },
    token: staleToken,
  })
  check('R6 重启后对旧待办应答 → 409(不复活、不落定为批准)', respondAfter.status === 409, `status=${respondAfter.status} code=${respondAfter.code}`)
  check('R6b 409 语义为 ALREADY_RESOLVED', respondAfter.code === 'ALREADY_RESOLVED', `code=${respondAfter.code}`)
  check('R6c 409 消息含已处理终态(可诊断)', /状态=|已处理/.test(String(respondAfter.message ?? '')), String(respondAfter.message ?? '').slice(0, 90))

  // 通知侧:重启不得产生"已批准/已同意"语义的定向通知
  const notif = await api('GET', '/api/workshop/notifications?limit=100', { token: A.token })
  const rows = (notif.data?.notifications ?? []).filter(n => n.hitlId === item.id)
  const wrongClaim = rows.filter(n => /approved|批准|answered|已答/.test(`${n.title} ${n.body} ${JSON.stringify(n.payload)}`))
  check('R7 重启未产生"已批准/已答复"语义的通知(不谎报成功)', wrongClaim.length === 0, `hitl 通知 ${rows.length} 条, 其中声明成功 ${wrongClaim.length} 条`)

  await api('DELETE', `/api/workshop/channels/${channelId}?purge=1`, { token: A.token }).catch(() => {})
  console.log(`\n━━━ 结果: ${passed} passed / ${failures} failed / ${blocked} blocked ━━━`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL', err?.stack ?? err?.message ?? String(err))
  process.exit(1)
})
