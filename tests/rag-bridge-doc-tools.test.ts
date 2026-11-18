/**
 * rag-bridge v2.3 文档工具族(WS-1 / 验收 A/F 的单元面):
 *   - kb_doc_create:同名幂等(服务端重名自动改名而非 409)、reindex、漂移警告
 *   - kb_doc_search:two-stage 主路径 + 关键词兜底降级标注
 *   - kb_doc_read:doc_path 前缀归属解析、截断标记
 *   - kb_catalog:目录列举
 *   - kb_agent:有界 prompt(只读追加执行约束 / ingest 不改写)、429 退避语义(读超时下限 750s)
 *   - health:token 三态(verify)与工具计数
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error 插件是纯 JS,无类型声明
import plugin from '../server/plugins-builtin/rag-bridge/index.mjs'

interface Tool {
  name?: string
  roles?: string[]
  riskClass?: string
  parameters?: { properties?: Record<unknown, unknown> }
  handler: (args: Record<string, unknown>, agent?: Record<string, unknown>) => Promise<{ text: string, isError?: boolean }>
}

interface HarnessOpts {
  /** 是否已有 aw-docs 库 */
  docsKb?: boolean
  /** documents/create 响应覆盖(默认成功) */
  createResult?: Record<string, unknown>
  createStatus?: number
  twoStageFail?: boolean
  verifyBody?: Record<string, unknown>
}

function makeHarness(opts: HarnessOpts = {}) {
  const kv = new Map<string, unknown>()
  const tools = new Map<string, Tool>()
  const routes = new Map<string, (event?: unknown) => Promise<unknown>>()
  const calls: Array<{ method: string, url: string, body?: unknown, timeoutMs?: number }> = []
  const docs: Array<Record<string, unknown>> = []
  const kb = [
    { kbId: 'kb-exp', name: 'aw-industrial', path: 'aw-industrial', documentCount: 3, parentId: null },
    ...(opts.docsKb === false ? [] : [{ kbId: 'kb-docs', name: 'aw-docs', path: 'aw-docs', documentCount: docs.length, parentId: null }]),
  ]
  const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body })
  const created: Array<Record<string, unknown>> = []

  const ctx = {
    config: {
      get: () => undefined,
      onChange: () => {},
      defineGroup: () => {},
      defineField: () => {},
    },
    kv: {
      get: (k: string) => kv.get(k),
      set: (k: string, v: unknown) => { kv.set(k, v) },
      all: () => Object.fromEntries(kv.entries()),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    omp: { registerTool: (t: Tool) => { if (t.name) tools.set(t.name, t) } },
    route: (method: string, path: string, fn: (event?: unknown) => Promise<unknown>) => { routes.set(`${method} ${path}`, fn) },
    timer: {
      setInterval: () => 1,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    },
    http: {
      get: async (url: string, o?: { timeoutMs?: number }) => {
        calls.push({ method: 'GET', url, timeoutMs: o?.timeoutMs })
        if (url.includes('/api/kb/catalog')) return json({ success: true, count: kb.length, knowledgeBases: kb })
        if (url.includes('/api/kb/documents?')) {
          return json({ success: true, kbId: 'kb-docs', count: docs.length, documents: docs })
        }
        if (url.includes('/api/kb/document?')) {
          const u = new URL(url)
          const docPath = String(u.searchParams.get('docPath') ?? '')
          return json({ success: true, path: docPath, content: 'CNC-850 主轴热漂移治理:受治小步探索闭环(正文样例)', totalLines: 3, truncated: u.searchParams.has('max_chars') })
        }
        if (url.includes('/api/kb/search?')) return json({ success: true, query: 'q', count: 1, hits: [{ path: 'aw-docs/CNC-850 样例.md', docName: 'CNC-850 样例.md', description: '热漂移治理', score: 10, kbName: 'aw-docs' }] })
        if (url.includes('/api/v1/health')) return json({ status: 'healthy' })
        if (url.includes('/api/v1/auth/me')) return json({ success: true, auth_type: 'api_token' })
        return json({ success: true })
      },
      post: async (url: string, body: unknown, o?: { timeoutMs?: number }) => {
        calls.push({ method: 'POST', url, body, timeoutMs: o?.timeoutMs })
        if (url.includes('/api/search/two-stage')) {
          if (opts.twoStageFail) return json({ success: false, error: 'vector down' }, 503)
          return json({
            success: true,
            query: (body as { query?: string })?.query,
            total_results: 1,
            stage2: { results: [{ doc_path: 'aw-docs/CNC-850 样例.md', score: 0.91, chunk_index: 2, content: '主轴热漂移:SP/PV 闭环治理,四步 HITL。' }] },
          })
        }
        if (url.includes('/api/kb/documents/create')) {
          if (opts.createStatus && opts.createStatus >= 400) return json({ success: false, error: opts.createResult }, opts.createStatus)
          if (opts.createResult) return json(opts.createResult)
          const b = body as { name?: string, content?: string }
          const doc = { id: 'doc-1', name: b.name, path: `aw-docs\\${b.name}`, file_size: String(b.content ?? '').length }
          docs.push(doc)
          created.push(doc)
          return json({ success: true, source_chars: String(b.content ?? '').length, document: doc })
        }
        if (url.includes('/api/search/reindex')) return json({ success: true })
        if (url.includes('/api/kb/create')) return json({ success: true, knowledgeBase: { id: 'kb-new', name: 'aw-docs' } })
        if (url.includes('/api/auth/verify')) return json(opts.verifyBody ?? { valid: true })
        if (url.includes('/api/kb/agent/chat')) {
          return json({ success: true, reply: '同步答复', mode: (body as { mode?: string })?.mode })
        }
        return json({ success: true })
      },
      patch: async (url: string, body: unknown, o?: { timeoutMs?: number }) => {
        calls.push({ method: 'PATCH', url, body, timeoutMs: o?.timeoutMs })
        return json({ success: true })
      },
    },
    services: { get: async () => null },
  }
  return { ctx, tools, routes, calls, docs, created, kv }
}

