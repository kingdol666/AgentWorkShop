/**
 * aw-matrix-plugin —— 全链路自定义下沉处理插件(矩阵验收用,独立于示例插件)。
 *
 * 用户自定义数据控制模板的完整形态:
 *  ①自定义驱动 matrix-thermo:连真实模拟工况(HTTP 设备 http://127.0.0.1:1889/api/value),
 *    驱动内嵌自定义补偿算法(y = 1.02x + 0.5,两位小数)——"连接设备 + 自定义算法"一体;
 *  ②自定义处理器 matrix-derate:scalar 通道降额加工(value>阈值时削峰 + derateTag 指纹);
 *  ③自定义模板 plug-matrix-profile:建节点即套用 sink 管线
 *    (matrix-derate → derive-metric(avg) → derive-metric(max)),替换默认直通路径;
 *  ④omp 工具 matrix_pipeline_probe:agent 会话内自检;
 *  ⑤自定义 REST 路由 /api/plugins/aw-matrix-plugin/stats:暴露 daq:sample 钩子计数
 *    (插件观测面,验证数据确实流经插件)。
 *
 * 验收口径(见 scripts/_dbg-plugin-matrix.mjs):
 *  节点入库值 ≈ 1.02×42.5+0.5 = 43.85±1.5(非原始 42.5,证明自定义算法生效);
 *  WS 帧同值;metrics.avg/max 存在;stats 路由 samples>0;omp 工具注册可见。
 */
export default {
  name: 'aw-matrix-plugin',
  version: '1.0.0',
  description: '自定义数据控制模板全链路:自定义驱动(连模拟工况)+降额处理器+节点模板+Agent 工具+观测路由',
  setup(ctx) {
    const stats = { samples: 0, frames: 0, lastValue: null, installedAt: new Date().toISOString() }

    // 钩子观测面:每一个流经平台的采样都计数(默认路径之外插件可自定下沉)
    ctx.hooks.on('daq:sample', (payload) => {
      stats.samples += 1
      const v = payload?.sample?.value ?? payload?.value
      if (typeof v === 'number') stats.lastValue = v
    })
    ctx.hooks.on('daq:frame', () => {
      stats.frames += 1
    })

    // ① 自定义驱动:连真实模拟工况(HTTP 设备) + 内嵌补偿算法
    //  标量契约:驱动返回裸 number(帧信封仅 vector/image)
    ctx.daq.registerDriver({
      kind: 'matrix-thermo',
      available: async () => true,
      sample: async () => {
        const res = await fetch('http://127.0.0.1:1889/api/value', { signal: AbortSignal.timeout(3000) })
        const json = await res.json()
        const raw = Number(json?.data?.value)
        if (!Number.isFinite(raw)) throw new Error('matrix-thermo:模拟工况返回非数值')
        // 自定义补偿算法(用户可替换的任意处理逻辑)
        return Math.round((raw * 1.02 + 0.5) * 100) / 100
      },
      test: async () => {
        try {
          const res = await fetch('http://127.0.0.1:1889/api/value', { signal: AbortSignal.timeout(3000) })
          const json = await res.json()
          return { ok: res.ok && Number.isFinite(Number(json?.data?.value)), message: `matrix-thermo → 模拟工况可达(原始值 ${json?.data?.value})` }
        }
        catch (err) {
          return { ok: false, message: `matrix-thermo → 模拟工况不可达: ${err instanceof Error ? err.message : String(err)}` }
        }
      },
    })

    // ② 自定义处理器:scalar 降额(>48 削峰到 48)+ 指纹
    ctx.daq.registerProcessor('scalar', 'matrix-derate', (frame) => {
      const capped = typeof frame.value === 'number' && frame.value > 48 ? 48 : frame.value
      return { ...frame, value: capped, metrics: { ...frame.metrics, derateTag: 1 } }
    })

    // ③ 自定义模板:sink 管线(自定义处理器 + 内置指标派生)
    ctx.daq.registerTemplate({
      key: 'plug-matrix-profile',
      name: '矩阵验收标定模板(插件)',
      code: 'MTX · CAL',
      ch: '补偿标定流量',
      unit: 'm³/h',
      base: 42.5,
      amp: 0.5,
      min: 38,
      max: 50,
      decimals: 2,
      icon: 'gateway',
      signalKind: 'scalar',
      sink: {
        processors: [
          { name: 'matrix-derate' },
          { name: 'derive-metric', args: { name: 'avg', op: 'avg' } },
          { name: 'derive-metric', args: { name: 'max', op: 'max' } },
        ],
      },
      metrics: [
        { key: 'avg', label: '补偿均值', unit: 'm³/h' },
        { key: 'max', label: '峰值', unit: 'm³/h' },
      ],
      semantics: '矩阵验收模板:matrix-thermo 驱动连真实 HTTP 模拟工况,经补偿(1.02x+0.5)与降额(matrix-derate)后入库/下发;metrics.avg/max 随帧落时序库。',
    })

    // ④ omp 工具
    ctx.omp.registerTool({
      name: 'matrix_pipeline_probe',
      label: '矩阵管线探针',
      description: '返回 aw-matrix-plugin 的驱动/处理器/模板/钩子计数状态(供 agent 自检或调试)。',
      parameters: { type: 'object', properties: {} },
      handler: () => ({
        text: `aw-matrix-plugin 管线状态:驱动 matrix-thermo(连 127.0.0.1:1889 模拟工况)、处理器 matrix-derate、模板 plug-matrix-profile 已注册;daq:sample 钩子计数=${stats.samples},最近值=${stats.lastValue ?? '-'}`,
      }),
    })

    // ⑤ 自定义 REST 路由:观测面(挂 /api/plugins/aw-matrix-plugin/**)
    ctx.route('GET', '/stats', () => ({
      status: 200,
      body: { ok: true, plugin: 'aw-matrix-plugin', ...stats },
    }))

    ctx.logger.info(`aw-matrix-plugin v1.0.0 就绪:驱动 matrix-thermo + 处理器 matrix-derate + 模板 plug-matrix-profile + 工具 matrix_pipeline_probe + 路由 /stats`)
  },
}
