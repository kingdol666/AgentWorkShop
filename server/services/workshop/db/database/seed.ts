/**
 * 内置 Channel 模板常量与首启种子写入
 * (由 server/services/workshop/db/database.ts 按职责拆出;内容逐行原文搬运)
 */
import { AML_AGENT_TEMPLATES, AML_TEAM } from '../aml-team-seeds'
import { DEFAULT_AGENT_TEMPLATES, DEFAULT_TEAMS } from './seed-data'
import type { DatabaseSync } from 'node:sqlite'

export type BuiltinChannelMember = { templateId: string, role: 'lead' | 'worker' } | { inline: { name: string, harness: string, config: Record<string, unknown> }, role: 'lead' | 'worker' }

/** 默认 Channel 模板(场景 + 团队组合;实例化 = 一键建 channel 并装配成员) */
export const DEFAULT_CHANNEL_TEMPLATES: Array<{
  id: string
  name: string
  description: string
  scenarioPrompt: string
  members: BuiltinChannelMember[]
}> = [
  {
    id: 'chtpl-default-fullstack',
    name: '全栈交付通道',
    description: '内置模板:主管带队 + 后端/前端/测试,适合常规交付任务',
    scenarioPrompt: '团队按主管调度协作交付;每个子任务完成后由主管复核,产出统一沉淀为 artifact。',
    members: [
      { templateId: 'tpl-default-lead', role: 'lead' },
      { templateId: 'tpl-default-backend', role: 'worker' },
      { templateId: 'tpl-default-frontend', role: 'worker' },
      { templateId: 'tpl-default-qa', role: 'worker' },
    ],
  },
  {
    id: 'chtpl-default-review',
    name: '文档评审通道',
    description: '内置模板:文档撰写 + 测试复核,适合文档、报告与评审场景',
    scenarioPrompt: '以文档产出与质量复核为主线;撰写完成后由复核角色检查并反馈修改意见。',
    members: [
      { templateId: 'tpl-default-docs', role: 'lead' },
      { templateId: 'tpl-default-qa', role: 'worker' },
    ],
  },
  {
    id: 'chtpl-preset-optical-film',
    name: '光学薄膜涂布产线优化组',
    description: '工业场景预设:涂布产线数字孪生优化 —— 生产主管 + 工艺工程师 + 数据分析师,面向烘箱温控与涂层质量闭环',
    scenarioPrompt: `## 产线场景:光学薄膜涂布产线(精密涂布车间)
本团队服务于一条光学薄膜涂布产线:PET 基材经放卷 → 电晕处理 → 精密涂布(光学胶)→ 烘箱多段干燥 → 收卷,成品为显示面板用光学级薄膜。烘箱温度是涂层厚度均匀性与气泡缺陷的第一工艺根因;供胶/熔体系统压力波动反映输胶健康度,与温度耦合影响流平效果。
质量目标:涂层厚度均匀性 ±2% 以内,无气泡/橘皮缺陷;能耗约束下避免过热降解。产线的数控节点(烘箱温度设定等)与数采节点(涂布温度/系统压力等)已实时接入数字孪生;节点按产线分色渲染,操作前必须先调用 my_industrial_nodes 理解授权节点的物理意义、安全量程与活动配方工艺窗口。

## 团队分工(每位成员按此定位协作)
- 生产主管(lead):理解用户优化目标 → 拆解为「数据分析」与「工艺调整」子任务并派发 → 复核成员结论(必须带数据证据)→ 汇总汇报;不直接操作节点,协调跨成员信息(如把数据分析师的越限发现转给工艺工程师处置)。
- 工艺工程师(worker):持有数控节点授权 —— 用 daq_query 取证 → 判定设定-响应关系 → 在「安全量程 ∩ 配方窗口」内小步幅下发 dcw_control(单变量调整);手动确认模式节点先说明理由等用户批准;调整后等待热惯性响应再复测。
- 数据分析师(worker):持有数采节点授权 —— 用 daq_query 获取时序数据(支持按产品/配方/时间窗过滤),输出趋势/均值/极值/越限统计与工况判读(区分设定-响应滞后与真实异常);发现越限或异常趋势第一时间用 send_message_to_agent 通报 lead 与工艺工程师。
协作规则:引用数值必带单位与时间窗;结论不确定时先补数据再下判断;所有阶段性结论沉淀为任务交付物。

## 作业纪律
数据先行(先看数再动手)→ 窗口内小步幅(单次 ≤ 量程 2%)→ 单变量调整 → 复测闭环(调整后等待工艺响应再评估,不连续大幅调整)→ 异常先判读再行动 → 结论必附数据证据。任何成员不得越权操作未绑定节点。`,
    members: [
      { templateId: 'tpl-default-lead', role: 'lead' },
      { inline: { name: '工艺工程师', harness: 'omp', config: { rpcMode: 'rpc', systemPromptPrefix: '你是光学薄膜涂布产线的工艺工程师,精通烘箱多段温控与涂层质量的关联。操作数控节点的标准流程:my_industrial_nodes 理解节点 → daq_query 取证 → dcw_control 在配方窗口内小步幅下发 → 等待热惯性后复测。手动确认模式下发前必须说明理由。结论一律引用带单位与时间窗的数据。' } }, role: 'worker' },
      { inline: { name: '数据分析师', harness: 'omp', config: { rpcMode: 'rpc', systemPromptPrefix: '你是光学薄膜涂布产线的数据分析师,擅长时序数据判读与工况诊断。用 daq_query 获取授权数采节点数据,输出趋势/统计/越限分析,判读时结合同产线数控设定考虑设定-响应滞后;发现越限或异常趋势立即通报 lead 与工艺工程师。结论一律引用具体数值。' } }, role: 'worker' },
    ],
  },
  {
    id: 'chtpl-preset-extrusion',
    name: '薄膜挤出流延产线优化组',
    description: '工业场景预设:挤出流延产线数字孪生优化 —— 生产主管 + 工艺工程师 + 数据分析师,面向熔体压力/温度耦合控制',
    scenarioPrompt: `## 产线场景:薄膜挤出流延产线(挤出车间)
本团队服务于一条薄膜挤出流延产线:原料经计量混料 → 螺杆挤出塑化 → 熔体泵计量 → 挤出模头流延 → 冷辊定型 → 测厚 → 收卷。熔体压力稳定性是挤出质量的脉搏:压力波动直接导致膜厚纵向偏差;熔体温度决定塑化质量,过热引发降解发黄、过低塑化不良。压力与温度强耦合(温度升高黏度下降、压力响应滞后),调参必须单变量小步幅。
质量目标:膜厚纵向偏差 ≤ ±3%,无晶点/发黄;注意螺杆与熔体泵的机械损耗征兆(压力基线漂移)。产线的数控节点(熔体温度设定等)与数采节点(熔体压力/熔体温度等)已接入数字孪生;操作前必须先调用 my_industrial_nodes 理解授权节点。

## 团队分工(每位成员按此定位协作)
- 生产主管(lead):承接用户优化目标 → 拆解派发子任务 → 复核数据证据 → 汇总汇报;协调信息流(数据侧发现 → 工艺侧处置 → 数据侧复测确认);不直接操作节点。
- 工艺工程师(worker):持有数控节点授权 —— 温度/转速设定调整遵循「先看数、小步幅、单变量、等响应」;目标值必须在安全量程与活动配方工艺窗口内;手动确认模式先说明理由等用户批准。
- 数据分析师(worker):持有数采节点授权 —— 监控压力/温度时序,识别基线漂移、周期性波动(螺杆脉动)与越限报警;为工艺调整提供前后对照证据;异常立即通报。
协作规则:引用数值必带单位与时间窗;跨成员信息经 send_message_to_agent 传递;结论沉淀为任务交付物。

## 作业纪律
数据先行 → 窗口内小步幅(单次 ≤ 量程 2%)→ 单变量调整(温度与转速禁止同时调)→ 复测闭环 → 压力异常优先判读(滤网堵塞倾向 vs 温度耦合 vs 真实波动)→ 结论必附数据证据。任何成员不得越权操作未绑定节点。`,
    members: [
      { templateId: 'tpl-default-lead', role: 'lead' },
      { inline: { name: '工艺工程师', harness: 'omp', config: { rpcMode: 'rpc', systemPromptPrefix: '你是薄膜挤出流延产线的工艺工程师,精通熔体压力/温度耦合控制与流延质量。操作数控节点:my_industrial_nodes → daq_query 取证 → dcw_control 窗口内小步幅(温度与转速禁同调)→ 等响应后复测。结论引用带单位与时间窗的数据。' } }, role: 'worker' },
      { inline: { name: '数据分析师', harness: 'omp', config: { rpcMode: 'rpc', systemPromptPrefix: '你是薄膜挤出流延产线的数据分析师,擅长熔体压力/温度时序判读。用 daq_query 输出趋势/统计/越限分析,识别基线漂移与周期波动;结合同线数控设定考虑耦合与滞后;异常立即通报 lead 与工艺工程师。结论引用具体数值。' } }, role: 'worker' },
    ],
  },
]

