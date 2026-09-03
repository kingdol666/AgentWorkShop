/**
 * workshop 持久化层入口(node:sqlite)
 * - openWorkshopDb: 打开(或创建)数据库 → PRAGMA(WAL/foreign_keys)→ 建表 + 增量迁移
 * - 行类型:repo 返回的原始 sqlite 行(JSON 列以字符串存储,由上层按需 parseJson)
 *
 * 数据模型(v5:Agent 模板 + AgentTeam 编组 + Channel 实例分离):
 * - agents:         全局可复用 Agent 模板(仅 name/harness/config/enabled,无 channel 绑定)
 * - teams:          AgentTeam(Agent 模板编组,可整体批量部署到 channel)
 * - team_members:   team × agent 模板 成员关系(role 标记部署时采用 lead/worker 角色)
 * - channel_agents: Channel 中的 Agent 实例(每次放入 channel 都克隆出新身份 id,
 *                   name/harness/config 从模板复制,另含独立 role + token)
 * - subscriptions:  订阅按 (channel, 实例, target) 隔离
 * - agent_memories: Agent 持久记忆(FTS5 索引,per-agent 域 + team 共享)
 */
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import type * as sqliteVec from 'sqlite-vec'

const require = createRequire(import.meta.url)

/**
 * 建表 SQL(与 schema.sql 保持同步;内联字符串而非运行时读文件,
 * 避免 Nitro 打包后相对路径失效——schema.sql 保留为源码文档)。
 */
