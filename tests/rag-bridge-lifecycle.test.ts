/**
 * rag-bridge 异步任务生命周期(2026-10-18):
 *   - kb_agent mode=async 即返 task_id,并把任务与发起者归因落 kv
 *   - 后台轮询终态 → 平台回执(Agent 不主动轮询也能拿到结果)
 *   - kb_agent_status 支持进度查询与 wait_seconds 长轮询,看到终态后 claim 回执
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error 插件是纯 JS,无类型声明
import plugin from '../server/plugins-builtin/rag-bridge/index.mjs'

interface Tool { handler: (args: Record<string, unknown>, agent?: Record<string, unknown>) => Promise<{ text: string, isError?: boolean }> }

function makeHarness() {
  const kv = new Map<string, unknown>()
  const tools = new Map<string, Tool>()
  const notices: Array<Record<string, unknown>> = []
  const claims: string[] = []
  let intervalCb: (() => Promise<void>) | null = null
  let taskStatus = 'running'
  let taskReply = ''
  const requests: string[] = []

  const json = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
  })

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
    omp: { registerTool: (t: { name: string } & Tool) => tools.set(t.name, t) },
    route: () => {},
    timer: {
      setInterval: (fn: () => Promise<void>) => {
        intervalCb = fn
        return 1
      },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    },
    http: {
      get: async (url: string) => {
        requests.push('GET ' + url)
        if (url.includes('/api/kb/catalog')) return json({ success: true, knowledgeBases: [{ kbId: 'kb-1', name: 'aw-industrial' }] })
        if (url.includes('/api/kb/agent/tasks/')) {
          return json({ success: true, status: taskStatus, result: taskStatus === 'completed' ? { reply: taskReply } : null })
        }
        return json({ success: true })
      },
      post: async (url: string, body: unknown) => {
        requests.push('POST ' + url)
        if (url.includes('/api/kb/agent/chat')) {
          const mode = (body as { mode?: string })?.mode
          if (mode === 'async') return json({ success: true, mode: 'async', task_id: 't1', status: 'running' })
          return json({ success: true, reply: '同步答复' })
        }
        if (url.includes('/api/kb/create')) return json({ success: true, knowledgeBase: { id: 'kb-1' } })
        return json({ success: true })
      },
    },
    services: {
      get: async () => ({
        deliver: async (n: Record<string, unknown>) => {
          notices.push(n)
          return true
        },
        claim: (tool: string, id: string) => {
          claims.push(`${tool}:${id}`)
        },
      }),
    },
  }

  return {
    ctx,
    tools,
    notices,
    claims,
    requests,
    setTask: (status: string, reply = '') => {
      taskStatus = status
      taskReply = reply
    },
    // 插件定时器回调本身不返回 Promise(内部 .catch),这里触发后留出异步收口时间
    runPoller: async () => {
      if (intervalCb) intervalCb()
      await new Promise(r => setTimeout(r, 50))
    },
  }
}

test('kb_agent async → 后台轮询回执 → kb_agent_status 可取结果并 claim', async () => {
  const h = makeHarness()
  await plugin.setup(h.ctx)
  const kbAgent = h.tools.get('kb_agent')
  const kbStatus = h.tools.get('kb_agent_status')
  assert.ok(kbAgent && kbStatus, '两个工具都应注册')

  const submitted = await kbAgent!.handler({ prompt: '把报告入库', mode: 'async' }, { agentId: 'ag-1', channelId: 'ch-1', role: 'worker', name: 'w' })
  assert.match(submitted.text, /task_id=t1/)
  const stored = h.ctx.kv.get('kbtask:t1') as Record<string, unknown>
  assert.equal(stored.agentId, 'ag-1')
  assert.equal(stored.channelId, 'ch-1')

  // running 状态:进度查询如实返回
  const running = await kbStatus!.handler({ task_id: 't1' })
  assert.match(running.text, /仍在后台执行中/)

  // 轮询器看到终态 → 主动回执(等 setup 的首次空轮询收口)
  h.setTask('completed', 'doc_path=kb/docs/r1.md;分块数=7')
  await new Promise(r => setTimeout(r, 20))
  await h.runPoller()
  assert.equal(h.notices.length, 1)
  assert.equal(h.notices[0]!.tool, 'kb_agent')
  assert.equal(h.notices[0]!.ok, true)
  assert.match(String(h.notices[0]!.summary), /doc_path=kb\/docs\/r1\.md/)

  // Agent 主动查询终态:claim 回执所有权,不再补送
  const done = await kbStatus!.handler({ task_id: 't1', wait_seconds: 0 })
  assert.match(done.text, /已完成/)
  assert.match(done.text, /doc_path=kb\/docs\/r1\.md/)
  assert.deepEqual(h.claims, ['kb_agent:t1'])
})

test('kb_agent sync 失败文案与 success 断言', async () => {
  const h = makeHarness()
  await plugin.setup(h.ctx)
  const kbAgent = h.tools.get('kb_agent')!
  const ok = await kbAgent.handler({ prompt: '检索膜厚', mode: 'sync' })
  assert.equal(ok.text, '同步答复')
})
