/**
 * omp-sensor-tools —— omp 自定义工具示例插件。
 *
 * 演示 ctx.omp.registerTool:注册一个团队可用的 host 工具「sensor_calibration_log」,
 * agent 在 omp 会话中原生调用(工具 schema 自动注入,运行时热生效——无需重启 agent)。
 * handler 收到 (args, agent 上下文);返回 { text, isError? } 即工具结果。
 */
const KV = new Map()

export default {
  name: 'omp-sensor-tools',
  version: '1.0.0',
  description: 'omp 自定义工具示例:传感器标定记录本(登记/查询)',
  setup(ctx) {
    ctx.omp.registerTool({
      name: 'sensor_calibration_log',
      label: '标定记录本',
      description: '团队传感器标定记录本:登记或查询各传感器的标定结论(标定系数/有效期/负责人)。作业中涉及历史标定信息时调用,避免重复标定或误用过期系数。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['get', 'put', 'list'],
            description: 'get=查单条;put=登记;list=列全部',
          },
          sensor: { type: 'string', description: '传感器标识(如 厚度仪-01);action=get/put 必填' },
          note: { type: 'string', description: 'action=put 时的标定结论(系数/有效期/负责人)' },
        },
        required: ['action'],
      },
      roles: ['lead', 'worker'],
      handler: async (args, agent) => {
        const action = String(args.action ?? 'list')
        if (action === 'list') {
          if (KV.size === 0) return { text: '标定记录本为空。可用 action=put 登记第一条(agent=个人信息,团队共享)。' }
          const lines = [...KV.entries()].map(([k, v]) => `- ${k}: ${v}`)
          return { text: `标定记录(${KV.size} 条):\n${lines.join('\n')}` }
        }
        const sensor = String(args.sensor ?? '').trim()
        if (!sensor) return { text: 'sensor 必填(如 厚度仪-01)。', isError: true }
        if (action === 'get') {
          const hit = KV.get(sensor)
          return hit
            ? { text: `${sensor} 标定记录: ${hit}` }
            : { text: `${sensor} 无标定记录。可用 action=put 登记。` }
        }
        const note = String(args.note ?? '').trim()
        if (!note) return { text: 'action=put 时 note 必填(标定结论)。', isError: true }
        KV.set(sensor, note)
        ctx.logger.info(`标定记录登记: ${sensor}(by ${agent.name})`)
        return { text: `已登记 ${sensor} 的标定结论(当前共 ${KV.size} 条;进程内存储,重启后清空——接入持久化请改用 ctx.kv)。` }
      },
    })
    ctx.logger.info('omp-sensor-tools 就绪:工具 sensor_calibration_log 已对 lead/worker 全体 agent 生效')
  },
}
