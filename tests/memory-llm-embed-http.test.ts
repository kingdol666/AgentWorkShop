/**
 * Curator LLM / embedding 真实 HTTP 链路回归（2026-11-28 遗留项闭环）：
 * 本机无真实模型 ≠ 该链路无验收 —— 用本地 mock OpenAI 兼容端点走**真实 fetch**
 * （SSRF 护栏放行环回、鉴权头、请求体契约、响应解析、失败回退）：
 *  - embedding：/embeddings 请求模型/鉴权正确;向量真实落 agent_memories_vec;
 *  - Curator LLM：手册写作请求带来源 digest 与 Bearer;合法 JSON 被采用;
 *  - Curator LLM 返回垃圾 → 模板回退（llm_unavailable_or_invalid）。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-memory-http-'))
delete process.env.AW_BENCH_MODE
process.env.AW_ALLOW_PRIVATE_OUTBOUND = '1'
process.env.AW_MEMORY_GRAPH_RETRIEVAL = '0'

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo, TEAM_AGENT_ID } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')
const { createEnvEmbeddingProvider } = await import('../server/services/workshop/runtime/embedding-provider')
const { invalidateRuntimeSettingsCache } = await import('../server/services/workshop/settings')
const { runCuratorForChannel } = await import('../server/services/workshop/memory/curator')

interface Seen {
  path: string
  model: string
  auth: string
  body: Record<string, unknown>
}

const seen: Seen[] = []
const EMBED_DIMS = 8

/** mock OpenAI 兼容端点:/embeddings + /chat(从来源 digest 提取 id,写回带全部 id 的手册) */
function startMock(): Promise<{ server: Server, port: number }> {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => {
      raw += c.toString()
    })
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw || '{}') as Record<string, unknown>
      }
      catch { /* 垃圾请求体也记录 */ }
      seen.push({ path: req.url ?? '', model: String(body.model ?? ''), auth: String(req.headers.authorization ?? ''), body })
      if (req.url === '/embeddings') {
        const input = Array.isArray(body.input) ? body.input as unknown[] : [String(body.input ?? '')]
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          data: input.map((t, i) => ({ embedding: Array.from({ length: EMBED_DIMS }, (_, j) => (((i + 1) * (j + 1)) % 7) / 7) })),
        }))
        return
      }
      if (req.url === '/chat-good') {
        const user = JSON.stringify(body)
        const ids = [...new Set([...user.matchAll(/\[([a-z0-9][a-z0-9-:]{3,40})\]/g)].map(m => m[1]!))]
        const markdown = `# MOCK-HANDBOOK(真实 LLM 链路验收)\n\n${ids.map(id => `- 结论锚点 ${id}:来自 mock LLM 的汇整正文,足够长以通过 80 字门槛校验,并显式携带来源 id ${id}。`).join('\n')}\n`
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ markdown }) } }] }))
        return
      }
      if (req.url === '/chat-bad') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"choices":[{"message":{"content":"这不是 JSON,也不是 markdown 对象"}}]}')
        return
      }
      res.writeHead(404).end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, port: addr.port })
    })
  })
}

const { server, port } = await startMock()
const base = `http://127.0.0.1:${port}`

// 环境在 imports 完成后、首次 settings 读取前设置,并显式失效 TTL 缓存
process.env.AW_MEMORY_EMBED_BASE_URL = base
process.env.AW_MEMORY_EMBED_MODEL = 'mock-embed'
process.env.AW_MEMORY_EMBED_API_KEY = 'mock-embed-key'
invalidateRuntimeSettingsCache()

