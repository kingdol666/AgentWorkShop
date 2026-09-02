/**
 * ops-notifier — 写控与产线事件回声(SDK 示例插件)
 * 滚动记录最近写控/启停事件(内存 + KV 防抖落盘),提供 /recent 查询 API;
 * 客户端以 toast 展示最近一次写控。展示 dcw:write / line:* 钩子与事件消费。
 */
const ROLL = 30

export default {
  name: 'ops-notifier',
  version: '1.0.0',
  description: '写控与产线事件回声:滚动记录最近事件 + 查询 API + 客户端通知',
  client: './client.mjs',

  async setup(ctx) {
    ctx.logger.info('已装载 —— 监听 dcw:write 与产线启停')

    const push = (entry) => {
      const log = ctx.kv.get('recent') ?? []
      log.unshift(entry)
      ctx.kv.set('recent', log.slice(0, ROLL))
    }

    ctx.hooks.on('dcw:write', (w) => {
      push({ kind: 'write', nodeId: w.nodeId, name: w.name, eng: w.eng, ok: w.ok, source: w.source, at: w.at })
    })
    ctx.hooks.on('line:start', p => push({ kind: 'line:start', lineId: p?.lineId, at: new Date().toISOString() }))
    ctx.hooks.on('line:stop', p => push({ kind: 'line:stop', lineId: p?.lineId, at: new Date().toISOString() }))

    ctx.route('GET', '/recent', () => ({
      plugin: ctx.name,
      recent: ctx.kv.get('recent') ?? [],
    }))
  },
}
