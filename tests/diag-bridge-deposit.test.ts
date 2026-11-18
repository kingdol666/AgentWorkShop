/**
 * WS-3:diag_deposit 的入库模块(deposit.mjs)单测 ——
 *  - v1 完成结果 → 建文档 → index-document → tags → two-stage 自查命中
 *  - 同名幂等(不重复创建)
 *  - 报告正文为空 → 可读失败,不落半截文档(C3)
 *  - 可见性窗口:首轮未命中、次轮命中(≤3×5s 重试)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error 插件是纯 JS,无类型声明
import { depositRunToRag } from '../server/plugins-builtin/diag-bridge/host/deposit.mjs'

interface Call { method: string, url: string, body?: unknown }

function makeCtx({ report = '# 诊断报告\n\n主轴热漂移,SP 156→138。', existingDocs = [] as Array<Record<string, unknown>>, searchHits = 1, searchFailFirst = false } = {}) {
  const kv = new Map<string, unknown>([['diag.base_url', 'http://127.0.0.1:3210']])
  const calls: Call[] = []
  const docs = [...existingDocs]
  let searchCount = 0
  const config: Record<string, unknown> = {
    'plugins.rag-bridge.web_url': 'http://127.0.0.1:6789',
    'plugins.rag-bridge.base_url': 'http://127.0.0.1:8770',
    'plugins.rag-bridge.token': 'sk-test',
    'plugins.rag-bridge.docs_kb': 'aw-docs',
  }
  const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body })
  const ctx = {
    config: { get: (k: string) => config[k] },
    kv: { get: (k: string) => kv.get(k), set: (k: string, v: unknown) => kv.set(k, v), all: () => Object.fromEntries(kv.entries()) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    timer: { setTimeout: (fn: () => void) => setTimeout(fn, 0) },
    http: {
      get: async (url: string) => {
        calls.push({ method: 'GET', url })
        if (url.includes('/api/external/v1/tasks/') && url.endsWith('/result')) {
          return json({ success: true, data: { task_id: 'T1', run_id: 'run-1', status: 'completed', result: { score: 0, verdict: 'alert', summary: '82 alerts', report_md: report, files: { report_md_path: 'C:/ws/report.md' } } } })
        }
        if (url.includes('/api/kb/catalog')) return json({ success: true, knowledgeBases: [{ kbId: 'kb-docs', name: 'aw-docs', path: 'aw-docs' }] })
        if (url.includes('/api/kb/documents?')) return json({ success: true, documents: docs })
        if (url.includes('/api/kb/search?')) return json({ success: true, hits: [{ path: 'aw-docs\\ln-1_quick-screen_run-1.md', docName: 'ln-1_quick-screen_run-1.md', description: 'diag', score: 10, kbName: 'aw-docs' }] })
        return json({ success: true, data: {} })
      },
      post: async (url: string, body: unknown) => {
        calls.push({ method: 'POST', url, body })
        if (url.includes('/api/kb/documents/create')) {
          const b = body as { name: string, content: string }
          const doc = { id: 'doc-1', name: b.name, path: `aw-docs\\${b.name}` }
          docs.push(doc)
          return json({ success: true, document: doc })
        }
        if (url.includes('/api/v1/search/index-document')) return json({ success: true })
        if (url.includes('/api/search/two-stage')) {
          searchCount++
          if (searchFailFirst && searchCount === 1) return json({ success: false, error: 'vector warming' }, 503)
          return json({ success: true, stage2: { results: Array.from({ length: searchHits }, (_, i) => ({ doc_path: i === 0 ? 'aw-docs/ln-1_quick-screen_run-1.md' : `aw-docs/other-${i}.md`, score: 0.9 - i * 0.1, content: 'x' })) }, total_results: searchHits })
        }
        return json({ success: true, data: {} })
      },
      patch: async (url: string, body: unknown) => {
        calls.push({ method: 'PATCH', url, body })
        return json({ success: true })
      },
    },
  }
  return { ctx, calls, docs }
}

const meta = { line: 'ln-1', intent: 'quick-screen', contract: 'v1', taskId: 'T1', runId: 'run-1' }

test('v1 完成 → 建文档/index/tags/两段自查命中;首行所需字段齐备', async () => {
  const h = makeCtx()
  const r = await depositRunToRag(h.ctx, { runId: 'run-1', meta })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.docPath, 'aw-docs/ln-1_quick-screen_run-1.md')
  assert.equal(r.kbName, 'aw-docs')
  assert.equal(r.verified, true)
  assert.equal(r.searchMode, 'two-stage')
  assert.equal(r.hits, 1)
  assert.ok(h.calls.some(c => c.url.includes('/api/kb/documents/create')))
  assert.ok(h.calls.some(c => c.url.includes('/api/v1/search/index-document')))
  assert.ok(h.calls.some(c => c.method === 'PATCH' && c.url.includes('/api/kb/documents/tags')))
  const tagBody = h.calls.find(c => c.method === 'PATCH')!.body as { tags: string[] }
  assert.deepEqual(tagBody.tags.slice(0, 2), ['diag', 'quick-screen'])
})

test('同名文档已存在 → 幂等不重复创建,仍建索引与自查', async () => {
  const h = makeCtx({ existingDocs: [{ id: 'doc-ex', name: 'ln-1_quick-screen_run-1.md', path: 'aw-docs\\ln-1_quick-screen_run-1.md' }] })
  const r = await depositRunToRag(h.ctx, { runId: 'run-1', meta })
  assert.equal(r.ok, true, r.error)
  assert.equal(h.docs.length, 1, '不得产生副本')
  assert.ok(!h.calls.some(c => c.url.includes('/api/kb/documents/create')), '不应再 POST create')
  const idx = h.calls.find(c => c.url.includes('/api/v1/search/index-document'))!
  assert.equal((idx.body as { doc_id: string }).doc_id, 'doc-ex')
})

test('报告正文为空 → 可读失败,不创建文档(C3 负路径)', async () => {
  const h = makeCtx({ report: '' })
  const r = await depositRunToRag(h.ctx, { runId: 'run-1', meta })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /报告正文为空/)
  assert.ok(!h.calls.some(c => c.url.includes('/api/kb/documents/create')), '不得落半截文档')
})

test('可见性窗口:两段检索暂不可用 → 关键词兜底并如实标注 degraded', async () => {
  const h = makeCtx({ searchFailFirst: true })
  const r = await depositRunToRag(h.ctx, { runId: 'run-1', meta })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.searchMode, 'keyword-degraded')
  // 关键词兜底(跨库)命中的 path 是反斜杠形式,仍应识别为已入库
  assert.equal(r.verified, true)
})

test('legacy 契约:workspace 目录名与 scene(-/_)不一致时仍能取到 report.md', async () => {
  const h = makeCtx({ report: '' })
  const baseGet = h.ctx.http.get
  h.ctx.http.get = async (url: string) => {
    if (url.includes('/api/diagnosis/tasks/run-old')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            name: 'accept-scene_run-old',
            status: 'completed',
            result: { score: 90, verdict: 'OK', report_md_path: 'D:/ws/1795000000000_accept_scene/report.md' },
          },
        }),
      }
    }
    if (url.endsWith('/api/files/workspace')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: [{ name: '1795000000000_accept_scene', hasReport: true }] }) }
    }
    if (url.includes('/api/files/workspace/report/1795000000000_accept_scene')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { content: '# legacy report\n\n主轴温度 155.9 高于目标窗' } }) }
    }
    return baseGet(url)
  }
  const r = await depositRunToRag(h.ctx, {
    runId: 'run-old',
    meta: { line: 'ln-1', intent: 'quick-screen', contract: 'legacy', scene: 'accept-scene', runId: 'run-old' },
  })
  assert.equal(r.ok, true, r.error)
  assert.match(String(r.docPath), /aw-docs\/ln-1_quick-screen_run-old\.md/)
  assert.ok(h.calls.some(c => c.url.includes('/api/kb/documents/create')))
})
