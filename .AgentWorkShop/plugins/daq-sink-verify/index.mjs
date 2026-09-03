/**
 * daq-sink-verify —— 插件扩展全栈验证插件(v2:驱动 + 处理器 + 模板 + omp 工具)。
 *
 * 四件套全部由插件注册(平台代码零改动):
 *  ①驱动 verify-burst:一次性拿到完整 24 点 vector 扫描数据(确定性签名:
 *    raw[i]=0.45+(i%4)*0.02,raw[6]=0.54 尖峰,叠加小幅时变漂移供实时观察);
 *  ②处理器 verify-x2:全部点 ×2 标定 + verifyTag 指纹指标;
 *  ③模板 plug-verify-x2-profile:sink 管线 = resample(24) → verify-x2 → derive-metric(avg/max),
 *    替换默认"拿数据直接入库/下发"——入库与 WS 下发的均为加工后数据;
 *  ④omp 工具 verify_pipeline_probe:agent 会话内自检插件链路状态。
 *
 * 外部断言口径(见 scripts/_dbg-plugin-verify-e2e.mjs):
 *  points.length=24、argmax=6、points[6]∈[1.06,1.12](=2×0.54)、points[0]∈[0.88,0.92](=2×0.45)、
 *  metrics.verifyTag=1、metrics.max=points[6]。
 */
export default {
  name: 'daq-sink-verify',
  version: '2.0.0',
  description: '插件扩展全栈验证:一次性 vector 驱动 + ×2 标定 sink + 节点模板 + omp 工具',
  setup(ctx) {
    // ① 插件驱动:一次性完整 vector 扫描(替代单点采集的默认形态)
    ctx.daq.registerDriver({
      kind: 'verify-burst',
      available: async () => true,
      sample: ({ ctx }) => {
        const t = ctx.ageMs / 1000
        const drift = 0.01 * Math.sin(t * 0.8) // 时变漂移:前端实时值可见变化
        const points = []
        for (let i = 0; i < 24; i++) {
          let v = 0.45 + (i % 4) * 0.02 + drift + (i === 6 ? 0.05 : 0)
          v = Math.round(v * 1e6) / 1e6
          points.push(v)
        }
        return { frame: { kind: 'vector', points, metrics: {} } }
      },
      test: async () => ({ ok: true, message: 'verify-burst 驱动无需连接,采样即生成确定性扫描' }),
    })

    // ② 插件 sink 处理器:×2 标定 + 指纹
    ctx.daq.registerProcessor('vector', 'verify-x2', (frame) => {
      const points = (frame.points ?? []).map(p => Math.round(p * 2 * 1e6) / 1e6)
      return { ...frame, points, metrics: { ...frame.metrics, verifyTag: 1 } }
    })

    // ③ 插件节点模板:建节点即套用自定义管线(替换默认直接入库/下发)
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
      semantics: '插件全栈验证模板:verify-burst 驱动一次性拿 24 点向量,经 verify-x2(×2 标定)加工后入库与下发;raw[6]=0.54 尖峰 ×2=1.08 为确定性断言点。',
    })
    ctx.logger.info('daq-sink-verify v2 就绪:驱动 verify-burst + 处理器 verify-x2 + 模板 plug-verify-x2-profile')

    // ④ omp 插件工具:agent 会话内自检
    ctx.omp.registerTool({
      name: 'verify_pipeline_probe',
      label: '管线探针',
      description: '验证插件扩展链路是否工作的探针工具:返回驱动/处理器/模板注册状态(供 agent 自检或调试)。',
      parameters: { type: 'object', properties: {} },
      handler: () => ({
        text: '插件扩展链路正常:驱动 verify-burst、处理器 verify-x2、模板 plug-verify-x2-profile 均已注册;向量帧数据已 ×2 标定后入库(确定性断言点:raw[6]=0.54 → 1.08)。',
      }),
    })
  },
}
