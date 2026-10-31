#!/usr/bin/env node
/**
 * RAG 对外 API 独立真机测试(2026-10-29 ralph 验收 US-003)。
 * 覆盖:健康/注册/登录/token 铸造/me+verify/负例/web 层 KB 目录/建库建文档/索引/向量检索命中/web 检索/kb agent chat(rag-bridge 消费面)。
 * 前置:RAG 后端 8771 + web 6789 已启动。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BE = 'http://127.0.0.1:8771'
const WEB = 'http://127.0.0.1:6789'
const HERE = dirname(fileURLToPath(import.meta.url))
const EVID = join(HERE, '..')
mkdirSync(EVID, { recursive: true })
process.env.NO_PROXY = '127.0.0.1,localhost'

const results = []
function check(id, name, ok, detail = '') {
  results.push({ id, name, pass: Boolean(ok), detail: String(detail).slice(0, 400) })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${ok ? '' : ' — ' + String(detail).slice(0, 300)}`)
}
const api = async (base, method, path, body, token) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) })
  return { status: r.status, j: await r.json().catch(() => ({})) }
}
const stamp = 'ralph20261029'
const USER = `ralph_acc_${stamp}`
const MARK = `RALPH-ACC-MARKER-7F3Q-${stamp}`

// R1 健康
const h = await api(BE, 'GET', '/health')
check('R1', 'RAG 后端 /health 200', h.status === 200, `status=${h.status}`)

// R2 注册(已存在则转登录)
const reg = await api(BE, 'POST', '/api/v1/auth/register', { username: USER, password: 'Ralph#20261029', email: `${USER}@test.local` })
check('R2', 'register 新用户(或已存在)', reg.status === 200 || /already|exist|已存在/i.test(JSON.stringify(reg.j)), `status=${reg.status} body=${JSON.stringify(reg.j).slice(0, 160)}`)

// R3 登录 → 会话 token(1 天)
const login = await api(BE, 'POST', '/api/v1/auth/login', { username: USER, password: 'Ralph#20261029' })
const session = login.j?.token ?? null
check('R3', 'login 返回会话 token', login.status === 200 && Boolean(session), `status=${login.status} body=${JSON.stringify(login.j).slice(0, 160)}`)

// R4 铸造 30 天 API token(明文一次)
const mk = await api(BE, 'POST', '/api/v1/auth/tokens', { name: 'ralph-acceptance', ttl_days: 30, scopes: ['read', 'write'] }, session)
const ragToken = mk.j?.token ?? null
check('R4', 'tokens 铸造长期 API token', mk.status === 200 && typeof ragToken === 'string' && ragToken.length > 10, `status=${mk.status} body=${JSON.stringify(mk.j).slice(0, 160)}`)
if (ragToken) writeFileSync('D:/tmp/rag-token-ralph-20261029.txt', ragToken)

// R5 me(鉴权)
const me = await api(BE, 'GET', '/api/v1/auth/me', undefined, ragToken ?? session)
check('R5', '/auth/me 返回当前身份', me.status === 200 && me.j?.user?.username === USER, `status=${me.status} body=${JSON.stringify(me.j).slice(0, 160)}`)

// R6 负例:坏 token → 401
const bad = await api(BE, 'GET', '/api/v1/auth/me', undefined, 'sk_bogus_token')
check('R6', '坏 token /auth/me → 401', bad.status === 401, `status=${bad.status}`)

// R7 verify 端点
const ver = await api(BE, 'POST', '/api/v1/auth/verify', { token: ragToken ?? session })
check('R7', '/auth/verify valid=true', ver.status === 200 && ver.j?.valid === true, `status=${ver.status} body=${JSON.stringify(ver.j).slice(0, 120)}`)

// R8 token 列表(脱敏)
const tl = await api(BE, 'GET', '/api/v1/auth/tokens', undefined, ragToken ?? session)
check('R8', '/auth/tokens 列表≥1 且无明文', tl.status === 200 && Array.isArray(tl.j?.tokens) && tl.j.tokens.length >= 1 && !JSON.stringify(tl.j.tokens).includes(ragToken ?? '\u0000'), `status=${tl.status} n=${tl.j?.tokens?.length}`)

// R9 web 层 KB 目录(全局 Bearer 中间件,带 token)
const webToken = ragToken ?? session
const cat = await api(WEB, 'GET', '/api/kb/catalog', undefined, webToken)
const kbs = cat.j?.knowledgeBases ?? []
check('R9', 'web /api/kb/catalog 200', cat.status === 200 && Array.isArray(kbs), `status=${cat.status} n=${kbs.length}`)

// R10 建库(已存在则复用)
let kbId = kbs.find(k => /ralph-acc/i.test(k.name || ''))?.kbId ?? null
if (!kbId) {
  const cr = await api(WEB, 'POST', '/api/kb/create', { name: `ralph-acc-kb-${stamp}`, description: 'ralph 验收临时库' }, webToken)
  kbId = cr.j?.knowledgeBase?.kbId ?? cr.j?.knowledgeBase?.id ?? null
  check('R10a', 'web /api/kb/create 建库', cr.status === 200 && Boolean(kbId), `status=${cr.status} body=${JSON.stringify(cr.j).slice(0, 200)}`)
} else check('R10a', '复用既有 ralph-acc 库', true, kbId)

// R11 建文档(含唯一标记)
const docContent = `# Ralph 验收夹具\n\n标记 ${MARK}。\n注塑工艺参数窗口:料温 240-260℃,注射压力 45-65bar。\n本文件由 2026-10-29 ralph 全量验收写入,用于 ingest→search 命中闭环。`
const doc = await api(WEB, 'POST', '/api/kb/documents/create', { kbId, name: 'ralph-acceptance-fixture.md', content: docContent }, webToken)
const docPath = doc.j?.document?.path ?? doc.j?.document?.docPath ?? doc.j?.path ?? `${kbId}/ralph-acceptance-fixture.md`
check('R11', 'web /api/kb/documents/create 建文档', doc.status === 200, `status=${doc.status} docPath=${String(docPath).slice(0, 120)}`)

// R12 后端索引(向量+图谱)
const idx = await api(BE, 'POST', '/api/v1/search/index-document', { kb_id: kbId, doc_path: docPath, content: docContent }, ragToken ?? session)
check('R12', '后端 index-document 索引成功', idx.status === 200 && idx.j?.success !== false, `status=${idx.status} body=${JSON.stringify(idx.j).slice(0, 200)}`)

// R13 向量检索命中标记
await new Promise(r => setTimeout(r, 1500))
const vs = await api(BE, 'POST', '/api/v1/search/vector', { query: MARK, top_k: 5 }, ragToken ?? session)
const vsBody = JSON.stringify(vs.j)
check('R13', '向量检索命中 ingest 标记', vs.status === 200 && vsBody.includes(MARK), `status=${vs.status} count=${vs.j?.count} body=${vsBody.slice(0, 200)}`)

// R14 web 检索命中
const ws = await api(WEB, 'GET', `/api/kb/search?query=${encodeURIComponent(MARK)}&top_k=5`, undefined, webToken)
check('R14', 'web /api/kb/search 命中', ws.status === 200 && JSON.stringify(ws.j).includes(MARK), `status=${ws.status} count=${ws.j?.count}`)

// R15 kb/agent/chat —— rag-bridge 的唯一对外消费面(async 提交+轮询任务面)
let acText = ''
let acOk = false
try {
  const sub = await api(WEB, 'POST', '/api/kb/agent/chat', { prompt: `只回答文档路径:检索标记 ${MARK} 在哪个文档?`, mode: 'async' }, webToken)
  const taskId = sub.j?.task_id
  if (sub.status === 200 && taskId) {
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 10000))
      const t = await api(WEB, 'GET', `/api/kb/agent/tasks/${encodeURIComponent(taskId)}`, undefined, webToken)
      acText = JSON.stringify(t.j).slice(0, 400)
      if (t.j?.status === 'completed' || t.j?.status === 'success' || (t.j?.success === true && t.j?.status !== 'running')) { acOk = true; break }
      if (t.j?.status === 'failed' || t.j?.status === 'error') break
    }
  } else acText = `submit status=${sub.status} ${JSON.stringify(sub.j).slice(0, 240)}`
} catch (e) { acText = String(e?.message ?? e) }
check('R15', acOk ? 'kb/agent/chat 异步回合完成(rag-bridge 消费面)' : 'kb/agent/chat 未在超时窗完成(如实记录)', acOk, acText)

const pass = results.filter(r => r.pass).length
console.log(`\n结论: ${pass === results.length ? 'PASS' : 'FAIL'} (${pass}/${results.length})`)
writeFileSync(join(EVID, 'rag-api-direct-report.json'), JSON.stringify({ suite: 'rag-api-direct', base: BE, web: WEB, at: new Date().toISOString(), results }, null, 2))
process.exitCode = pass === results.length ? 0 : 1