test('WS-0 工具声明:文档工具 roles/riskClass/schema 完整', async () => {
  const h = makeHarness()
  await plugin.setup(h.ctx)
  const expect: Record<string, { role: string, risk: string }> = {
    kb_doc_create: { role: 'write', risk: 'write' },
    kb_doc_search: { role: 'read', risk: 'read' },
    kb_doc_read: { role: 'read', risk: 'read' },
    kb_catalog: { role: 'read', risk: 'read' },
  }
  for (const [name, meta] of Object.entries(expect)) {
    const t = h.tools.get(name)
    assert.ok(t, `${name} 应注册`)
    assert.deepEqual(t!.roles, ['lead', 'worker'], `${name} 必须显式声明 roles`)
    assert.equal(t!.riskClass, meta.risk, `${name} riskClass 应为 ${meta.risk}`)
    assert.ok(t!.parameters?.properties, `${name} 必须有参数 schema`)
  }
})

test('kb_doc_create:创建 → reindex → 首行 doc_path;二次调用同名幂等不重复创建', async () => {
  const h = makeHarness()
  await plugin.setup(h.ctx)
  const create = h.tools.get('kb_doc_create')!
  const r1 = await create.handler({ name: 'CNC-850 样例', content: 'CNC-850 主轴热漂移治理正文', description: '样例', tags: ['diag', 'cnc850'] }, { agentId: 'ag-1', role: 'lead' })
  assert.ok(!r1.isError, r1.text)
  assert.match(r1.text.split('\n')[0]!, /^status=created doc_path=aw-docs\/CNC-850 样例\.md kb=aw-docs chars=\d+ index=ok tags=ok/)
  assert.equal(h.created.length, 1)
  assert.ok(h.calls.some(c => c.method === 'POST' && c.url.includes('/api/v1/search/index-document')), '必须单文档建索引(含 BM25 增量)')
  assert.ok(h.calls.some(c => c.method === 'PATCH' && c.url.includes('/api/kb/documents/tags')), 'tags 应写回')

  const r2 = await create.handler({ name: 'CNC-850 样例', content: '内容变了也不重复建' }, { agentId: 'ag-1', role: 'lead' })
  assert.match(r2.text.split('\n')[0]!, /^status=exists doc_path=aw-docs\/CNC-850 样例\.md/)
  assert.match(r2.text, /idempotent=yes/)
  assert.equal(h.created.length, 1, '同名文档必须幂等,不得产生副本')
})

test('kb_doc_create:显式写经验库 aw-industrial → 输出漂移警告但不硬拦', async () => {
  const h = makeHarness()
  await plugin.setup(h.ctx)
  const r = await h.tools.get('kb_doc_create')!.handler({ name: '漂移样例', content: '正文', kb: 'aw-industrial' })
  assert.ok(!r.isError)
  assert.match(r.text, /目标库是经验库 aw-industrial/)
  assert.match(r.text.split('\n')[0]!, /kb=aw-industrial/)
})

test('kb_doc_create:同名竞态 409 → 回查既有文档按幂等成功', async () => {
  const h = makeHarness({ createStatus: 409, createResult: 'duplicate' })
  await plugin.setup(h.ctx)
  // 预查时列表为空(模拟 TOCTOU),但 409 后回查能看到文档
  let listed = 0
  const origGet = h.ctx.http.get
  h.ctx.http.get = async (url: string, o?: { timeoutMs?: number }) => {
    if (url.includes('/api/kb/documents?')) {
      listed++
      if (listed > 1) return { ok: true, status: 200, json: async () => ({ success: true, documents: [{ id: 'd', name: 'race.md', path: 'aw-docs\\race.md' }] }) }
    }
    return origGet(url, o)
  }
  h.ctx.kv.all = () => Object.fromEntries(new Map())
  const r = await h.tools.get('kb_doc_create')!.handler({ name: 'race', content: '正文' })
  assert.match(r.text.split('\n')[0]!, /^status=exists doc_path=aw-docs\/race\.md/)
  assert.match(r.text, /幂等/)
})

