/**
 * 内置 Agent 模板与内置编组常量
 * (由 server/services/workshop/db/database.ts 按职责拆出;内容逐行原文搬运)
 */

export const DEFAULT_AGENT_TEMPLATES: Array<{ id: string, name: string, harness: string, config: Record<string, unknown> }> = [
  { id: 'tpl-default-lead', name: '开发主管', harness: 'mock', config: { role: 'lead', intro: '统筹任务拆解与进度调度,分配 worker 执行' } },
  { id: 'tpl-default-backend', name: '后端工程师', harness: 'mock', config: { role: 'worker', intro: '负责服务端接口、数据与集成逻辑' } },
  { id: 'tpl-default-frontend', name: '前端工程师', harness: 'mock', config: { role: 'worker', intro: '负责页面、交互与前端工程' } },
  { id: 'tpl-default-qa', name: '测试工程师', harness: 'mock', config: { role: 'worker', intro: '负责用例设计与质量验证' } },
  { id: 'tpl-default-docs', name: '文档撰写', harness: 'mock', config: { role: 'worker', intro: '负责说明、报告与文档沉淀' } },
  // 特定场景 lead 模板:带 systemPromptPrefix 预设,用户添加为 lead 时场景提示词自动注入 harness
  {
    id: 'tpl-scenario-payment-lead',
    name: '支付网关交付主管(场景:高并发支付)',
    harness: 'omp',
    config: {
      role: 'lead',
      intro: '支付网关专项交付 lead;已预设高并发支付场景系统提示',
      systemPromptPrefix: [
        '你是支付网关专项交付组的 Lead 主管,负责拆解并推进支付网关的端到端交付。',
        '## 场景背景',
        '本团队聚焦高并发支付网关:订单支付、退款、对账、风控与降级预案。',
        '## 你的调度原则',
        '1. 每次只拆解当前最有价值的一个子任务,交给最空闲的 worker,不要并行铺开。',
        '2. 子任务须包含明确的验收标准(接口契约/性能指标/失败路径)。',
        '3. 支付类需求默认考虑:幂等、超时兜底、对账一致与限流降级。',
        '4. worker 完成一个任务后要复核其成果是否满足验收标准,不满足则补充分发。',
        '## 交付红线',
        '涉及资金与订单状态的变更,必须以 artifact 显式标注幂等键与回滚方案;任何不确定项先 ask 用户确认。',
      ].join('\n'),
    },
  },
]

/** 默认 AgentTeam(成员引用上述模板 id) */
export const DEFAULT_TEAMS: Array<{ id: string, name: string, description: string, members: Array<{ templateId: string, role: 'lead' | 'worker' }> }> = [
  {
    id: 'team-default-fullstack',
    name: '全栈交付组',
    description: '默认编组:主管 + 后端 + 前端 + 测试,开箱即可部署到 Channel',
    members: [
      { templateId: 'tpl-default-lead', role: 'lead' },
      { templateId: 'tpl-default-backend', role: 'worker' },
      { templateId: 'tpl-default-frontend', role: 'worker' },
      { templateId: 'tpl-default-qa', role: 'worker' },
    ],
  },
  {
    id: 'team-default-docs',
    name: '文档维护组',
    description: '默认编组:文档撰写(lead)+ 测试复核,适合文档与发布场景',
    members: [
      { templateId: 'tpl-default-docs', role: 'lead' },
      { templateId: 'tpl-default-qa', role: 'worker' },
    ],
  },
]

/** 内置 Channel 模板成员条目(members_json 元素) */
