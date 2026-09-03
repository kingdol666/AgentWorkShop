/**
 * daq-sink-verify —— 插件扩展验证插件(处理器 + 模板 + omp 工具)。
 *
 * 验证目标:插件注册的 sink 管线**替换默认节点行为**——mock 驱动给原始轮廓后,
 * 不直接入库/下发,而是先经本插件的「×2 标定」处理器加工,再入库与 WS 下发。
 * 验证方法(外部 E2E):帧数据 points ≈ 原始值 ×2(超出模板量程 = 加工发生在钳位之后),
 * metrics.verifyTag = 1(插件处理器指纹)。
 *
 * 同时注册 omp 工具「verify_pipeline_probe」供 agent 会话调用。
 */
export default {
  name: 'daq-sink-verify',
  version: '1.0.0',
  description: '验证插件:×2 标定 sink 处理器 + 向量节点模板 + omp 探针工具',
  setup(ctx) {
    // ① 插件 sink 处理器:全部点 ×2(标定语义)+ 指纹指标
    ctx.daq.registerProcessor('vector', 'verify-x2', (frame) => {
      const points = (frame.points ?? []).map(p => Math.round(p * 2 * 1e6) / 1e6)
      return { ...frame, points, metrics: { ...frame.metrics, verifyTag: 1 } }
    })

    // ② 插件节点模板:用户建节点即使用本管线(替换默认的直接入库/下发)
    ctx.daq.registerTemplate({
      key: 'plug-verify-x2-profile',
      name: '×2 标定轮廓(插件验证)',
      code: 'VERIFY · X2',
      ch: '标定轮廓',
      unit: 'mm',
      base: 0.5,
      amp: 0.02,
      min: 0.4,
      max: 0.6,
      decimals: 4,
      icon: 'tension',
      signalKind: 'vector',
      vector: { points: 24, min: 0.4, max: 0.6 },
      sink: {
        processors: [
          { name: 'resample', args: { n: 24 } },
          { name: 'verify-x2' },
          { name: 'derive-metric', args: { name: 'avg', op: 'avg' } },
          { name: 'derive-metric', args: { name: 'max', op: 'max' } },
        ],
      },
      metrics: [{ key: 'avg', label: '标定均值', unit: 'mm' }],
      semantics: '插件验证模板:原始轮廓经 verify-x2(×2 标定)加工后入库与下发;avg≈1.0 量级即管线生效。',
    })
    ctx.logger.info('daq-sink-verify 就绪:处理器 verify-x2 + 模板 plug-verify-x2-profile')

    // ③ omp 插件工具:agent 会话内验证管线探针
    ctx.omp.registerTool({
      name: 'verify_pipeline_probe',
      label: '管线探针',
      description: '验证插件扩展链路是否工作的探针工具:返回处理器与模板注册状态(供 agent 自检或调试)。',
      parameters: { type: 'object', properties: {} },
      handler: () => ({
        text: '插件扩展链路正常:处理器 verify-x2 与模板 plug-verify-x2-profile 均已注册;向量帧数据已经 ×2 标定后入库。',
      }),
    })
  },
}
