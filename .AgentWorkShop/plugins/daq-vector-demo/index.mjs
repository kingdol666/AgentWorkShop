/**
 * daq-vector-demo —— 帧处理器 + 自定义节点模板示例(v2 多形态数采)。
 *
 * 演示两个扩展点:
 *  ①ctx.daq.registerProcessor:注册向量帧处理器「demo-roughness」
 *    (滑动窗口极差 → roughness 派生指标);
 *  ②ctx.daq.registerTemplate:注册使用该处理器的完整节点模板
 *    「plug-demo-粗糙度轮廓」—— 插件装载后即可在 /daq 模板目录/创建向导中选择,
 *    采集到的数据按模板 sink 管线自动下沉加工(入库 + WS 下发均为加工后数据)。
 * 插件热重载幂等(同名覆盖)。
 */
export default {
  name: 'daq-vector-demo',
  version: '1.1.0',
  description: '向量帧处理器 + 自定义节点模板示例(粗糙度派生指标)',
  setup(ctx) {
    // ① 自定义下沉处理器:任意 vector 模板的 sink 都可引用
    ctx.daq.registerProcessor('vector', 'demo-roughness', (frame, args) => {
      const points = frame.points ?? []
      const win = Math.max(2, Math.min(64, Number(args?.window) || 8))
      if (points.length < win) return frame
      let worst = 0
      for (let i = 0; i + win <= points.length; i++) {
        const seg = points.slice(i, i + win)
        const range = Math.max(...seg) - Math.min(...seg)
        if (range > worst) worst = range
      }
      return {
        ...frame,
        metrics: { ...frame.metrics, roughness: Math.round(worst * 1e6) / 1e6 },
      }
    })

    // ② 自定义节点模板:sink 引用上面的处理器 + 指标阈值告警
    //    建节点后入库(metrics/点列均为加工后数据)与 WS 下发自动生效
    ctx.daq.registerTemplate({
      key: 'plug-demo-roughness',
      name: '粗糙度轮廓仪(插件示例)',
      code: 'ROUGH · DEMO',
      ch: '表面粗糙度轮廓',
      unit: 'mm',
      base: 0.52,
      amp: 0.02,
      min: 0.4,
      max: 0.65,
      decimals: 4,
      icon: 'tension',
      signalKind: 'vector',
      vector: { points: 32, min: 0.4, max: 0.65 },
      sink: {
        processors: [
          { name: 'resample', args: { n: 32 } },
          { name: 'demo-roughness', args: { window: 8 } },
          { name: 'derive-metric', args: { name: 'avg', op: 'avg' } },
        ],
      },
      metrics: [
        { key: 'roughness', label: '粗糙度', unit: 'mm', warnHigh: 0.012, alarmHigh: 0.02 },
      ],
      semantics: '插件示例模板:表面轮廓粗糙度判读。roughness=滑动窗口最大极差,越限提示表面质量劣化;完整点列供前端轮廓图查看。',
    })
    ctx.logger.info('daq-vector-demo 就绪:处理器 demo-roughness + 模板 plug-demo-roughness 已注册')
  },
}
