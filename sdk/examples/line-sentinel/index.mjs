/**
 * line-sentinel — 产线哨兵(真实场景插件)
 * ------------------------------------------------------------
 * 职责:持续监视运行中产线的数采样本,越过告警阈值即记录并在 API 暴露;
 * 心跳定时器自证存活;监听产线启停与配置变更;展示 SDK 全部能力面。
 *
 * 使用 SDK 面:ctx.hooks · ctx.api(平台客户端) · ctx.timer(自动回收)
 *            · ctx.onDispose · ctx.kv · ctx.route · ctx.config.onChange
 *            · ctx.events · ctx.logger
 */
export default {
  name: 'line-sentinel',
  version: '1.0.0',
  description: '产线哨兵:数采越限告警 + 心跳 + 产线生命周期跟踪',
  client: './client.mjs',

  async setup(ctx) {
    ctx.logger.info(`装载完成(scope=${ctx.scope}, sdk=${ctx.sdkVersion})`)

    // 平台服务消费:启动时经 SDK API 客户端读取产线清单(自环调用)
    try {
      const lines = await ctx.api.lines.list()
      ctx.kv.set('linesTotal', Array.isArray(lines) ? lines.length : 0)
      ctx.logger.info(`平台产线清单: ${ctx.kv.get('linesTotal')} 条`)
    }
    catch (err) {
      ctx.logger.warn('产线清单读取失败(服务启动中,跳过):', err?.message)
    }

    // 配置变更订阅(aw config set / 设置页写入 → runtime-settings.json 变化)
    ctx.config.onChange(() => {
      const theme = ctx.config.get('theme.primaryColor')
      ctx.logger.info(`配置已变更,当前主题色: ${theme}`)
      ctx.kv.set('lastConfigAt', new Date().toISOString())
    })

    // 产线生命周期跟踪(事件消费增强:运行中产线计数)
    ctx.hooks.on('line:start', (p) => {
      ctx.kv.set('running', true)
      ctx.kv.bump('runningCount')
      ctx.kv.set('lastRun', { lineId: p?.lineId, at: new Date().toISOString() })
      ctx.logger.info(`▶ 产线开跑 ${p?.lineId}`)
    })
    ctx.hooks.on('line:stop', () => {
      ctx.kv.set('running', false)
      ctx.logger.info('■ 产线停止')
    })

    // 核心:数采样本越限告警(阈值可经插件 KV 配置,默认 180)
    ctx.hooks.on('daq:sample', (s) => {
      ctx.kv.bump('samples')
      const threshold = Number(ctx.kv.get('threshold')) || 180
      if (typeof s?.value === 'number' && s.value > threshold) {
        const key = `alarm:${s.nodeId}`
        const prev = ctx.kv.get(key) ?? { count: 0 }
        ctx.kv.set(key, { count: (prev.count ?? 0) + 1, value: s.value, at: s.at })
        if ((prev.count ?? 0) === 0) ctx.logger.warn(`⚠ 越限告警 ${s.nodeId}: ${s.value} > ${threshold}`)
      }
    })

    // scene 实时事件订阅(糖衣)
    ctx.events.on('daq.node.changed', (p) => {
      ctx.logger.debug?.('节点变更', p?.op ?? '')
    })

    // 心跳定时器(服务关闭自动回收):活性自证经免鉴权 manifest ping 验证 REST 自环通道
    ctx.timer.setInterval(() => {
      ctx.kv.set('heartbeat', new Date().toISOString())
      ctx.api.plugins.manifest()
        .then(() => ctx.kv.set('apiOk', true))
        .catch(() => ctx.kv.set('apiOk', false))
    }, 5000)

    // 清理登记(关停时宿主逐个调用)
    ctx.onDispose(() => ctx.logger.info('哨兵清理:告警状态已随 KV 落盘'))

    // 插件 API:综合报告
    ctx.route('GET', '/report', () => {
      const alarms = Object.entries(ctx.kv.all())
        .filter(([k]) => k.startsWith('alarm:'))
        .map(([k, v]) => ({ nodeId: k.slice(6), ...v }))
      return {
        plugin: ctx.name,
        version: ctx.version,
        running: ctx.kv.get('running') ?? false,
        runningCount: ctx.kv.get('runningCount') ?? 0,
        heartbeat: ctx.kv.get('heartbeat'),
        apiChannel: ctx.kv.get('apiOk') === true ? 'ok' : ctx.kv.get('apiOk') === false ? 'down' : 'pending',
        samplesWatched: ctx.kv.get('samples') ?? 0,
        threshold: Number(ctx.kv.get('threshold')) || 180,
        alarms,
      }
    })

    ctx.route('POST', '/threshold', (event) => {
      // 宿主 catchall 已预读 body 挂在 event.awBody
      const v = Number(event.awBody?.threshold) || 180
      ctx.kv.set('threshold', v)
      return { ok: true, threshold: v }
    })
  },
}
