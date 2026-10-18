/**
 * diag-bridge 异步任务生命周期(2026-10-18):
 *   - queued 必须留在轮询集合(此前只看 running → 写回 queued 后永久丢失回执)
 *   - 终态回执投递失败保留 deliverPending,下一轮重试
 *   - 远端 404 连续 3 轮 → 收敛 failed 并回执(不再永久 running 占产线单飞锁)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error 插件是纯 JS,无类型声明
import { sweepOnce } from '../server/plugins-builtin/diag-bridge/host/sweep.mjs'
// @ts-expect-error 插件是纯 JS,无类型声明
import { runningOfLine } from '../server/plugins-builtin/diag-bridge/host/helpers.mjs'

interface Notice { ok: boolean, jobId: string, title: string, summary: string }

function makeCtx(initial: Record<string, unknown>, respond: (url: string) => Promise<unknown>) {
  const kv = new Map<string, unknown>(Object.entries(initial))
  const notices: Notice[] = []
  const calls: string[] = []
  const ctx = {
    kv: {
      get: (k: string) => kv.get(k),
      set: (k: string, v: unknown) => { kv.set(k, v) },
      all: () => Object.fromEntries(kv.entries()),
    },
    config: { get: () => undefined },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    http: {
      get: async (url: string) => {
        calls.push(url)
        const body = await respond(url)
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: body }),
        }
      },
    },
    services: {
      get: async () => ({
        deliver: async (n: Notice) => {
          notices.push(n)
          return true
        },
      }),
    },
  }
  return { ctx, kv, notices, calls }
}

test('sweep:queued 参与轮询,转为 running 后继续跟踪并在 completed 回执', async () => {
  let status = 'queued'
  const { ctx, kv, notices, calls } = makeCtx(
    { 'run:rq-1': { line: 'ln-1', status: 'queued', agentId: 'ag-1', channelId: 'ch-1', intent: 'deep-diagnosis', createdAt: Date.now() } },
    async () => ({ status }),
  )
  await sweepOnce(ctx)
  assert.equal((kv.get('run:rq-1') as { status: string }).status, 'queued')
  assert.equal(calls.length, 1, 'queued 也必须在轮询集合内(旧实现此处 0 次)')

  status = 'running'
  await sweepOnce(ctx)
  assert.equal((kv.get('run:rq-1') as { status: string }).status, 'running')

  status = 'completed'
  // 用带 result 的响应重跑
  const kvAny = kv as Map<string, unknown>
  const ctx3 = {
    ...ctx,
    http: {
      get: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { status: 'completed', result: { score: 88, verdict: 'ok', summary: 'done', report_md_path: '/tmp/report.md' } } }),
      }),
    },
  }
  await sweepOnce(ctx3)
  const final = kvAny.get('run:rq-1') as Record<string, unknown>
  assert.equal(final.status, 'completed')
  assert.equal(final.score, 88)
  assert.equal(notices.length, 1)
  assert.equal(notices[0]!.ok, true)
  assert.equal(final.deliverPending, false)
  assert.ok(final.deliveredAt, '回执成功后应记录 deliveredAt')
})

test('sweep:终态回执投递抛错 → 保留 deliverPending,下一轮重试成功', async () => {
  let fail = true
  const kv = new Map<string, unknown>([
    ['run:rd-1', { line: 'ln-1', status: 'completed', agentId: 'ag-1', channelId: 'ch-1', intent: 'deep-diagnosis', score: 90, createdAt: Date.now(), deliverPending: true }],
  ])
  const notices: Notice[] = []
  const ctx = {
    kv: { get: (k: string) => kv.get(k), set: (k: string, v: unknown) => { kv.set(k, v) }, all: () => Object.fromEntries(kv.entries()) },
    config: { get: () => undefined },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    http: { get: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) }) },
    services: {
      get: async () => ({
        deliver: async (n: Notice) => {
          if (fail) throw new Error('platform down')
          notices.push(n)
          return true
        },
      }),
    },
  }
  await sweepOnce(ctx)
  let meta = kv.get('run:rd-1') as Record<string, unknown>
  assert.equal(meta.deliverPending, true, '投递失败必须保留 pending')
  assert.equal(notices.length, 0)
  fail = false
  await sweepOnce(ctx)
  meta = kv.get('run:rd-1') as Record<string, unknown>
  assert.equal(notices.length, 1, '下一轮重试应送达')
  assert.equal(meta.deliverPending, false)
  assert.ok(meta.deliveredAt)
})

test('sweep:远端 404 连续 3 轮 → 收敛 failed 并回执(不再永久 running)', async () => {
  const kv = new Map<string, unknown>([
    ['run:r404', { line: 'ln-1', status: 'running', agentId: 'ag-1', channelId: 'ch-1', intent: 'deep-diagnosis', createdAt: Date.now() }],
  ])
  const notices: Notice[] = []
  const ctx = {
    kv: { get: (k: string) => kv.get(k), set: (k: string, v: unknown) => { kv.set(k, v) }, all: () => Object.fromEntries(kv.entries()) },
    config: { get: () => undefined },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    http: { get: async () => { throw new Error('HTTP 404 not found') } },
    services: {
      get: async () => ({
        deliver: async (n: Notice) => {
          notices.push(n)
          return true
        },
      }),
    },
  }
  await sweepOnce(ctx)
  await sweepOnce(ctx)
  assert.equal((kv.get('run:r404') as { status: string }).status, 'running')
  await sweepOnce(ctx)
  const meta = kv.get('run:r404') as Record<string, unknown>
  assert.equal(meta.status, 'failed')
  assert.match(String(meta.error), /HTTP 404/)
  assert.equal(notices.length, 1)
  assert.equal(notices[0]!.ok, false)
})

test('runningOfLine:queued 同样占用产线单飞锁', () => {
  const kv = new Map<string, unknown>([
    ['run:rq-2', { line: 'ln-1', status: 'queued' }],
  ])
  const ctx = { kv: { all: () => Object.fromEntries(kv.entries()) } }
  assert.equal(runningOfLine(ctx, 'ln-1')?.id, 'rq-2')
})
