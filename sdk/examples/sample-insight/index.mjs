/**
 * sample-insight — SDK 示例插件(服务端面)。
 * 订阅下发级数采采样计数,并暴露插件 API:GET /api/plugins/sample-insight/stats
 * 完整指南见 docs/plugins.md。
 */
export default {
  name: 'sample-insight',
  version: '1.0.0',
  description: 'SDK 示例:数采采样计数 + 统计 API + 客户端徽标',

  async setup(ctx) {
    ctx.logger.info('示例插件已装载 —— daq:sample 计数中')

    ctx.hooks.on('daq:sample', (s) => {
      ctx.kv.bump('samples')
      if (s?.nodeId) ctx.kv.set(`last:${s.nodeId}`, { value: s.value, at: s.at })
    })

    ctx.hooks.on('line:start', (p) => {
      ctx.logger.info(`产线开跑: ${p?.lineId}`)
      ctx.kv.set('lineRunning', true)
    })

    ctx.hooks.on('line:stop', () => ctx.kv.set('lineRunning', false))

    ctx.route('GET', '/stats', () => ({
      plugin: ctx.name,
      version: ctx.sdkVersion,
      samples: ctx.kv.get('samples') ?? 0,
      lineRunning: ctx.kv.get('lineRunning') ?? false,
      scope: ctx.scope,
    }))

    ctx.route('POST', '/reset', () => {
      ctx.kv.set('samples', 0)
      return { ok: true }
    })
  },
}