const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS channels (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  scenario_prompt TEXT NOT NULL DEFAULT '',  -- v6:channel 级作业场景 prompt(全员注入)
  lead_agent_id  TEXT,
  workspace      TEXT NOT NULL DEFAULT '',
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  harness     TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  visibility  TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'public'(owner_user_id NULL = 内置公共,不可变更)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_agents (
  id          TEXT PRIMARY KEY,                -- 实例身份 id(每次放入 channel 独立生成)
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES agents(id) ON DELETE SET NULL,  -- 来源模板(可空)
  name        TEXT NOT NULL,                   -- 从模板复制
  harness     TEXT NOT NULL,                   -- 从模板复制
  config_json TEXT NOT NULL DEFAULT '{}',      -- 从模板复制
  role        TEXT NOT NULL DEFAULT 'worker',  -- 'lead' | 'worker'(按 channel 独立)
  token       TEXT NOT NULL,                   -- MCP 身份凭证(实例级 UUIDv4)
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_agents_token ON channel_agents(token);
CREATE INDEX IF NOT EXISTS idx_channel_agents_channel ON channel_agents(channel_id);
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  task_id       TEXT,
  from_agent_id TEXT,
  to_agent_id   TEXT,
  role          TEXT NOT NULL,                -- 'ROLE_USER' | 'ROLE_AGENT'
  parts_json    TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',   -- x-aw-target-agent / x-aw-task-kind
  state         TEXT NOT NULL DEFAULT 'pending',  -- pending|consuming|consumed
  created_at    TEXT NOT NULL,
  consumed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_queue ON messages(channel_id, to_agent_id, state, created_at);
CREATE TABLE IF NOT EXISTS subscriptions (
  channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES channel_agents(id) ON DELETE CASCADE,
  target_agent_id TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (channel_id, agent_id, target_agent_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  channel_id     TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  parent_id      TEXT,
  assignee_id    TEXT NOT NULL,               -- 实例身份 id(不再 FK 到 agents)
  creator_id     TEXT,
  title          TEXT NOT NULL,
  description    TEXT,
  state          TEXT NOT NULL,               -- SUBMITTED|ASSIGNED|WORKING|WAITING|COMPLETED|FAILED|CANCELED
  progress       INTEGER NOT NULL DEFAULT 0,  -- 0-100
  retry_count    INTEGER NOT NULL DEFAULT 0,  -- 重派次数(SchedulerLoop reassign 时 +1,>=3 停止重派)
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  history_json   TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, state);
-- 调度快照/队列视图热查询:listByChannelAssignee(channel+assignee ORDER BY created_at)
CREATE INDEX IF NOT EXISTS idx_tasks_channel_assignee ON tasks(channel_id, assignee_id, state, created_at);
-- 子任务聚合(dispatch 判重/complete 闸门/onChildCompleted 统计;childrenOf 热查询)
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility  TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'public'(owner_user_id NULL = 内置公共,不可变更)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'worker',  -- 'lead' | 'worker'(部署到 channel 时采用的实例角色)
  created_at  TEXT NOT NULL,
  PRIMARY KEY (team_id, template_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);

-- v6:Agent 持久记忆(agent_memories)+ FTS5 全文索引。
-- per-agent 记忆域(agent_id 过滤隔离);团队共享行 agent_id='__team__'(常量 TEAM_AGENT_ID)。
-- dedup_key 唯一约束去重(含 channel_id:team 哨兵行跨 channel 各自独立):任务 'task:<id>' / 协作 'peer:<msgId>' / 策展 'manual:<uuid>' / 团队任意。
-- kind:episodic-task/episodic-peer(harvest)/semantic(REST 人工策展,衰减豁免)。
-- vec0 向量表不在此建:需 sqlite-vec 扩展且维度运行时才知(P1 Task 7 延迟建)。

CREATE TABLE IF NOT EXISTS agent_memories (
  id               TEXT PRIMARY KEY,
  channel_id       TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,               -- 原文,供展示
  title_fts        TEXT NOT NULL DEFAULT '',    -- CJK 切分副本,FTS 索引用(V8)
  content          TEXT NOT NULL,               -- 已 CJK 切分的存储文本
  importance       REAL NOT NULL DEFAULT 0.5,
  task_id          TEXT,
  dedup_key        TEXT NOT NULL,
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE(agent_id, dedup_key, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON agent_memories(agent_id, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_fts USING fts5(
  title, content, agent_id UNINDEXED, memory_rowid UNINDEXED
);
CREATE TRIGGER IF NOT EXISTS trg_agent_memories_ai AFTER INSERT ON agent_memories BEGIN
  INSERT INTO agent_memories_fts(title, content, agent_id, memory_rowid)
  VALUES (new.title_fts, new.content, new.agent_id, new.rowid);
END;
CREATE TRIGGER IF NOT EXISTS trg_agent_memories_ad AFTER DELETE ON agent_memories BEGIN
  DELETE FROM agent_memories_fts WHERE memory_rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS trg_agent_memories_au AFTER UPDATE ON agent_memories BEGIN
  DELETE FROM agent_memories_fts WHERE memory_rowid = old.rowid;
  INSERT INTO agent_memories_fts(title, content, agent_id, memory_rowid)
  VALUES (new.title_fts, new.content, new.agent_id, new.rowid);
END;

-- v7:用户级隔离(users + workspaces + 资源 owner 列)。
-- owner_user_id 为 NULL 的资源 = 遗留数据(对所有已认证用户只读可见,变更需 owner 匹配)。
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  token       TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,  -- 归属用户(全局用户系统 id;原 FK 已随全局用户集成移除)
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);
-- v8:AEP 事件持久化(hub publish 同步落库;时间线历史由 server 驱动,与 client 无关)
CREATE TABLE IF NOT EXISTS channel_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  at           TEXT NOT NULL,
  agent_id     TEXT,
  task_id      TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE(channel_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_channel_events_channel ON channel_events(channel_id, seq DESC);

CREATE TABLE IF NOT EXISTS workspace_channels (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, channel_id)
);
-- v10:Channel 模板(场景 + 工作目录 + 团队编组的可复用组合;实例化 = 一键建 channel 并装配成员)。
-- lead_json:内联 lead 定义 {name,harness,config}(空串 = 无 lead);
-- members_json:[{templateId,role}](引用 Agent 模板)或 [{inline:{name,harness,config},role}](内联成员)。
-- owner_user_id NULL = 内置公共模板(visibility 恒 public,任何人不可修改删除)。
CREATE TABLE IF NOT EXISTS channel_templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  scenario_prompt TEXT NOT NULL DEFAULT '',
  workspace       TEXT NOT NULL DEFAULT '',
  lead_json       TEXT NOT NULL DEFAULT '',
  members_json    TEXT NOT NULL DEFAULT '[]',
  visibility      TEXT NOT NULL DEFAULT 'private',
  owner_user_id   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_templates_owner ON channel_templates(owner_user_id);
-- v11:工具审批历史(S4:HITL 裁决留痕——进程内 pending 之外的持久化,重启可查)
CREATE TABLE IF NOT EXISTS approval_history (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,               -- 'dcw' | 'daq'
  detail       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL,               -- pending|approved|denied|expired
  comment      TEXT NOT NULL DEFAULT '',
  decided_by   TEXT NOT NULL DEFAULT '',    -- 裁决人(用户 id;空 = 超时/系统收敛)
  decided_name TEXT NOT NULL DEFAULT '',    -- 裁决人名(呈现用)
  created_at   TEXT NOT NULL,
  decided_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_approval_history_created ON approval_history(created_at DESC);
-- v12:DAQ 报警事件 + ack 闭环(S5:报警持久化/确认/升级)
CREATE TABLE IF NOT EXISTS alarm_events (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL,
  node_name     TEXT NOT NULL DEFAULT '',
  metric        TEXT NOT NULL DEFAULT '',   -- 触发量名(如 temp)
  value         REAL,
  rule          TEXT NOT NULL DEFAULT '',   -- 'lt-min' | 'gt-max'
  threshold     REAL,
  acked_by      TEXT NOT NULL DEFAULT '',
  acked_at      TEXT,
  escalation    INTEGER NOT NULL DEFAULT 0, -- 未确认升级通知次数
  notified_json TEXT NOT NULL DEFAULT '[]', -- 外送记录 [{url,ok,at,attempt}]
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alarm_events_created ON alarm_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alarm_events_open ON alarm_events(created_at DESC) WHERE acked_at IS NULL;
-- v13:结构化审计日志(R1:谁/何时/对什么/做了什么)
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT NOT NULL DEFAULT '',
  actor_name  TEXT NOT NULL DEFAULT '',
  actor_kind  TEXT NOT NULL DEFAULT 'user', -- 'user' | 'agent' | 'system'
  action      TEXT NOT NULL,
  target_kind TEXT NOT NULL DEFAULT '',
  target_id   TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  at          TEXT NOT NULL,
  -- 运维日志(OpsLog)维度列:按产线/产品/Recipe 隔离查询 + 分类 + 人读摘要
  line_id     TEXT NOT NULL DEFAULT '',
  product_id  TEXT NOT NULL DEFAULT '',
  recipe_id   TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT '',     -- write|manual|alarm|line|recipe|rollback|daq|system
  summary     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at DESC);
-- v14:高危管理操作双人复核(R3:maker-checker;config 开关默认关)
CREATE TABLE IF NOT EXISTS approval_requests (
  id            TEXT PRIMARY KEY,
  action        TEXT NOT NULL,              -- 'recipe.apply' | 'controller.toggle' | 'node.delete'
  target_id     TEXT NOT NULL,
  payload_json  TEXT NOT NULL DEFAULT '{}',
  summary       TEXT NOT NULL DEFAULT '',
  requested_by  TEXT NOT NULL,
  requested_name TEXT NOT NULL DEFAULT '',
  requested_at  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|approved|denied
  decided_by    TEXT NOT NULL DEFAULT '',
  decided_name  TEXT NOT NULL DEFAULT '',
  decided_at    TEXT,
  comment       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status, requested_at DESC);`

// ===== 默认种子数据(首轮初始化注入;owner NULL = 公共资源,所有登录用户只读共享) =====

/** 默认 Agent 模板(id 固定,幂等) */
const DEFAULT_AGENT_TEMPLATES: Array<{ id: string, name: string, harness: string, config: Record<string, unknown> }> = [
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
const DEFAULT_TEAMS: Array<{ id: string, name: string, description: string, members: Array<{ templateId: string, role: 'lead' | 'worker' }> }> = [
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
type BuiltinChannelMember = { templateId: string, role: 'lead' | 'worker' } | { inline: { name: string, harness: string, config: Record<string, unknown> }, role: 'lead' | 'worker' }

/** 默认 Channel 模板(场景 + 团队组合;实例化 = 一键建 channel 并装配成员) */
const DEFAULT_CHANNEL_TEMPLATES: Array<{
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
function seedDefaultWorkshopData(db: DatabaseSync): void {
  const now = new Date().toISOString()
  const insertAgent = db.prepare(
    'INSERT OR IGNORE INTO agents (id, name, harness, config_json, enabled, visibility, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, \'public\', NULL, ?, ?)',
  )
  for (const t of DEFAULT_AGENT_TEMPLATES) {
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
  const insertChannelTpl = db.prepare(
    'INSERT OR IGNORE INTO channel_templates (id, name, description, scenario_prompt, workspace, lead_json, members_json, visibility, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, \'\', \'\', ?, \'public\', NULL, ?, ?)',
  )
  for (const tpl of DEFAULT_CHANNEL_TEMPLATES) {
    insertChannelTpl.run(tpl.id, tpl.name, tpl.description, tpl.scenarioPrompt, JSON.stringify(tpl.members), now, now)
  }
}

/** channels 表行 */
export interface ChannelRow {
  id: string
  name: string
  description: string
  /** channel 级作业场景 prompt(注入全部成员 harness;空串 = 无场景) */
  scenarioPrompt: string
  leadAgentId: string | null
  /** channel 独立工作目录(omp 子进程 cwd;空串表示未设置) */
  workspace: string
  enabled: number
  /** 归属用户(null = 遗留数据) */
  ownerUserId: string | null
  createdAt: string
  updatedAt: string
}

/** users 表行(用户级隔离身份) */
export interface UserRow {
  id: string
  name: string
  /** 用户管理 token(Bearer;区别于 agent 实例 token) */
  token: string
  createdAt: string
}

/** channel_events 表行(AEP 事件持久化) */
export interface ChannelEventRow {
  id: number
  channelId: string
  seq: number
  type: string
  at: string
  agentId: string | null
  taskId: string | null
  payloadJson: string
}

/** workspaces 表行(服务端持久化 Workspace;按 owner 隔离) */
export interface WorkspaceRow {
  id: string
  ownerUserId: string
  name: string
  createdAt: string
}

/** agents 表行(全局 Agent 模板,无 channel 绑定) */
export interface AgentRow {
  id: string
  name: string
  harness: string
  configJson: string
  enabled: number
  /** 可见性:'private' 仅属主 | 'public' 全员可读可用(owner NULL = 内置,恒 public 不可变更) */
  visibility: string
  /** 归属用户(null = 内置公共模板) */
  ownerUserId: string | null
  createdAt: string
  updatedAt: string
}

/** teams 表行(AgentTeam:Agent 模板的编组,可整体部署到 channel) */
export interface TeamRow {
  id: string
  name: string
  description: string
  /** 可见性:'private' 仅属主 | 'public' 全员可读可用(owner NULL = 内置,恒 public 不可变更) */
  visibility: string
  /** 归属用户(null = 内置公共模板) */
  ownerUserId: string | null
  createdAt: string
  updatedAt: string
}

/**
 * channel_templates 表行(Channel 模板:场景 + 工作目录 + 成员组合)。
 * membersJson 元素:{templateId, role} 引用 Agent 模板 | {inline:{name,harness,config}, role} 内联定义。
 */
export interface ChannelTemplateRow {
  id: string
  name: string
  description: string
  scenarioPrompt: string
  workspace: string
  leadJson: string
  membersJson: string
  visibility: string
  ownerUserId: string | null
  createdAt: string
  updatedAt: string
}

/** team_members 表行(team × agent 模板 成员关系;role 为部署时采用的实例角色) */
export interface TeamMemberRow {
  teamId: string
  templateId: string
  role: string
  createdAt: string
}

/**
 * 记忆类别:episodic-task/episodic-peer/episodic-session/episodic-team-task(harvest 族,
 * 参与过期+淘汰)/ semantic(知识,免衰减)/ brief/chronicle/reflection(策展层,
 * 免向量化免维护)。TEXT 自由列(无 CHECK),联合类型仅约束调用面。
 */
export type MemoryKind
  = | 'episodic-task'
    | 'episodic-peer'
    | 'episodic-session'
    | 'episodic-team-task'
    | 'semantic'
    | 'brief'
    | 'chronicle'
    | 'reflection'

/** agent_memories 表行(content 为已 CJK 切分存储文本;agentId='__team__' 为团队共享行) */
export interface MemoryRow {
  id: string
  channelId: string
  agentId: string
  kind: MemoryKind
  title: string
  content: string
  importance: number
  taskId: string | null
  accessCount: number
  lastAccessedAt: string | null
  createdAt: string
}
/** channel_agents 表行(Channel 中的 Agent 实例:独立身份 id + 复制自模板的字段) */
export interface ChannelAgentRow {
  id: string
  channelId: string
  templateId: string | null
  name: string
  harness: string
  configJson: string
  role: string
  token: string
  enabled: number
  createdAt: string
  updatedAt: string
}

/** messages 表行 */
export interface MessageRow {
  id: string
  channelId: string
  taskId: string | null
  fromAgentId: string | null
  toAgentId: string | null
  role: string
  partsJson: string
  metadataJson: string
  state: 'pending' | 'consuming' | 'consumed'
  createdAt: string
  consumedAt: string | null
}

/** subscriptions 表行(channel_id + agent_id + target_agent_id 复合主键) */
export interface SubscriptionRow {
  channelId: string
  agentId: string
  targetAgentId: string
  createdAt: string
}

/** tasks 表行 */
export interface TaskRow {
  id: string
  channelId: string
  parentId: string | null
  assigneeId: string
  creatorId: string | null
  title: string
  description: string | null
  state: string
  progress: number
  retryCount: number
  artifactsJson: string
  historyJson: string
  routeReason: string
  createdAt: string
  updatedAt: string
}

/**
 * 打开(或创建)workshop 数据库并完成初始化。
 * path 传 ':memory:' 即为内存库(测试用);落盘库由上层决定路径。
 */
export function openWorkshopDb(path: string): DatabaseSync {
  // allowExtension + 尝试加载 sqlite-vec(向量检索);失败静默降级纯 FTS(受控环境可能禁扩展)
  const db = new DatabaseSync(path, { allowExtension: true })
  try {
    const { getLoadablePath } = require('sqlite-vec') as typeof sqliteVec
    db.loadExtension(getLoadablePath())
  }
  catch {
    // 扩展不可用:记忆系统自动退化为 FTS-only(vecInit 将失败并禁用向量)
  }
  initWorkshopDb(db)
  return db
}

/** 对已打开的库执行初始化:WAL + 外键约束 + 建表 + 增量迁移 */
export function initWorkshopDb(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;')
  // S6:synchronous=NORMAL(WAL 推荐档)——与 TSDB 仿真库对齐;断电最多丢最后一个事务,不损坏库
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA_SQL)
  migrateLegacySchema(db)
  migrateAddColumn(db, 'channels', 'scenario_prompt', 'TEXT NOT NULL DEFAULT \'\'')
  // 派发路由理由(koda RouteDecision 借鉴):lead 派发留痕"为什么派给他",供审计与前端呈现
  migrateAddColumn(db, 'tasks', 'route_reason', 'TEXT NOT NULL DEFAULT \'\'')
  // v10:模板可见性列(既有库补列;默认 private,仅属主可见)
  migrateAddColumn(db, 'agents', 'visibility', 'TEXT NOT NULL DEFAULT \'private\'')
  migrateAddColumn(db, 'teams', 'visibility', 'TEXT NOT NULL DEFAULT \'private\'')
  // 回填:内置/遗留公共模板(owner NULL)强制 public —— 升级后保持全员可读可用
  db.exec('UPDATE agents SET visibility = \'public\' WHERE owner_user_id IS NULL')
  db.exec('UPDATE teams SET visibility = \'public\' WHERE owner_user_id IS NULL')
  // 运维日志(OpsLog)维度列:既有库补列(新库由上方 DDL 直建)
  migrateAddColumn(db, 'audit_log', 'line_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'audit_log', 'product_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'audit_log', 'recipe_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'audit_log', 'kind', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'audit_log', 'summary', 'TEXT NOT NULL DEFAULT \'\'')
  migrateMissingForeignKeys(db)
  migrateDropOwnerFks(db)
  seedDefaultWorkshopData(db)
}

/** 通用加列迁移:列不存在时 ALTER TABLE ADD COLUMN(CREATE IF NOT EXISTS 不升级既有表) */
function migrateAddColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }
}

/** 检测表上是否存在 指向某表的列级外键 */
function hasForeignKey(db: DatabaseSync, table: string, from: string, refTable: string): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ from: string, table: string }>
  return rows.some(r => r.from === from && r.table === refTable)
}

/**
 * v3 → v4 迁移:补齐 tasks/subscriptions 缺失的外键。
 * 早期版本(v1→v3 迁移产物、旧建表脚本)的这两张表没有 REFERENCES ... ON DELETE CASCADE,
 * 而 CREATE TABLE IF NOT EXISTS 不会升级既有表 → channel 删除时 tasks/subscriptions 成孤儿数据。
 * 重建前先清除孤儿行(其 channel 已不存在,不可达;新外键会使 INSERT 失败)。
 */
function migrateMissingForeignKeys(db: DatabaseSync): void {
  const needTasks = !hasForeignKey(db, 'tasks', 'channel_id', 'channels')
  const needSubs = !hasForeignKey(db, 'subscriptions', 'channel_id', 'channels')
  if (!needTasks && !needSubs) return

  db.exec('PRAGMA foreign_keys = OFF;')
  try {
    if (needTasks) {
      db.exec(`DELETE FROM tasks WHERE channel_id NOT IN (SELECT id FROM channels);
      CREATE TABLE tasks_new (
        id             TEXT PRIMARY KEY,
        channel_id     TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        parent_id      TEXT,
        assignee_id    TEXT NOT NULL,
        creator_id     TEXT,
        title          TEXT NOT NULL,
        description    TEXT,
        state          TEXT NOT NULL,
        progress       INTEGER NOT NULL DEFAULT 0,
        retry_count    INTEGER NOT NULL DEFAULT 0,
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        history_json   TEXT NOT NULL DEFAULT '[]',
        route_reason   TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      INSERT INTO tasks_new SELECT id, channel_id, parent_id, assignee_id, creator_id, title, description, state, progress, retry_count, artifacts_json, history_json, route_reason, created_at, updated_at FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      -- 重建后索引必须与 SCHEMA_SQL 对齐:漏建则热查询退化为全表扫描(route_reason 列
      -- 由 migrateAddColumn 先于本函数添加,SELECT 引用安全)
      CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id, state);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, state);
      CREATE INDEX IF NOT EXISTS idx_tasks_channel_assignee ON tasks(channel_id, assignee_id, state, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);`)
    }
    if (needSubs) {
      db.exec(`DELETE FROM subscriptions
        WHERE channel_id NOT IN (SELECT id FROM channels)
           OR agent_id NOT IN (SELECT id FROM channel_agents);
      CREATE TABLE subscriptions_new (
        channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        agent_id        TEXT NOT NULL REFERENCES channel_agents(id) ON DELETE CASCADE,
        target_agent_id TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (channel_id, agent_id, target_agent_id)
      );
      INSERT INTO subscriptions_new SELECT channel_id, agent_id, target_agent_id, created_at FROM subscriptions;
      DROP TABLE subscriptions;
      ALTER TABLE subscriptions_new RENAME TO subscriptions;`)
    }
  }
  finally {
    db.exec('PRAGMA foreign_keys = ON;')
  }
}

/**
 * v9(全局用户集成)迁移:剥离 owner_user_id 对本地 users 表的 FK。
 * 身份与 token 已迁移至全局用户系统(data/users.sqlite),owner 列仅存用户 id 引用,
 * 保留 FK 会使新全局用户 id 在本地 users 表无行而写入失败。
 * 表重建期间临时关闭外键,避免 DROP 触发级联;重建后以原名重新命名,引用方 FK 依旧有效。
 */
function migrateDropOwnerFks(db: DatabaseSync): void {
  const rebuilds: Array<{ table: string, ddl: string }> = []
  if (hasForeignKey(db, 'workspaces', 'owner_user_id', 'users')) {
    rebuilds.push({
      table: 'workspaces',
      ddl: `CREATE TABLE workspaces_new (
          id            TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL,
          name          TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );
        INSERT INTO workspaces_new SELECT id, owner_user_id, name, created_at FROM workspaces;`,
    })
  }
  if (hasForeignKey(db, 'channels', 'owner_user_id', 'users')) {
    rebuilds.push({
      table: 'channels',
      ddl: `CREATE TABLE channels_new (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          description    TEXT NOT NULL DEFAULT '',
          lead_agent_id  TEXT,
          workspace      TEXT NOT NULL DEFAULT '',
          enabled        INTEGER NOT NULL DEFAULT 1,
          owner_user_id  TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        );
        INSERT INTO channels_new SELECT id, name, description, lead_agent_id, workspace, enabled, owner_user_id, created_at, updated_at FROM channels;`,
    })
  }
  if (hasForeignKey(db, 'agents', 'owner_user_id', 'users')) {
    rebuilds.push({
      table: 'agents',
      ddl: `CREATE TABLE agents_new (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          harness      TEXT NOT NULL,
          config_json  TEXT NOT NULL DEFAULT '{}',
          enabled      INTEGER NOT NULL DEFAULT 1,
          visibility   TEXT NOT NULL DEFAULT 'private',
          owner_user_id TEXT,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        );
        INSERT INTO agents_new SELECT id, name, harness, config_json, enabled, visibility, owner_user_id, created_at, updated_at FROM agents;`,
    })
  }
  if (hasForeignKey(db, 'teams', 'owner_user_id', 'users')) {
    rebuilds.push({
      table: 'teams',
      ddl: `CREATE TABLE teams_new (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          description   TEXT NOT NULL DEFAULT '',
          owner_user_id TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
        INSERT INTO teams_new SELECT id, name, description, owner_user_id, created_at, updated_at FROM teams;`,
    })
  }
  if (rebuilds.length === 0) return

  db.exec('PRAGMA foreign_keys = OFF;')
  try {
    for (const { table, ddl } of rebuilds) {
      db.exec(`${ddl}
        DROP TABLE ${table};
        ALTER TABLE ${table}_new RENAME TO ${table};`)
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);`)
  }
  finally {
    db.exec('PRAGMA foreign_keys = ON;')
  }
}

/**
 * 旧库迁移到 v3。仅当 agents 仍含 channel_id 列(v1:agents 内嵌 channel_id/role/token)时执行。
 * 迁移过程临时关闭外键,避免 DROP TABLE 触发级联;v1 的 agent id 保留为实例 id,
 * 使 messages/tasks/subscriptions 对 agent 的既有引用继续有效。
 */
function migrateLegacySchema(db: DatabaseSync): void {
  const channelsCols = db.prepare(`PRAGMA table_info(channels)`).all() as Array<{ name: string }>
  if (!channelsCols.some(c => c.name === 'workspace')) {
    db.exec(`ALTER TABLE channels ADD COLUMN workspace TEXT NOT NULL DEFAULT ''`)
  }
  // v7:用户隔离 owner 列(幂等;默认 NULL = 遗留公共数据)。
  // v9(全局用户集成):owner 引用改为全局用户系统 id,不再加 REFERENCES(避免跨库 FK)。
  if (!channelsCols.some(c => c.name === 'owner_user_id')) {
    db.exec(`ALTER TABLE channels ADD COLUMN owner_user_id TEXT`)
  }
  // v7:用户隔离 owner 列(幂等;默认 NULL = 遗留公共数据)。
  // v9(全局用户集成):owner 引用改为全局用户系统 id,不再加 REFERENCES(避免跨库 FK)。
  const agentsColsV7 = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>
  if (!agentsColsV7.some(c => c.name === 'owner_user_id')) {
    db.exec(`ALTER TABLE agents ADD COLUMN owner_user_id TEXT`)
  }
  const teamsColsV7 = db.prepare(`PRAGMA table_info(teams)`).all() as Array<{ name: string }>
  if (!teamsColsV7.some(c => c.name === 'owner_user_id')) {
    db.exec(`ALTER TABLE teams ADD COLUMN owner_user_id TEXT`)
  }

  const agentCols = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>
  const isV1 = agentCols.some(c => c.name === 'channel_id')
  if (!isV1) return

  db.exec('PRAGMA foreign_keys = OFF;')
  try {
    // 1. subscriptions 补 channel_id(从旧 agents.channel_id 推导),agent_id 指向实例
    const subCols = db.prepare(`PRAGMA table_info(subscriptions)`).all() as Array<{ name: string }>
    if (!subCols.some(c => c.name === 'channel_id')) {
      db.exec(`CREATE TABLE subscriptions_new (
        channel_id      TEXT NOT NULL,
        agent_id        TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (channel_id, agent_id, target_agent_id)
      );
      INSERT INTO subscriptions_new (channel_id, agent_id, target_agent_id, created_at)
        SELECT a.channel_id, s.agent_id, s.target_agent_id, s.created_at
        FROM subscriptions s JOIN agents a ON a.id = s.agent_id
        WHERE s.target_agent_id IS NOT NULL;
      DROP TABLE subscriptions;
      ALTER TABLE subscriptions_new RENAME TO subscriptions;`)
    }

    // 2. channel_agents ← v1 agents(id 保留为实例 id;template_id 置空)
    db.exec(`INSERT INTO channel_agents (id, channel_id, template_id, name, harness, config_json, role, token, enabled, created_at, updated_at)
      SELECT id, channel_id, NULL, name, harness, config_json, role, token, enabled, created_at, updated_at FROM agents;`)

    // 3. tasks 去 assignee_id 的 agents FK(旧库指向 agents,现指向实例 id)
    db.exec(`CREATE TABLE tasks_new (
      id             TEXT PRIMARY KEY,
      channel_id     TEXT NOT NULL,
      parent_id      TEXT,
      assignee_id    TEXT NOT NULL,
      creator_id     TEXT,
      title          TEXT NOT NULL,
      description    TEXT,
      state          TEXT NOT NULL,
      progress       INTEGER NOT NULL DEFAULT 0,
      retry_count    INTEGER NOT NULL DEFAULT 0,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      history_json   TEXT NOT NULL DEFAULT '[]',
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    INSERT INTO tasks_new SELECT id, channel_id, parent_id, assignee_id, creator_id, title, description, state, progress, retry_count, artifacts_json, history_json, created_at, updated_at FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;
    CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id, state);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, state);`)

    // 4. agents 重建为模板表(旧数据已迁到 channel_agents,模板表清空)
    db.exec(`CREATE TABLE agents_new (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      harness     TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    DROP TABLE agents;
    ALTER TABLE agents_new RENAME TO agents;`)
  }
  finally {
    db.exec('PRAGMA foreign_keys = ON;')
  }
}

/** 解析 JSON 列;解析失败返回 fallback(默认值) */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback
  try {
    return JSON.parse(text) as T
  }
  catch {
    return fallback
  }
}
