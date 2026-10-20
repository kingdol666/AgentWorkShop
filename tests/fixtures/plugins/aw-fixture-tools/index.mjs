/**
 * 验收用插件:注册一个只读回显工具,用于验证
 * 插件安装 → 工具目录 → MCP 工具面 → Channel 选择 全链路。
 */
export default {
  name: 'aw-fixture-tools',
  version: '0.1.0',
  description: 'AgentWorkShop tool registry acceptance fixture',
  async setup(ctx) {
    ctx.omp.registerTool({
      name: 'fixture_echo',
      label: 'Fixture Echo',
      description: 'Acceptance fixture: echo the provided text. Read-only, no side effects.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'text to echo' } },
        required: ['text'],
        additionalProperties: false,
      },
      roles: ['lead', 'worker'],
      handler: async args => ({ text: `fixture:${String(args.text ?? '')}` }),
    })
    ctx.logger.info('fixture_echo registered')
  },
}
