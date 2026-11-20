/**
 * mes-tool-bridge 参考插件契约测试(external tool integration pattern)。
 *
 * 该插件是「把外接系统 REST 能力暴露为 Agent 工具」的可复用模板:
 * 插件声明 settings(base_url/token/timeout_ms,无任何硬编码凭据),在 setup 里
 * 经 ctx.omp.registerTool 注册读/写两个工具,写工具带 riskClass=write + lead-only。
 *
 * 本测试用假 ctx 驱动真实插件代码,锁住四类契约:
 *  ① 模块形态与设置声明合规(SDK 校验器通过、默认值齐备);
 *  ② 注册形状:只读工具双角色、写工具 lead-only + riskClass=write + noRefs;
 *  ③ 未配置时 fail-closed(给可操作指引,不发网络请求、不假装成功);
 *  ④ 已配置时 URL 归一化、错误映射、且**任何路径都不回显 token**。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validatePluginModule, validatePluginSettings } from '../sdk/index.mjs'

const ENTRY = '../sdk/examples/mes-tool-bridge/index.mjs'

async function loadPlugin() {
  const mod = await import(ENTRY)
  return mod.default ?? mod
}

interface FakeCtxOptions {
  settings?: Record<string, unknown>
  get?: (url: string, opts?: Record<string, unknown>) => Promise<Response>
  post?: (url: string, opts?: Record<string, unknown>) => Promise<Response>
}

function makeCtx({ settings = {}, get, post }: FakeCtxOptions = {}) {
  const tools = new Map<string, Record<string, unknown>>()
  const calls: Array<{ method: string, url: string, opts?: Record<string, unknown> }> = []
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    config: { get: (key: string) => settings[key] },
    omp: {
      registerTool: (tool: Record<string, unknown>) => {
        tools.set(String(tool.name), tool)
        return true
      },
    },
    http: {
      get: async (url: string, opts?: Record<string, unknown>) => {
        calls.push({ method: 'GET', url, opts })
        if (!get) throw new Error('unexpected GET')
        return get(url, opts)
      },
      post: async (url: string, body: unknown, opts?: Record<string, unknown>) => {
        calls.push({ method: 'POST', url, opts: { ...opts, body: JSON.stringify(body) } })
        if (!post) throw new Error('unexpected POST')
        return post(url, opts)
      },
    },
  }
  return { ctx, tools, calls }
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const invoke = async (tool: Record<string, unknown>, args: Record<string, unknown>) => {
  const handler = tool.handler as (a: Record<string, unknown>, agent: unknown) => Promise<{ text: string, isError?: boolean }>
  return await handler(args, { agentId: 'a1', channelId: 'c1', role: 'lead', name: 'lead' })
}

describe('mes-tool-bridge example plugin', () => {
  it('模块形态通过 SDK 校验,设置声明合法且无需硬编码凭据', async () => {
    const def = await loadPlugin()
    const check = validatePluginModule({ default: def }, ENTRY)
    assert.ok(check.ok, check.ok ? '' : (check as { error: string }).error)
    assert.equal((check as { def: { name: string } }).def.name, 'mes-tool-bridge')
    assert.equal(typeof (def as { setup?: unknown }).setup, 'function')

    const settings = validatePluginSettings('mes-tool-bridge', (def as { settings?: unknown[] }).settings)
    assert.deepEqual(settings.errors, [])
    const byKey = new Map(settings.descriptors.map(d => [d.key, d]))
    assert.ok(byKey.has('plugins.mes-tool-bridge.base_url'))
    assert.ok(byKey.has('plugins.mes-tool-bridge.token'))
    assert.ok(byKey.has('plugins.mes-tool-bridge.timeout_ms'))
    // 默认值必须是空/安全值 —— token 默认空串而不是示例密钥
    assert.equal(byKey.get('plugins.mes-tool-bridge.token')?.default, '')
    assert.equal(byKey.get('plugins.mes-tool-bridge.base_url')?.default, '')
  })

  it('setup 注册读/写两个工具:读双角色、写 lead-only 且 riskClass=write', async () => {
    const def = await loadPlugin()
    const { ctx, tools } = makeCtx()
    await (def as { setup: (c: unknown) => Promise<void> }).setup(ctx)

    assert.deepEqual([...tools.keys()].sort(), ['mes_order_status', 'mes_quality_report'])
    const read = tools.get('mes_order_status')!
    assert.deepEqual(read.roles, ['lead', 'worker'])
    assert.equal(read.riskClass, 'read')
    assert.equal(read.noRefs, true)
    assert.equal((read.parameters as { type?: string }).type, 'object')

    const write = tools.get('mes_quality_report')!
    assert.deepEqual(write.roles, ['lead'])
    assert.equal(write.riskClass, 'write')
    assert.equal(write.noRefs, true)
  })

  it('未配置 base_url 时 fail-closed:给可操作指引,不发起网络请求', async () => {
    const def = await loadPlugin()
    const { ctx, tools, calls } = makeCtx()
    await (def as { setup: (c: unknown) => Promise<void> }).setup(ctx)

    const res = await invoke(tools.get('mes_order_status')!, { orderId: 'PO-1' })
    assert.equal(res.isError, true)
    assert.match(res.text, /未配置/)
    assert.match(res.text, /系统设置/)
    assert.equal(calls.length, 0)
  })

  it('已配置时归一化 base_url、只读工具返回订单摘要', async () => {
    const def = await loadPlugin()
    const { ctx, tools, calls } = makeCtx({
      settings: {
        'plugins.mes-tool-bridge.base_url': 'http://mes.example.com/api/',
        'plugins.mes-tool-bridge.token': 'secret-token-xyz',
        'plugins.mes-tool-bridge.timeout_ms': 5000,
      },
      get: async () => jsonResponse({ orderId: 'PO-1', status: 'in_progress', progress: 42, defects: 1 }),
    })
    await (def as { setup: (c: unknown) => Promise<void> }).setup(ctx)

    const res = await invoke(tools.get('mes_order_status')!, { orderId: 'PO 1' })
    assert.equal(res.isError, undefined)
    assert.match(res.text, /PO 1/)
    assert.match(res.text, /in_progress/)
    assert.match(res.text, /42/)
    assert.equal(calls[0].url, 'http://mes.example.com/api/orders/PO%201')
    assert.equal((calls[0].opts as { timeoutMs?: number }).timeoutMs, 5000)
    assert.equal((calls[0].opts as { headers?: Record<string, string> }).headers?.authorization, 'Bearer secret-token-xyz')
    // 结果文本绝不含 token
    assert.doesNotMatch(res.text, /secret-token-xyz/)
  })

  it('外部系统错误映射为 isError 且不回显 token', async () => {
    const def = await loadPlugin()
    const { ctx, tools } = makeCtx({
      settings: {
        'plugins.mes-tool-bridge.base_url': 'http://mes.example.com',
        'plugins.mes-tool-bridge.token': 'secret-token-xyz',
      },
      get: async () => jsonResponse({ error: 'boom' }, 502),
    })
    await (def as { setup: (c: unknown) => Promise<void> }).setup(ctx)

    const res = await invoke(tools.get('mes_order_status')!, { orderId: 'PO-9' })
    assert.equal(res.isError, true)
    assert.match(res.text, /502/)
    assert.doesNotMatch(res.text, /secret-token-xyz/)
  })

  it('写工具拒绝空 metrics(参数校验前置),合法请求返回回执号', async () => {
    const def = await loadPlugin()
    const { ctx, tools, calls } = makeCtx({
      settings: {
        'plugins.mes-tool-bridge.base_url': 'http://mes.example.com',
        'plugins.mes-tool-bridge.token': 'secret-token-xyz',
      },
      post: async () => jsonResponse({ receiptId: 'RCPT-777' }, 201),
    })
    await (def as { setup: (c: unknown) => Promise<void> }).setup(ctx)
    const write = tools.get('mes_quality_report')!

    const bad = await invoke(write, { orderId: 'PO-1', metrics: {} })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /metrics/)
    assert.equal(calls.length, 0)

    const ok = await invoke(write, { orderId: 'PO-1', metrics: { weight: 32.5 } })
    assert.equal(ok.isError, undefined)
    assert.match(ok.text, /RCPT-777/)
    const body = String((calls[0].opts as { body?: string }).body ?? '')
    assert.match(body, /"weight":32.5/)
  })

  it('非 http(s) base_url 被拒绝(协议卫生,防御纵深)', async () => {
    const def = await loadPlugin()
    const { ctx, tools, calls } = makeCtx({
      settings: { 'plugins.mes-tool-bridge.base_url': 'file:///etc/passwd' },
    })
    await (def as { setup: (c: unknown) => Promise<void> }).setup(ctx)

    const res = await invoke(tools.get('mes_order_status')!, { orderId: 'PO-1' })
    assert.equal(res.isError, true)
    assert.match(res.text, /http\/https|协议/)
    assert.equal(calls.length, 0)
  })
})
