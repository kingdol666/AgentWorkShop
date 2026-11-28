/**
 * Curator LLM / embedding HTTP 契约回归（2026-11-28）：
 * 本机无真实模型 ≠ 该链路无验收 —— 用注入式 fetch 走完整请求构造/响应解析：
 *  - embedding：/embeddings 的 URL、模型名、Bearer、请求体形状正确；向量真实落 vec 表；
 *  - Curator LLM：/chat 请求带来源 digest 与 Bearer；合法 JSON 被采用为手册；
 *  - Curator LLM 返回垃圾 → 模板回退（llm_unavailable_or_invalid）。
 *
 * 为什么用 fetch 存根而不是进程内 http.Server：`--test-force-exit` 下同进程 server 的
 * 句柄关闭会与 libuv 异步关闭竞争（Windows 上 `UV_HANDLE_CLOSING` 断言让整个文件判死，
 * 子测试全过也白搭）。真实 TCP 往返由隔离实机验收覆盖（full-flow 的 F 段：真起 HTTP
 * 端点 → 配置 memory.embed_base_url → 检索 → 向量行增长），这里锁的是协议契约。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-memory-http-'))
delete process.env.AW_BENCH_MODE
process.env.AW_ALLOW_PRIVATE_OUTBOUND = '1'
process.env.AW_MEMORY_GRAPH_RETRIEVAL = '0'

const EMBED_DIMS = 8
interface Seen {
  url: string
  model: string
  auth: string
  body: Record<string, unknown>
}
const seen: Seen[] = []
const realFetch = globalThis.fetch

/** 契约级 fetch 存根：记录请求、按路径回 OpenAI 兼容响应 */
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
  const headers = new Headers(init?.headers)
  seen.push({ url, model: String(body.model ?? ''), auth: headers.get('authorization') ?? '', body })
  const json = (payload: unknown): Response => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  if (url.endsWith('/embeddings')) {
    const input_texts = Array.isArray(body.input) ? body.input as unknown[] : [String(body.input ?? '')]
    return json({
      data: input_texts.map((_, i) => ({
        embedding: Array.from({ length: EMBED_DIMS }, (_, j) => (((i + 1) * (j + 1)) % 7) / 7),
      })),
    })
  }
  if (url.endsWith('/chat-good')) {
    const user = JSON.stringify(body)
    const ids = [...new Set([...user.matchAll(/\[([a-z0-9][a-z0-9-:]{3,40})\]/g)].map(m => m[1]!))]
    const markdown = `# MOCK-HANDBOOK(HTTP 契约验收)\n\n${ids.map(id => `- 结论锚点 ${id}:来自 mock LLM 的汇整正文,足够长以通过 80 字门槛校验,并显式携带来源 id ${id}。`).join('\n')}\n`
    return json({ choices: [{ message: { content: JSON.stringify({ markdown }) } }] })
  }
  if (url.endsWith('/chat-bad')) {
    return json({ choices: [{ message: { content: '这不是 JSON,也不是 markdown 对象' } }] })
  }
  return new Response('not found', { status: 404 })
}) as typeof fetch

process.env.AW_MEMORY_EMBED_BASE_URL = 'https://embed.mock.local'
process.env.AW_MEMORY_EMBED_MODEL = 'mock-embed'
process.env.AW_MEMORY_EMBED_API_KEY = 'mock-embed-key'

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo, TEAM_AGENT_ID } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')
const { createEnvEmbeddingProvider } = await import('../server/services/workshop/runtime/embedding-provider')
const { invalidateRuntimeSettingsCache } = await import('../server/services/workshop/settings')
const { runCuratorForChannel } = await import('../server/services/workshop/memory/curator')
invalidateRuntimeSettingsCache()

