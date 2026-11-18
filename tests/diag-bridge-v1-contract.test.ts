/**
 * diag-bridge v2.4(WS-2)契约层与生命周期:
 *  - auto 定轨:capabilities 200 → v1;404/不可达 → legacy;401 → 可读错误(不回退)
 *  - 错误码映射(手册 §9)与 capabilities 软预检
 *  - sweep v1:六态(completed/failed/stopped/interrupted/expired)+ awaiting_input 占锁/
 *    老化转 expired;v1 404×3 → expired;legacy 404×3 → failed
 *  - 工具面:diag_run v1 负载透传 + diag_chat/diag_stop + /report v1 内联报告
 *  - 单飞锁:awaiting_input 占用产线锁
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error 插件是纯 JS,无类型声明
import plugin from '../server/plugins-builtin/diag-bridge/index.mjs'
// @ts-expect-error 插件是纯 JS,无类型声明
import { mapV1Error, preflightCapabilities, resolveContract, normalizeResult } from '../server/plugins-builtin/diag-bridge/host/external-v1.mjs'
// @ts-expect-error 插件是纯 JS,无类型声明
import { sweepOnce } from '../server/plugins-builtin/diag-bridge/host/sweep.mjs'
// @ts-expect-error 插件是纯 JS,无类型声明
import { runningOfLine, ACTIVE_RUN_STATUSES } from '../server/plugins-builtin/diag-bridge/host/helpers.mjs'
// @ts-expect-error 插件是纯 JS,无类型声明
import { ANALYSIS_INTENTS } from '../server/plugins-builtin/diag-bridge/host/intents.mjs'

const CAPS = {
  intents: ['deep-diagnosis', 'stability-report', 'quick-screen', 'doe-analysis', 'experience-mining', 'optimizer-campaign', 'improvement-advisory'].map(intent => ({ intent })),
  harnesses: [
    { id: 'omp', runs_capable: true, session_resume: true, supported_intents: ['deep-diagnosis', 'stability-report', 'quick-screen', 'doe-analysis', 'experience-mining', 'optimizer-campaign', 'improvement-advisory'] },
    { id: 'claude', runs_capable: false, session_resume: true, supported_intents: ['deep-diagnosis'] },
  ],
}

const jsonRes = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body })

function makeBaseCtx({ kvInit = {}, get, post, configMap = {} }: {
  kvInit?: Record<string, unknown>
  get?: (url: string) => Promise<unknown>
  post?: (url: string, body: unknown) => Promise<unknown>
  configMap?: Record<string, unknown>
}) {
  const kv = new Map<string, unknown>(Object.entries(kvInit))
  const calls: Array<{ method: string, url: string, body?: unknown }> = []
  const ctx = {
    kv: {
      get: (k: string) => kv.get(k),
      set: (k: string, v: unknown) => { kv.set(k, v) },
      all: () => Object.fromEntries(kv.entries()),
    },
    config: { get: (k: string) => configMap[k] },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    http: {
      get: async (url: string) => {
        calls.push({ method: 'GET', url })
        return get ? await get(url) : jsonRes({ success: true, data: {} })
      },
      post: async (url: string, body: unknown) => {
        calls.push({ method: 'POST', url, body })
        return post ? await post(url, body) : jsonRes({ success: true, data: {} })
      },
    },
  }
  return { ctx, kv, calls }
}

// ── 契约定轨 ────────────────────────────────────────────────────────────────

test('resolveContract:auto + capabilities 200 → v1,并缓存(第二轮不再探测)', async () => {
  const { ctx, calls } = makeBaseCtx({
    kvInit: { 'diag.base_url': 'http://127.0.0.1:3210' },
    get: async () => jsonRes({ success: true, data: CAPS }),
  })
  const r1 = await resolveContract(ctx)
  assert.equal(r1.contract, 'v1')
  assert.equal(r1.mode, 'auto')
  const n1 = calls.length
  const r2 = await resolveContract(ctx)
  assert.equal(r2.contract, 'v1')
  assert.equal(calls.length, n1, '5min 缓存内不得重复探测')
})

test('resolveContract:404 → legacy;网络不可达 → legacy', async () => {
  const c404 = makeBaseCtx({
    kvInit: { 'diag.base_url': 'http://127.0.0.1:3210' },
    get: async () => jsonRes({ success: false }, 404),
  })
  assert.equal((await resolveContract(c404.ctx)).contract, 'legacy')
  const down = makeBaseCtx({
    kvInit: { 'diag.base_url': 'http://127.0.0.1:3210' },
    get: async () => { throw new Error('fetch failed') },
  })
  assert.equal((await resolveContract(down.ctx)).contract, 'legacy')
})

test('resolveContract:401 → 可读 token 指引且不回退 legacy', async () => {
  const c = makeBaseCtx({
    kvInit: { 'diag.base_url': 'http://127.0.0.1:3210' },
    get: async () => jsonRes({ success: false, error: 'unauthorized' }, 401),
  })
  const r = await resolveContract(c.ctx)
  assert.equal(r.contract, null)
  assert.match(String(r.error), /Token 无效或过期/)
})

test('resolveContract:显式 contract=v1/legacy 不探测', async () => {
  const v1 = makeBaseCtx({ kvInit: { 'diag.base_url': 'http://127.0.0.1:3210', 'diag.contract': 'v1' } })
  assert.equal((await resolveContract(v1.ctx)).contract, 'v1')
  assert.equal(v1.calls.length, 0)
  const legacy = makeBaseCtx({ kvInit: { 'diag.base_url': 'http://127.0.0.1:3210', 'diag.contract': 'legacy' } })
  assert.equal((await resolveContract(legacy.ctx)).contract, 'legacy')
  assert.equal(legacy.calls.length, 0)
})

// ── 错误映射与预检 ───────────────────────────────────────────────────────────

test('mapV1Error:9 类错误码 → 中文可读处方', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ status: 401, body: { code: 'AUTH_REQUIRED' } }, /Token 无效\/过期/],
    [{ status: 400, body: { code: 'EXTERNAL_INTENT_UNKNOWN', error: 'bad' } }, /未知分析意图/],
    [{ status: 400, body: { code: 'HARNESS_UNKNOWN' } }, /引擎名不存在/],
    [{ status: 409, body: { code: 'HARNESS_UNAVAILABLE' } }, /引擎不可用/],
    [{ status: 400, body: { code: 'EXTERNAL_DATA_REQUIRED' } }, /缺少数据来源/],
    [{ status: 404, body: { code: 'DATA_NOT_FOUND' } }, /数据路径不存在/],
    [{ status: 403, body: { code: 'PATH_TRAVERSAL' } }, /越界被拒|Token/],
    [{ status: 400, body: { code: 'INTENT_UNSUPPORTED_ON_HARNESS' } }, /不支持此分析意图/],
    [{ status: 409, body: { code: 'RUN_NOT_IDLE' } }, /不能续聊/],
  ]
  for (const [r, re] of cases) {
    const msg = mapV1Error(r)
    assert.match(msg, re, `错误映射不符:${JSON.stringify(r)} → ${msg}`)
  }
  assert.match(mapV1Error({ status: 409, body: { code: 'RUN_TERMINAL' } }), /已结束/)
  assert.match(mapV1Error({ status: 0, error: 'fetch failed' }, { base: 'http://x' }), /不可达/)
})

test('preflightCapabilities:未知意图 / 引擎无 runs 能力 / 意图不受支持 → 可读拒绝', () => {
  const cap = { ok: true, data: CAPS }
  assert.match(String(preflightCapabilities(cap, { intent: 'not-a-mode', harness: 'omp' })), /未知分析意图/)
  assert.match(String(preflightCapabilities(cap, { intent: 'quick-screen', harness: 'claude' })), /不具备 runs 能力/)
  assert.match(String(preflightCapabilities(cap, { intent: 'quick-screen', harness: 'nope' })), /不在 capabilities 清单/)
  const narrowed = { ok: true, data: { ...CAPS, harnesses: [{ id: 'omp', runs_capable: true, supported_intents: ['quick-screen'] }] } }
  assert.match(String(preflightCapabilities(narrowed, { intent: 'doe-analysis', harness: 'omp' })), /不支持分析意图/)
  assert.equal(preflightCapabilities(cap, { intent: 'quick-screen', harness: 'omp' }), null)
})

test('normalizeResult:v1 task entry(result.files) → 内部形状;legacy 形状兼容', () => {
  const v1 = normalizeResult({
    result: { score: 88, verdict: 'alert', summary: 's', report_md: '# md', files: { report_md_path: 'C:/x/report.md', report_md_url: '/api/files/x', html: [{ url: '/a.html' }] } },
  })
  assert.equal(v1.score, 88)
  assert.equal(v1.verdict, 'alert')
  assert.equal(v1.reportPath, 'C:/x/report.md')
  assert.equal(v1.reportUrl, '/api/files/x')
  assert.equal(v1.reportMd, '# md')
  assert.equal(v1.html.length, 1)
  const legacy = normalizeResult({ result: { score: 70, report_md_path: 'C:/y.md', error: 'e' } })
  assert.equal(legacy.reportPath, 'C:/y.md')
  assert.equal(legacy.error, 'e')
})

// ── sweep v1 生命周期 ────────────────────────────────────────────────────────

function makeSweepCtx(kvInit: Record<string, unknown>, respond: (url: string) => Promise<unknown>) {
  const kv = new Map<string, unknown>(Object.entries(kvInit))
  const notices: Array<Record<string, unknown>> = []
  const ctx = {
    kv: { get: (k: string) => kv.get(k), set: (k: string, v: unknown) => { kv.set(k, v) }, all: () => Object.fromEntries(kv.entries()) },
    config: { get: () => undefined },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    http: {
      get: async (url: string) => {
        const body = await respond(url)
        return jsonRes(body)
      },
      post: async () => jsonRes({ success: true }),
    },
    services: {
      get: async () => ({
        deliver: async (n: Record<string, unknown>) => {
          notices.push(n)
          return true
        },
      }),
    },
  }
  return { ctx, kv, notices }
}

test('sweep v1:completed → 归一 result.files + 回执送达;契约落账', async () => {
  const { ctx, kv, notices } = makeSweepCtx(
    { 'diag.base_url': 'http://127.0.0.1:3210', 'run:run-1': { line: 'ln-1', status: 'running', contract: 'v1', taskId: 'TASK-1', runId: 'run-1', agentId: 'ag-1', channelId: 'ch-1', intent: 'quick-screen', createdAt: Date.now() } },
    async () => ({ success: true, data: { task_id: 'TASK-1', run_id: 'run-1', status: 'completed', name: 'quick', result: { score: 0, verdict: 'alert', summary: '82 alerts', files: { report_md_path: 'C:/ws/report.md', report_md_url: '/api/files/ws/report', html: [{ url: '/a.html' }] } } } }),
  )
  await sweepOnce(ctx)
  const meta = kv.get('run:run-1') as Record<string, unknown>
  assert.equal(meta.status, 'completed')
  assert.equal(meta.reportPath, 'C:/ws/report.md')
  assert.equal(meta.reportUrl, '/api/files/ws/report')
  assert.equal(meta.score, 0)
  assert.equal(notices.length, 1)
  assert.equal(notices[0]!.ok, true)
  assert.match(String(notices[0]!.summary), /report_md_path=C:\/ws\/report\.md/)
})

test('sweep v1:awaiting_input 占锁不发回执;老化到期 → expired + 提示回执', async () => {
  const old = Date.now() - 31 * 60_000
  const { ctx, kv, notices } = makeSweepCtx(
    { 'diag.base_url': 'http://127.0.0.1:3210', 'run:run-a': { line: 'ln-1', status: 'running', contract: 'v1', taskId: 'TASK-A', agentId: 'ag-1', intent: 'deep-diagnosis', createdAt: old } },
    async () => ({ success: true, data: { task_id: 'TASK-A', status: 'awaiting_input' } }),
  )
  await sweepOnce(ctx)
  let meta = kv.get('run:run-a') as Record<string, unknown>
  assert.equal(meta.status, 'awaiting_input')
  assert.ok(meta.awaitingSince, '必须记录进入 awaiting 的时间')
  assert.equal(notices.length, 0, 'awaiting_input 不触发终态回执')
  assert.ok(ACTIVE_RUN_STATUSES.has('awaiting_input'), 'awaiting_input 必须占单飞锁')
  assert.equal(runningOfLine(ctx, 'ln-1')?.id, 'run-a')

  // 老化:把 since 拨回 31 分钟 → expired + 回执
  kv.set('run:run-a', { ...meta, awaitingSince: Date.now() - 31 * 60_000 })
  await sweepOnce(ctx)
  meta = kv.get('run:run-a') as Record<string, unknown>
  assert.equal(meta.status, 'expired')
  assert.equal(notices.length, 1)
  assert.match(String(notices[0]!.summary), /awaiting_input.*超过/)
})

test('sweep v1:404×3 → expired(v1 语义);legacy 404×3 → failed(回归不变)', async () => {
  const mk = (contract: string) => makeSweepCtx(
    { 'diag.base_url': 'http://127.0.0.1:3210', [`run:r-${contract}`]: { line: 'ln-1', status: 'running', contract, taskId: 'TASK-X', agentId: 'ag-1', intent: 'deep-diagnosis', createdAt: Date.now() } },
    async () => { throw new Error('HTTP 404 not found') },
  )
  const v1 = mk('v1')
  for (let i = 0; i < 3; i++) await sweepOnce(v1.ctx)
  assert.equal((v1.kv.get('run:r-v1') as { status: string }).status, 'expired')
  const legacy = mk('legacy')
  for (let i = 0; i < 3; i++) await sweepOnce(legacy.ctx)
  assert.equal((legacy.kv.get('run:r-legacy') as { status: string }).status, 'failed')
})

// ── 插件工具面(完整 setup harness) ─────────────────────────────────────────

interface Tool { handler: (args: Record<string, unknown>, agent?: Record<string, unknown>) => Promise<{ text: string, isError?: boolean }>, roles?: string[], riskClass?: string, description?: string }

function makePluginHarness({ contract = 'auto', caps = CAPS, taskResponses = {} as Record<string, unknown>, runResults = {} as Record<string, unknown> } = {}) {
  const kv = new Map<string, unknown>([['diag.base_url', 'http://127.0.0.1:3210']])
  if (contract !== 'auto') kv.set('diag.contract', contract)
  const tools = new Map<string, Tool>()
  const routes = new Map<string, (event?: unknown) => Promise<unknown>>()
  const calls: Array<{ method: string, url: string, body?: unknown }> = []
  const ops: Array<Record<string, unknown>> = []
  const notices: Array<Record<string, unknown>> = []
  let analyzeBody: Record<string, unknown> | null = null
  const ctx = {
    config: { get: () => undefined, onChange: () => {}, defineGroup: () => {}, defineField: () => {} },
    kv: { get: (k: string) => kv.get(k), set: (k: string, v: unknown) => { kv.set(k, v) }, all: () => Object.fromEntries(kv.entries()) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    omp: { registerTool: (t: Tool & { name: string }) => { tools.set(t.name, t) } },
    route: (m: string, p: string, fn: (event?: unknown) => Promise<unknown>) => { routes.set(`${m} ${p}`, fn) },
    timer: { setInterval: () => 1, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) },
    hooks: { on: () => {} },
    permissions: { visibleLineIds: () => new Set(['ln-1']), lineMode: () => 'read' },
    http: {
      get: async (url: string) => {
        calls.push({ method: 'GET', url })
        if (url.includes('/api/external/v1/capabilities')) return jsonRes({ success: true, data: caps })
        if (url.includes('/api/external/v1/tasks/')) {
          const id = url.split('/tasks/')[1]!.split('/')[0]!
          if (url.endsWith('/result')) return jsonRes({ success: true, data: runResults[id] ?? { status: 'completed', result: {} } })
          return jsonRes({ success: true, data: taskResponses[id] ?? { task_id: id, status: 'running' } })
        }
        if (url.includes('/api/external/v1/results')) return jsonRes({ success: true, data: { results: [], total: 0 } })
        if (url.includes('/api/health')) return jsonRes({ status: 'ok' })
        return jsonRes({ success: true, data: {} })
      },
      post: async (url: string, body: unknown) => {
        calls.push({ method: 'POST', url, body })
        if (url.includes('/api/external/v1/analyze') && !url.includes('/stop')) {
          analyzeBody = body as Record<string, unknown>
          return jsonRes({ success: true, data: { task_id: 'TASK-N', run_id: 'run-new', status: 'accepted', links: {} } }, 202)
        }
        if (url.includes('/api/external/v1/chat')) return jsonRes({ success: true, data: { run_id: 'run-new', delivered: true, mode: 'session', resumed: true } })
        if (url.includes('/api/external/v1/analyze/') && url.endsWith('/stop')) return jsonRes({ success: true, data: { status: 'stopped' } })
        if (url.includes('/stop/')) return jsonRes({ success: true, data: { status: 'stopped' } })
        return jsonRes({ success: true, data: {} })
      },
    },
    services: {
      get: async (name: string) => {
        if (name === 'notify') {
          return {
            deliver: async (n: Record<string, unknown>) => {
              notices.push(n)
              return true
            },
            claim: () => {},
          }
        }
        if (name === 'agentScope') return { productionEnabled: () => true, readableLines: () => ['ln-1'] }
        if (name === 'ops.record') {
          return (e: Record<string, unknown>) => {
            ops.push(e)
          }
        }
        return null
      },
    },
  }
  return { ctx, kv, tools, routes, calls, ops, notices, analyzeBody: () => analyzeBody }
}

test('diag_run(v1):capabilities 预检 + 负载透传 + 契约/双 id 落 KV', async () => {
  const h = makePluginHarness()
  await plugin.setup(h.ctx)
  const r = await h.tools.get('diag_run')!.handler({
    data_path: 'aw-snapshots/x.csv', analysis_intent: 'stability-report', line: 'ln-1',
    ontology_mode: 'reuse', preprocessing_mode: 'integrate_merge', report_language: 'en',
  }, { agentId: 'ag-1', channelId: 'ch-1', role: 'lead', name: 'lead' })
  assert.ok(!r.isError, r.text)
  assert.match(r.text, /contract=v1/)
  const body = h.analyzeBody()!
  assert.equal(body.analysisIntent, 'stability-report')
  assert.equal(body.harness, 'omp')
  assert.equal(body.ontologyMode, 'reuse')
  assert.equal(body.preprocessingMode, 'integrate_merge')
  assert.equal(body.reportLanguage, 'en')
  assert.equal(body.wait, false)
  const meta = h.kv.get('run:run-new') as Record<string, unknown>
  assert.equal(meta.contract, 'v1')
  assert.equal(meta.taskId, 'TASK-N')
  assert.equal(meta.runId, 'run-new')
  assert.equal(meta.agentId, 'ag-1')
})

test('diag_run(v1):未知意图 → 提交前可读拒绝(不 POST /analyze)', async () => {
  const h = makePluginHarness()
  await plugin.setup(h.ctx)
  const r = await h.tools.get('diag_run')!.handler({ data_path: 'x.csv', analysis_intent: 'not-a-mode' }, { agentId: 'ag-1', role: 'lead' })
  assert.equal(r.isError, true)
  assert.match(r.text, /未知分析意图/)
  assert.ok(!h.calls.some(c => c.url.endsWith('/analyze')), '预检失败不得提交分析')
})

test('diag_run(legacy 显式):走旧 /api/diagnosis/tasks 并落 contract=legacy', async () => {
  const h = makePluginHarness({ contract: 'legacy' })
  h.ctx.http.post = async (url: string, body: unknown) => {
    h.calls.push({ method: 'POST', url, body })
    if (url.includes('/api/diagnosis/tasks')) return jsonRes({ success: true, data: { task_id: 'legacy-run', status: 'running' } })
    return jsonRes({ success: true, data: {} })
  }
  await plugin.setup(h.ctx)
  const r = await h.tools.get('diag_run')!.handler({ data_path: 'x.csv', analysis_intent: 'quick-screen', line: 'ln-1' }, { agentId: 'ag-1', role: 'lead' })
  assert.ok(!r.isError, r.text)
  assert.match(r.text, /contract=legacy/)
  const meta = h.kv.get('run:legacy-run') as Record<string, unknown>
  assert.equal(meta.contract, 'legacy')
})

test('diag_chat:legacy run 可读拒绝;v1 run 送达并标注 resumed', async () => {
  const h = makePluginHarness()
  await plugin.setup(h.ctx)
  h.kv.set('run:run-new', { line: 'ln-1', status: 'completed', contract: 'v1', taskId: 'TASK-N', runId: 'run-new', agentId: 'ag-1', intent: 'quick-screen' })
  h.kv.set('run:old-run', { line: 'ln-1', status: 'completed', contract: 'legacy', intent: 'deep-diagnosis' })
  const chat = h.tools.get('diag_chat')!
  const v1 = await chat.handler({ run_id: 'run-new', message: '展开第 3 条告警' }, { agentId: 'ag-1', role: 'lead' })
  assert.ok(!v1.isError, v1.text)
  assert.match(v1.text, /^status=ok run_id=run-new delivered=true/)
  assert.match(v1.text, /resumed=true/)
  const legacy = await chat.handler({ run_id: 'old-run', message: 'x' }, { agentId: 'ag-1', role: 'lead' })
  assert.equal(legacy.isError, true)
  assert.match(legacy.text, /legacy/)
  const unknown = await chat.handler({ run_id: 'nope', message: 'x' }, { agentId: 'ag-1', role: 'lead' })
  assert.equal(unknown.isError, true)
  assert.match(unknown.text, /不在本插件台账/)
})

test('diag_stop:v1 停止成功 + 审计记录;已终态 → 可读不调用', async () => {
  const h = makePluginHarness()
  await plugin.setup(h.ctx)
  h.kv.set('run:run-new', { line: 'ln-1', status: 'running', contract: 'v1', taskId: 'TASK-N', runId: 'run-new', agentId: 'ag-1', intent: 'stability-report' })
  h.kv.set('run:run-done', { line: 'ln-1', status: 'completed', contract: 'v1', taskId: 'T2', runId: 'run-done' })
  const stop = h.tools.get('diag_stop')!
  const r = await stop.handler({ run_id: 'run-new' }, { agentId: 'ag-1', role: 'lead', name: 'lead' })
  assert.ok(!r.isError, r.text)
  assert.match(r.text, /^status=stopped run_id=run-new contract=v1/)
  assert.ok(h.calls.some(c => c.url.endsWith('/analyze/run-new/stop')))
  assert.equal((h.kv.get('run:run-new') as Record<string, unknown>).status, 'stopped')
  assert.equal(h.ops.length, 1)
  assert.match(String(h.ops[0]!.summary), /停止诊断 run/)
  const done = await stop.handler({ run_id: 'run-done' }, { agentId: 'ag-1', role: 'lead' })
  assert.equal(done.isError, undefined)
  assert.match(done.text, /已是终态/)
})

test('diag_status(v1):completed 输出归一字段 + report_url + contract', async () => {
  const h = makePluginHarness({
    taskResponses: { 'TASK-N': { task_id: 'TASK-N', run_id: 'run-new', status: 'completed', name: 'quick-850', result: { score: 0, verdict: 'alert', summary: '82 alerts', files: { report_md_path: 'C:/ws/report.md', report_md_url: '/api/files/ws/report' } } } },
  })
  await plugin.setup(h.ctx)
  h.kv.set('run:run-new', { line: 'ln-1', status: 'running', contract: 'v1', taskId: 'TASK-N', runId: 'run-new', intent: 'quick-screen', createdAt: Date.now() })
  const r = await h.tools.get('diag_status')!.handler({ run_id: 'run-new' }, { agentId: 'ag-1', channelId: 'ch-1', role: 'lead', name: 'lead' })
  assert.match(r.text, /contract=v1/)
  assert.match(r.text, /状态=completed/)
  assert.match(r.text, /评分=0/)
  assert.match(r.text, /结论=alert/)
  assert.match(r.text, /report_md_path=C:\/ws\/report\.md/)
  assert.match(r.text, /report_url=\/api\/files\/ws\/report/)
})

test('diag_status(v1):awaiting_input 提示人工介入与老化上限', async () => {
  const h = makePluginHarness({ taskResponses: { 'TASK-A': { task_id: 'TASK-A', status: 'awaiting_input' } } })
  await plugin.setup(h.ctx)
  h.kv.set('run:run-a', { line: 'ln-1', status: 'awaiting_input', contract: 'v1', taskId: 'TASK-A', awaitingSince: Date.now() - 5 * 60_000, intent: 'deep-diagnosis' })
  const r = await h.tools.get('diag_status')!.handler({ run_id: 'run-a' }, { agentId: 'ag-1', channelId: 'ch-1', role: 'lead', name: 'lead' })
  assert.match(r.text, /状态=awaiting_input/)
  assert.match(r.text, /等待人工介入/)
  assert.match(r.text, /已等待 5 分钟/)
})

test('/report(v1):返回内联 report_md 与可打开 URL', async () => {
  const h = makePluginHarness({
    runResults: { 'TASK-N': { task_id: 'TASK-N', run_id: 'run-new', status: 'completed', name: 'r', result: { report_md: '# 报告正文', files: { report_md_url: '/api/files/ws/report' } } } },
  })
  await plugin.setup(h.ctx)
  h.kv.set('run:run-new', { line: 'ln-1', contract: 'v1', taskId: 'TASK-N', scene: 's' })
  const route = h.routes.get('GET /report')!
  const r = await route({ path: '/report?run_id=run-new', awUser: { id: 'u1', role: 'admin' } }) as Record<string, unknown>
  assert.equal(r.success, true)
  const report = r.report as Record<string, unknown>
  assert.equal(report.content, '# 报告正文')
  assert.equal(report.url, 'http://127.0.0.1:3210/api/files/ws/report')
})

test('意图目录:improvement-advisory 进静态目录与模板(7 意图)', async () => {
  assert.ok(ANALYSIS_INTENTS['improvement-advisory'], '静态目录缺 improvement-advisory')
  assert.equal(Object.keys(ANALYSIS_INTENTS).length, 7)
  const run = makePluginHarness()
  await plugin.setup(run.ctx)
  const desc = run.tools.get('diag_run')!.description ?? ''
  assert.match(desc, /7 意图/)
})

test('diag_deposit:写类注册(lead+worker/write)+ 未知 run 可读拒绝', async () => {
  const h = makePluginHarness()
  await plugin.setup(h.ctx)
  const tool = h.tools.get('diag_deposit')!
  assert.ok(tool, 'diag_deposit 必须注册')
  assert.deepEqual(tool.roles, ['lead', 'worker'])
  assert.equal(tool.riskClass, 'write')
  const r = await tool.handler({ run_id: 'no-such-run' }, { agentId: 'ag-1', channelId: 'ch-1', role: 'lead', name: 'lead' })
  assert.equal(r.isError, true)
  assert.match(r.text, /不在本插件台账/)
})

test('health:contract + toolCounters(WS-4 S3)', async () => {
  const h = makePluginHarness({ taskResponses: { 'TASK-H': { task_id: 'TASK-H', status: 'running' } } })
  await plugin.setup(h.ctx)
  h.kv.set('run:r-h', { line: 'ln-1', status: 'running', contract: 'v1', taskId: 'TASK-H', intent: 'quick-screen' })
  await h.tools.get('diag_status')!.handler({ run_id: 'r-h' }, { agentId: 'ag-1', channelId: 'ch-1', role: 'lead', name: 'lead' })
  const health = await h.routes.get('GET /health')!() as {
    contract: string
    toolCounters: Record<string, { ok: number, err: number }>
  }
  assert.equal(health.contract, 'auto')
  assert.ok(health.toolCounters.diag_status.ok >= 1, '工具计数应可见')
})
