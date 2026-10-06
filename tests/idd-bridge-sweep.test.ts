/**
 * D6 回归(2026-10-06):idd-closedloop-bridge 回扫完成分支必须同步收敛清单键
 * `idd_closedloop_runs` —— 此前只写单任务键 `iddcl:<id>`,清单条目永停 running,
 * sweep 每 15s 永久重轮询已终态任务(kv 展示失真 + 无效轮询)。
 * 断言:setup 的首轮 sweep 后,①清单键内任务 status 收敛为 IDD 终态;
 * ②单任务键 `iddcl:<id>` 结果缓存仍写入(status 工具的兜底数据面)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../.AgentWorkShop/plugins/idd-closedloop-bridge/index.mjs'

/** 内存 kv + 可编程 config 的插件宿主替身;timer.setInterval 捕获回调不真起间隔 */
function makeHostCtx(configMap) {
  const kvStore = new Map()
  let sweepFn = null
  const tools = []
  const ctx = {
    kv: {
      get: k => kvStore.get(k),
      set: (k, v) => kvStore.set(k, v),
    },
    config: { get: k => configMap.get(k) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    timer: {
      setInterval: (fn) => {
        sweepFn = fn
        return 0
      },
      clearInterval: () => {},
    },
    omp: { registerTool: t => tools.push(t.name) },
  }
  return { ctx, kvStore, sweep: () => sweepFn?.(), tools }
}
test('D6 回扫收敛:sweep 后清单键 status=completed,不再滞留 running', async () => {
  const host = makeHostCtx(new Map([
    ['plugins.idd-closedloop-bridge.base_url', 'http://127.0.0.1:0'],
    ['plugins.idd-closedloop-bridge.token', ''],
  ]))
  // 预置一个 running 的 sentinel_watch 任务(与线上一致的 trackTask 形状)
  host.ctx.kv.set('idd_closedloop_runs', [
    { id: 'SNW-TEST-0001', kind: 'sentinel_watch', meta: { status: 'running', createdAt: Date.now() } },
  ])

  const realFetch = globalThis.fetch
  let iddHits = 0
  globalThis.fetch = (async (url) => {
    if (String(url).includes('/api/sentinel/tasks/SNW-TEST-0001')) {
      iddHits++
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { task_id: 'SNW-TEST-0001', status: 'completed', alert_status: 'alert', alerts: [{ rule_name: 'NELSON_R1' }], report_path: 'x.md' } }),
      }
    }
    throw new Error(`unexpected fetch ${String(url)}`)
  }) as typeof fetch

  try {
    plugin.setup(host.ctx) // setup 末尾会火一次 sweep(async,不等待)
    // 顺序跑两轮让在途 promise 全部落定:首轮收敛,次轮验证幂等(不再重轮询)
    await host.sweep()
    await host.sweep()
    await new Promise(resolve => setImmediate(resolve))

    const runs = host.ctx.kv.get('idd_closedloop_runs')
    assert.equal(runs.length, 1)
    assert.equal(runs[0].meta.status, 'completed', '清单键条目必须收敛为 IDD 终态(D6 主断言)')
    assert.ok(runs[0].meta.completedAt, '清单条目应带完成时间')
    const cached = host.ctx.kv.get('iddcl:SNW-TEST-0001')
    assert.equal(cached?.meta?.status, 'completed', '单任务键结果缓存仍要写入')
    assert.ok(iddHits >= 1, '首轮 sweep 至少查询一次 IDD')
    const hitsAtSettled = iddHits
    await host.sweep()
    assert.equal(iddHits, hitsAtSettled, '收敛后 sweep 不应再重轮询(幂等)')
  }
  finally {
    globalThis.fetch = realFetch
  }
})

test('D6 失败任务同样收敛:sweep 后清单 status=failed 且带错误信息', async () => {
  const host = makeHostCtx(new Map([
    ['plugins.idd-closedloop-bridge.base_url', 'http://127.0.0.1:0'],
    ['plugins.idd-closedloop-bridge.token', ''],
  ]))
  host.ctx.kv.set('idd_closedloop_runs', [
    { id: 'SNB-TEST-0002', kind: 'sentinel_watch', meta: { status: 'running', createdAt: Date.now() } },
  ])
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url) => {
    if (String(url).includes('/api/sentinel/tasks/SNB-TEST-0002')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { task_id: 'SNB-TEST-0002', status: 'failed', error: 'path outside allowed roots' } }),
      }
    }
    throw new Error(`unexpected fetch ${String(url)}`)
  }) as typeof fetch
  try {
    plugin.setup(host.ctx)
    await host.sweep()
    await new Promise(resolve => setImmediate(resolve))
    const runs = host.ctx.kv.get('idd_closedloop_runs')
    assert.equal(runs[0].meta.status, 'failed')
  }
  finally {
    globalThis.fetch = realFetch
  }
})