const db = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, memory_access_mode, created_at, updated_at)
  VALUES ('c1', 'HTTP 验收频道', '', '', '', '{}', 1, 1, '', 'u1', 'inherit', ?, ?)`).run(now, now)

test('embedding provider 请求契约正确,向量真实落库', async () => {
  const provider = createEnvEmbeddingProvider()
  assert.ok(provider, 'env 已配置 → provider 非空')
  const [vec] = await provider!.embed(['冷却水流量的团队约定'])
  assert.ok(vec instanceof Float32Array, '返回 Float32Array')
  assert.equal(vec!.length, EMBED_DIMS, '维度以服务端实测为准')
  const call = seen.find(s => s.url.endsWith('/embeddings'))
  assert.ok(call, '发往 /embeddings')
  assert.equal(call!.url, 'https://embed.mock.local/embeddings', 'URL = baseUrl + /embeddings')
  assert.equal(call!.model, 'mock-embed', '请求带配置的模型名')
  assert.equal(call!.auth, 'Bearer mock-embed-key', '请求带 Bearer 鉴权头')
  assert.ok(Array.isArray(call!.body.input), 'input 为文本数组')
  const mem = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: null, embedder: provider })
  await mem.save({ title: '真实向量链路', content: '冷却水流量 32 L/min 的验收结论', scope: 'shared' })
  const vecRows = (db.prepare('SELECT COUNT(*) AS n FROM agent_memories_vec').get() as { n: number }).n
  assert.ok(vecRows > 0, `向量行必须 > 0,实际 ${vecRows}`)
})

test('Curator LLM 合法 JSON 手册被采用', async () => {
  for (const i of [1, 2, 3]) {
    repo.upsert({
      channelId: 'c1', agentId: TEAM_AGENT_ID, kind: 'semantic',
      title: `HTTP 验收结论 ${i}`, titleFts: `验 收 结 论 ${i}`,
      content: `冷却验收结论正文 ${i}`, importance: 0.8, taskId: null, sessionId: '', dedupKey: `http-src-${i}`,
    })
  }
  process.env.AW_MEMORY_CURATOR_LLM_URL = 'https://llm.mock.local/chat-good'
  process.env.AW_MEMORY_CURATOR_LLM_KEY = 'mock-llm-key'
  process.env.AW_MEMORY_CURATOR_LLM_MODEL = 'mock-llm'
  const run = await runCuratorForChannel(db, 'c1', { useLlm: true })
  assert.equal(run.status, 'ok', run.status)
  assert.equal(run.fallbackReason, '', `不得回退:${run.fallbackReason}`)
  assert.ok(run.markdown?.includes('MOCK-HANDBOOK'), '手册正文必须来自 LLM 响应')
  const call = seen.find(s => s.url.endsWith('/chat-good'))
  assert.ok(call, '发往 /chat-good')
  assert.equal(call!.model, 'mock-llm')
  assert.equal(call!.auth, 'Bearer mock-llm-key')
  const messages = call!.body.messages as Array<{ role: string, content: string }>
  assert.ok(messages.some(m => m.role === 'system' && m.content.includes('汇整')), '带 system 汇整指令')
  const userMsg = messages.find(m => m.role === 'user')
  assert.ok(userMsg, '带 user 消息')
  assert.ok((userMsg!.content.match(/- \[/g) ?? []).length >= 3, 'user 消息携带 ≥3 条来源 digest')
  const curated = db.prepare(`SELECT content FROM agent_memories WHERE dedup_key = 'curated:knowledge:c1'`).get() as { content: string } | undefined
  assert.ok(curated && curated.content.includes('MOCK-HANDBOOK'), 'curated 行正文是 LLM 手册')
})

test('Curator LLM 返回非法内容 → 模板回退且 run 台账记录 fallback', async () => {
  process.env.AW_MEMORY_CURATOR_LLM_URL = 'https://llm.mock.local/chat-bad'
  const run = await runCuratorForChannel(db, 'c1', { useLlm: true, force: true })
  assert.equal(run.status, 'ok')
  assert.equal(run.fallbackReason, 'llm_unavailable_or_invalid', '必须记录回退原因')
  assert.ok(run.markdown?.includes('# 频道知识手册'), '回退到模板手册')
  assert.ok(!run.markdown?.includes('MOCK-HANDBOOK'), '不得采用非法 LLM 输出')
})

after(() => {
  globalThis.fetch = realFetch
})