test('kb_doc_search:two-stage 主路径解析 stage2.results', async () => {
  const h = makeHarness()
  await plugin.setup(h.ctx)
  const r = await h.tools.get('kb_doc_search')!.handler({ query: '主轴 热漂移 冷却', kb: 'aw-docs' })
  assert.ok(!r.isError, r.text)
  const first = r.text.split('\n')[0]!
  assert.match(first, /^status=ok mode=two-stage hits=1 kb=aw-docs total=1/)
  assert.match(r.text, /doc_path=aw-docs\/CNC-850 样例\.md score=0\.9100 chunk=2/)
  assert.match(r.text, /主轴热漂移/)
})

test('kb_doc_search:two-stage 失败 → 关键词兜底并如实标注 degraded', async () => {
  const h = makeHarness({ twoStageFail: true })
  await plugin.setup(h.ctx)
  const r = await h.tools.get('kb_doc_search')!.handler({ query: '热漂移' })
  assert.ok(!r.isError, r.text)
  assert.match(r.text.split('\n')[0]!, /^status=ok mode=keyword-degraded hits=1/)
  assert.match(r.text, /仅名称\/描述匹配/)
})

test('kb_doc_read:doc_path 前缀库名自动归属 + 截断标记', async () => {
  const h = makeHarness()
  await plugin.setup(h.ctx)
  const r = await h.tools.get('kb_doc_read')!.handler({ doc_path: 'aw-docs/CNC-850 样例.md', max_chars: 10 })
  assert.ok(!r.isError, r.text)
  assert.match(r.text.split('\n')[0]!, /^status=ok doc_path=aw-docs\/CNC-850 样例\.md kb=aw-docs chars=\d+ total_lines=3 truncated=yes/)
  assert.match(r.text, /CNC-850 主轴热漂移治理/)
  const readCall = h.calls.find(c => c.url.includes('/api/kb/document?'))!
  assert.match(readCall.url, /kbId=kb-docs/, '应解析到 aw-docs 的 kbId 而非经验库')
})

test('kb_catalog:列库与文档数', async () => {
  const h = makeHarness()
  await plugin.setup(h.ctx)
  const r = await h.tools.get('kb_catalog')!.handler({})
  assert.ok(!r.isError, r.text)
  assert.match(r.text.split('\n')[0]!, /^status=ok kbs=2 shown=2 docs_kb=aw-docs/)
  assert.match(r.text, /aw-industrial \| kb-exp \| docs=3/)
  assert.match(r.text, /aw-docs \| kb-docs \| docs=0/)
})

test('kb_agent:只读 prompt 追加有界执行约束;ingest 不改写正文;sync 读超时 ≥750s', async () => {
  const h = makeHarness()
  await plugin.setup(h.ctx)
  const agent = h.tools.get('kb_agent')!
  const q = await agent.handler({ prompt: '查一下 CNC-850 热漂移治理经验', action: 'query' })
  assert.ok(!q.isError, q.text)
  const chatCall = h.calls.filter(c => c.method === 'POST' && c.url.includes('/api/kb/agent/chat')).at(-1)!
  const qbody = chatCall.body as { prompt: string }
  assert.match(qbody.prompt, /执行约束\(平台侧追加\)/)
  assert.match(qbody.prompt, /doc_path 出处/)
  assert.ok((chatCall.timeoutMs ?? 0) >= 750_000, `sync 读超时须≥750s,实际 ${chatCall.timeoutMs}`)

  const ing = await agent.handler({ prompt: '把《测试》正文入库:hello', action: 'ingest' })
  assert.ok(!ing.isError, ing.text)
  const ibody = h.calls.filter(c => c.method === 'POST' && c.url.includes('/api/kb/agent/chat')).at(-1)!.body as { prompt: string }
  assert.equal(ibody.prompt, '把《测试》正文入库:hello', 'ingest 不得改写业务正文')
})

test('health:token verify 三态(有效)与工具计数暴露', async () => {
  const h = makeHarness({ verifyBody: { valid: true } })
  await plugin.setup(h.ctx)
  await h.tools.get('kb_catalog')!.handler({})
  const health = await h.routes.get('GET /health')!()
  const hh = health as { token: { configured: boolean, accepted: boolean | null, verify: string }, toolCounters: Record<string, { ok: number, err: number }>, docs: { name: string } }
  assert.equal(hh.token.verify, 'anonymous', '未配 token 时按匿名(configured=false)')
  assert.ok(hh.toolCounters.kb_catalog.ok >= 1, '工具调用计数应可见')
  assert.equal(hh.docs.name, 'aw-docs')
})