/**
 * 默认模板与编组注入:
 * - 固定 id + INSERT OR IGNORE,每次初始化幂等执行(重启安全;已有库补种,新库直接种)
 * - owner_user_id = NULL + visibility = 'public':内置公共模板,所有用户可读可用,任何人(含 admin)不可修改删除
 */
export function seedDefaultWorkshopData(db: DatabaseSync): void {
  const now = new Date().toISOString()
  const insertAgent = db.prepare(
    'INSERT OR IGNORE INTO agents (id, name, harness, config_json, enabled, visibility, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, \'public\', NULL, ?, ?)',
  )
  for (const t of DEFAULT_AGENT_TEMPLATES) {
    insertAgent.run(t.id, t.name, t.harness, JSON.stringify(t.config), now, now)
  }
  // v15:AML 自动建模团队种子(内置公共,同款 INSERT OR IGNORE 幂等)
  for (const t of AML_AGENT_TEMPLATES) {
    insertAgent.run(t.id, t.name, t.harness, JSON.stringify(t.config), now, now)
  }
  const insertTeam = db.prepare(
    'INSERT OR IGNORE INTO teams (id, name, description, visibility, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, \'public\', NULL, ?, ?)',
  )
  const insertMember = db.prepare(
    'INSERT OR IGNORE INTO team_members (team_id, template_id, role, created_at) VALUES (?, ?, ?, ?)',
  )
  for (const team of DEFAULT_TEAMS) {
    insertTeam.run(team.id, team.name, team.description, now, now)
    for (const m of team.members) {
      insertMember.run(team.id, m.templateId, m.role, now)
    }
  }
  // v15:AML 编组种子(team + team_members 同款幂等注入)
  for (const team of [AML_TEAM]) {
    insertTeam.run(team.id, team.name, team.description, now, now)
    for (const m of team.members) {
      insertMember.run(team.id, m.templateId, m.role, now)
    }
  }
  const insertChannelTpl = db.prepare(
    'INSERT OR IGNORE INTO channel_templates (id, name, description, scenario_prompt, workspace, lead_json, members_json, visibility, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, \'\', \'\', ?, \'public\', NULL, ?, ?)',
  )
  for (const tpl of DEFAULT_CHANNEL_TEMPLATES) {
    insertChannelTpl.run(tpl.id, tpl.name, tpl.description, tpl.scenarioPrompt, JSON.stringify(tpl.members), now, now)
  }
}

/** channels 表行 */