const db = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, memory_access_mode, created_at, updated_at)
  VALUES ('c1', 'HTTP 验收频道', '', '', '', '{}', 1, 1, '', 'u1', 'inherit', ?, ?)`).run(now, now)

test('embedding provider 走真实 HTTP:请求契约正确,向量真实落库', async () => {
  const provider = createEnvEmbeddingProvider()
  assert.ok(provider, 'env 已配置 → provider 非空')
  const [vec] = await provider!.embed(['冷却水流量的团队约定'])
  assert.ok(vec instanceof Float32Array, '返回 Float32Array')
  assert.equal(vec!.length, EMBED_DIMS, '维度以服务端实测为准')
  const call = seen.find(s => s.path === '/embeddings')
  assert.ok(call, 'mock 端点收到 /embeddings')
  assert.equal(call!.model, 'mock-embed', '请求带配置的模型名')
  assert.equal(call!.auth, 'Bearer mock-embed-key', '请求带 Bearer 鉴权头')
  // 经 AgentMemory.save → vectorizeMemory 真实写 vec 表
  const mem = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: null, embedder: provider })
  await mem.save({ title: '真实向量链路', content: '冷却水流量 32 L/min 的验收结论', scope: 'shared' })
  const vecRows = (db.prepare('SELECT COUNT(*) AS n FROM agent_memories_vec').get() as { n: number }).n
  assert.ok(vecRows > 0, `向量行必须 > 0,实际 ${vecRows}`)
})

test('Curator LLM 走真实 HTTP:合法 JSON 手册被采用', async () => {
  for (const i of [1, 2, 3]) {
    repo.upsert({
      channelId: 'c1', agentId: TEAM_AGENT_ID, kind: 'semantic',
      title: `HTTP 验收结论 ${i}`, titleFts: `验 收 结 论 ${i}`,
      content: `冷却验收结论正文 ${i}`, importance: 0.8, taskId: null, sessionId: '', dedupKey: `http-src-${i}`,
    })
  }
  process.env.AW_MEMORY_CURATOR_LLM_URL = `${base}/chat-good`
  process.env.AW_MEMORY_CURATOR_LLM_KEY = 'mock-llm-key'
  process.env.AW_MEMORY_CURATOR_LLM_MODEL = 'mock-llm'
  const run = await runCuratorForChannel(db, 'c1', { useLlm: true })
  assert.equal(run.status, 'ok', run.status)
  assert.equal(run.fallbackReason, '', `不得回退:${run.fallbackReason}`)
  assert.ok(run.markdown?.includes('MOCK-HANDBOOK'), '手册正文必须来自 mock LLM(真实往返)')
  const call = seen.find(s => s.path === '/chat-good')
  assert.ok(call, 'mock LLM 收到请求')
  assert.equal(call!.model, 'mock-llm')
  assert.equal(call!.auth, 'Bearer mock-llm-key')
  const messages = call!.body.messages as Array<{ role: string, content: string }>
  assert.ok(messages.some(m => m.role === 'system' && m.content.includes('汇整')), '带 system 汇整指令')
  const userMsg = messages.find(m => m.role === 'user')
  assert.ok(userMsg, '带 user 消息')
  assert.ok((userMsg!.content.match(/- \[/g) ?? []).length >= 3, 'user 消息携带 ≥3 条来源 digest')
  // 落库的 curated 行内容为 LLM 版本
  const curated = db.prepare(`SELECT content FROM agent_memories WHERE dedup_key = 'curated:knowledge:c1'`).get() as { content: string } | undefined
  assert.ok(curated && curated.content.includes('MOCK-HANDBOOK'), 'curated 行正文是 LLM 手册')
})

test('Curator LLM 返回非法内容 → 模板回退且 run 台账记录 fallback', async () => {
  process.env.AW_MEMORY_CURATOR_LLM_URL = `${base}/chat-bad`
  const run = await runCuratorForChannel(db, 'c1', { useLlm: true, force: true })
  assert.equal(run.status, 'ok')
  assert.equal(run.fallbackReason, 'llm_unavailable_or_invalid', '必须记录回退原因')
  assert.ok(run.markdown?.includes('# 频道知识手册'), '回退到模板手册')
  assert.ok(!run.markdown?.includes('MOCK-HANDBOOK'), '不得采用非法 LLM 输出')
})

// Windows libuv 退出竞态:mock server/keep-alive 连接必须在进程退出前显式收口,
// 否则 UV_HANDLE_CLOSING 断言让文件级判死(子测试全过也白搭,实测复现)。
after(() => {
  try {
    server.closeAllConnections?.()
    server.close()
  }
  catch { /* 已关闭则忽略 */ }
})
