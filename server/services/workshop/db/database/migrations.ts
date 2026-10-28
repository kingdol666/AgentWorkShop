/**
 * 历史库迁移(v17 群聊、补列、外键、遗留 schema)
 * (由 server/services/workshop/db/database.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DatabaseSync } from 'node:sqlite'

export function migrateGroupChatV17(db: DatabaseSync): void {
  migrateAddColumn(db, 'channels', 'visibility', 'TEXT NOT NULL DEFAULT \'private\'')
  migrateAddColumn(db, 'channels', 'join_policy', 'TEXT NOT NULL DEFAULT \'owner_approve\'')
  migrateAddColumn(db, 'channels', 'approval_policy', 'TEXT NOT NULL DEFAULT \'owner_only\'')
  migrateAddColumn(db, 'channels', 'chat_enabled', 'INTEGER NOT NULL DEFAULT 0')
  migrateAddColumn(db, 'channels', 'version', 'INTEGER NOT NULL DEFAULT 1')
  // v18:Channel 绑定产线(空串=未绑定;只读扩权面,见 ops-tools agentOpsScope)
  migrateAddColumn(db, 'channels', 'line_id', 'TEXT NOT NULL DEFAULT \'\'')
  // 规范化非法值(历史手改/测试数据):未知取值一律回落到最保守档,不放宽权限
  db.exec(`UPDATE channels SET visibility = 'private' WHERE visibility NOT IN ('private', 'public')`)
  db.exec(`UPDATE channels SET join_policy = 'owner_approve' WHERE join_policy NOT IN ('open', 'owner_approve')`)
  db.exec(`UPDATE channels SET approval_policy = 'owner_only' WHERE approval_policy NOT IN ('owner_only', 'any_member')`)
  db.exec('UPDATE channels SET chat_enabled = 0 WHERE chat_enabled NOT IN (0, 1)')
  // owner 成员记录回填(幂等):owner 非 NULL 且尚无 owner 成员行时补一条 active
  try {
    db.exec(`INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, status, generation, joined_at, left_at)
             SELECT id, owner_user_id, 'owner', 'active', 1, created_at, NULL
             FROM channels WHERE owner_user_id IS NOT NULL`)
  }
  catch {
    // 表尚未建(极端半初始化库):下一次 init 会再次尝试
  }
  // 不变量收敛:owner 行存在但被标成非 active/非 owner 时纠正(保证「有且只有一条 active owner」)
  try {
    db.exec(`UPDATE channel_members SET role = 'owner', status = 'active', left_at = NULL
             WHERE (channel_id, user_id) IN (
               SELECT c.id, c.owner_user_id FROM channels c WHERE c.owner_user_id IS NOT NULL
             )`)
  }
  catch {
    // 同上:容错,不阻断启动
  }
}

/** 通用加列迁移:列不存在时 ALTER TABLE ADD COLUMN(CREATE IF NOT EXISTS 不升级既有表) */
export function migrateAddColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }
}

/**
 * v31(2026-10-24 WP3):agent token 轮换宽限列。
 * 轮换时把旧 token 与其失效时刻写入 prev_token/prev_token_until,宽限窗内双接受
 * (桥进程 60s 内自动重连);过期后旧 token 彻底 401。
 * 加列式迁移:既有库安全,历史行 prev_token 为空 = 无宽限。
 */
export function migrateAgentTokenGraceColumns(db: DatabaseSync): void {
  migrateAddColumn(db, 'channel_agents', 'prev_token', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'channel_agents', 'prev_token_until', 'TEXT NOT NULL DEFAULT \'\'')
}

/**
 * v33(2026-10-28):频道执行模式列(observe/manual/auto;计划 docs/plans/2026-10-28-execution-modes-plan.md M1)。
 * 加列式迁移:既有库安全,历史行 NULL = 按 auto(频道层中性,不额外收紧)生效,升级零行为变化。
 */
export function migrateChannelExecutionModeColumn(db: DatabaseSync): void {
  migrateAddColumn(db, 'aml_channel_profiles', 'execution_mode', 'TEXT')
}

/**
 * 产线 Co-Pilot P2:审批历史结构化载荷列(加列式迁移,既有行安全 —— 历史行
 * payload_json 为 NULL、choice 为 NULL,读取层按「空则文本降级」处理,不回填改史)。
 * payload_json = 整包方案审批单的方案集+预检结果;choice = 批准时选定的包下标。
 */
export function migrateApprovalPayloadColumns(db: DatabaseSync): void {
  migrateAddColumn(db, 'approval_history', 'payload_json', 'TEXT')
  migrateAddColumn(db, 'approval_history', 'choice', 'INTEGER')
}

/**
 * 产线日志显式域标识(2026-10-19):scope=line|system。
 * 老库**首次补列**时按 line_id 回填(有产线=line,无产线=system);之后每次启动只做
 * 不变量收敛「scope=line 必须有 line_id」—— 缺锚点的行降级为 system,防止无归属行
 * 混入产线日志。已补列的库不再改写 scope,保留写入方显式给出的 system/line 语义。
 */
export function migrateAuditScopeColumn(db: DatabaseSync): void {
  const existed = (db.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>).some(c => c.name === 'scope')
  migrateAddColumn(db, 'audit_log', 'scope', 'TEXT NOT NULL DEFAULT \'system\'')
  if (!existed) {
    db.exec('UPDATE audit_log SET scope = \'line\' WHERE scope = \'system\' AND line_id <> \'\'')
  }
  db.exec('UPDATE audit_log SET scope = \'system\' WHERE scope = \'line\' AND line_id = \'\'')
}

/**
 * 产线日志查询索引(2026-10-19):ops-logs 默认只查产线域,常用过滤是
 * scope / line_id / recipe_id + 时间倒序。索引必须在该表补列迁移之后创建
 * (老库先跑 migrateAddColumn,否则 CREATE INDEX 会因缺列中断初始化)。
 */
export function migrateAuditQueryIndexes(db: DatabaseSync): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_scope_at ON audit_log(scope, at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_line_at ON audit_log(line_id, at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_recipe_at ON audit_log(recipe_id, at DESC)')
}

/** AgentTeam guardrail task metadata; additive and safe for existing task rows. */
export function migrateAgentTeamTaskGuardrailColumns(db: DatabaseSync): void {
  migrateAddColumn(db, 'tasks', 'source_chat_message_id', 'TEXT')
  migrateAddColumn(db, 'tasks', 'source_chat_delivery_id', 'TEXT')
  migrateAddColumn(db, 'tasks', 'close_reason', 'TEXT')
  migrateAddColumn(db, 'tasks', 'deadline_at', 'TEXT')
  migrateAgentTeamTaskQueueColumns(db)
  migrateAgentTeamExecutionLeaseColumns(db)
}

/**
 * 执行交接栅栏列(§2.1/§5.1)。加列式迁移,对既有行安全:
 * 历史行 generation=0 且无 lease —— assertAssignmentFence 对"无 lease"任务一律放行,
 * 因此升级后不会把在途的旧 worker 事件误判为迟到。
 */
export function migrateAgentTeamExecutionLeaseColumns(db: DatabaseSync): void {
  migrateAddColumn(db, 'tasks', 'assignment_generation', 'INTEGER NOT NULL DEFAULT 0')
  migrateAddColumn(db, 'tasks', 'execution_lease_id', 'TEXT')
  migrateAddColumn(db, 'tasks', 'execution_lease_agent_id', 'TEXT')
  migrateAddColumn(db, 'tasks', 'execution_lease_started_at', 'TEXT')
  migrateAddColumn(db, 'tasks', 'execution_lease_revoked_at', 'TEXT')
}

/** AgentTeam root FIFO metadata; additive and safe for legacy task rows. */
export function migrateAgentTeamTaskQueueColumns(db: DatabaseSync): void {
  migrateAddColumn(db, 'tasks', 'root_queue_seq', 'INTEGER')
  // Deterministically backfill legacy roots; children remain NULL.
  db.exec(`UPDATE tasks AS current SET root_queue_seq = (
    SELECT COUNT(*) FROM tasks AS prior
    WHERE prior.channel_id = current.channel_id
      AND prior.parent_id IS NULL
      AND (prior.created_at < current.created_at
        OR (prior.created_at = current.created_at AND prior.rowid <= current.rowid))
  ) WHERE current.parent_id IS NULL AND current.root_queue_seq IS NULL`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_root_queue ON tasks(channel_id, parent_id, root_queue_seq, state);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_root_queue_seq
    ON tasks(channel_id, root_queue_seq) WHERE parent_id IS NULL AND root_queue_seq IS NOT NULL`)
}

export function migrateAgentTeamTaskGuardrails(db: DatabaseSync): void {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_root_source_chat_message
    ON tasks(channel_id, source_chat_message_id)
    WHERE parent_id IS NULL AND source_chat_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_root_queue ON tasks(channel_id, parent_id, root_queue_seq, state);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_root_queue_seq
      ON tasks(channel_id, root_queue_seq) WHERE parent_id IS NULL AND root_queue_seq IS NOT NULL`)
}

/** 检测表上是否存在 指向某表的列级外键 */
export function hasForeignKey(db: DatabaseSync, table: string, from: string, refTable: string): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ from: string, table: string }>
  return rows.some(r => r.from === from && r.table === refTable)
}

/**
 * v3 → v4 迁移:补齐 tasks/subscriptions 缺失的外键。
 * 早期版本(v1→v3 迁移产物、旧建表脚本)的这两张表没有 REFERENCES ... ON DELETE CASCADE,
 * 而 CREATE TABLE IF NOT EXISTS 不会升级既有表 → channel 删除时 tasks/subscriptions 成孤儿数据。
 * 重建前先清除孤儿行(其 channel 已不存在,不可达;新外键会使 INSERT 失败)。
 */
export function migrateMissingForeignKeys(db: DatabaseSync): void {
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
        root_queue_seq INTEGER,
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
        source_chat_message_id  TEXT,
        source_chat_delivery_id TEXT,
        close_reason   TEXT,
        deadline_at    TEXT,
        assignment_generation      INTEGER NOT NULL DEFAULT 0,
        execution_lease_id         TEXT,
        execution_lease_agent_id   TEXT,
        execution_lease_started_at TEXT,
        execution_lease_revoked_at TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      INSERT INTO tasks_new SELECT id, channel_id, parent_id, root_queue_seq, assignee_id, creator_id, title, description, state, progress, retry_count, artifacts_json, history_json, route_reason, source_chat_message_id, source_chat_delivery_id, close_reason, deadline_at, assignment_generation, execution_lease_id, execution_lease_agent_id, execution_lease_started_at, execution_lease_revoked_at, created_at, updated_at FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      -- 重建后索引必须与 SCHEMA_SQL 对齐:漏建则热查询退化为全表扫描(route_reason 列
      -- 由 migrateAddColumn 先于本函数添加,SELECT 引用安全)
      CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id, state);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, state);
      CREATE INDEX IF NOT EXISTS idx_tasks_channel_assignee ON tasks(channel_id, assignee_id, state, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_root_queue ON tasks(channel_id, parent_id, root_queue_seq, state);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_root_queue_seq ON tasks(channel_id, root_queue_seq) WHERE parent_id IS NULL AND root_queue_seq IS NOT NULL;`)
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
 *
 * 2026-10-28 审查 D-P1-2:旧实现用**白名单 DDL** 重建 channels/agents/teams ——
 * 白名单随后续版本加列而漂移(channels 缺 scenario_prompt/llm_json/visibility/
 * join_policy/approval_policy/chat_enabled/version/line_id 共 8 列),带 owner FK 的
 * 老库升级时整列数据被静默丢弃且不可复现。现在每条重建语句都携带**完整列清单**,
 * 由 tests/migration-owner-fk.test.ts 守护:升级前后"列集 + 全部业务数据"逐列相等
 * (任一列漏抄 → 列集变化 → 测试红)。
 */
export function migrateDropOwnerFks(db: DatabaseSync): void {
  const needWorkspaces = hasForeignKey(db, 'workspaces', 'owner_user_id', 'users')
  const needChannels = hasForeignKey(db, 'channels', 'owner_user_id', 'users')
  const needAgents = hasForeignKey(db, 'agents', 'owner_user_id', 'users')
  const needTeams = hasForeignKey(db, 'teams', 'owner_user_id', 'users')
  if (!needWorkspaces && !needChannels && !needAgents && !needTeams) return

  db.exec('PRAGMA foreign_keys = OFF;')
  try {
    if (needWorkspaces) {
      db.prepare(`CREATE TABLE workspaces_new (
        id            TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        name          TEXT NOT NULL,
        created_at    TEXT NOT NULL
      )`).run()
      db.prepare('INSERT INTO workspaces_new (id, owner_user_id, name, created_at) SELECT id, owner_user_id, name, created_at FROM workspaces').run()
      db.prepare('DROP TABLE workspaces').run()
      db.prepare('ALTER TABLE workspaces_new RENAME TO workspaces').run()
    }
    if (needChannels) {
      db.prepare(`CREATE TABLE channels_new (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        scenario_prompt TEXT NOT NULL DEFAULT '',
        llm_json        TEXT NOT NULL DEFAULT '',
        lead_agent_id   TEXT,
        workspace       TEXT NOT NULL DEFAULT '',
        enabled         INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        owner_user_id   TEXT,
        visibility      TEXT NOT NULL DEFAULT 'private',
        join_policy     TEXT NOT NULL DEFAULT 'owner_approve',
        approval_policy TEXT NOT NULL DEFAULT 'owner_only',
        chat_enabled    INTEGER NOT NULL DEFAULT 0,
        version         INTEGER NOT NULL DEFAULT 1,
        line_id         TEXT NOT NULL DEFAULT ''
      )`).run()
      db.prepare(`INSERT INTO channels_new (id, name, description, scenario_prompt, llm_json, lead_agent_id,
          workspace, enabled, created_at, updated_at, owner_user_id, visibility,
          join_policy, approval_policy, chat_enabled, version, line_id)
        SELECT id, name, description, scenario_prompt, llm_json, lead_agent_id,
          workspace, enabled, created_at, updated_at, owner_user_id, visibility,
          join_policy, approval_policy, chat_enabled, version, line_id FROM channels`).run()
      db.prepare('DROP TABLE channels').run()
      db.prepare('ALTER TABLE channels_new RENAME TO channels').run()
    }
    if (needAgents) {
      db.prepare(`CREATE TABLE agents_new (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        harness       TEXT NOT NULL,
        config_json   TEXT NOT NULL DEFAULT '{}',
        enabled       INTEGER NOT NULL DEFAULT 1,
        visibility    TEXT NOT NULL DEFAULT 'private',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        owner_user_id TEXT
      )`).run()
      db.prepare('INSERT INTO agents_new (id, name, harness, config_json, enabled, visibility, created_at, updated_at, owner_user_id) SELECT id, name, harness, config_json, enabled, visibility, created_at, updated_at, owner_user_id FROM agents').run()
      db.prepare('DROP TABLE agents').run()
      db.prepare('ALTER TABLE agents_new RENAME TO agents').run()
    }
    if (needTeams) {
      db.prepare(`CREATE TABLE teams_new (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        visibility    TEXT NOT NULL DEFAULT 'private',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        owner_user_id TEXT
      )`).run()
      db.prepare('INSERT INTO teams_new (id, name, description, visibility, created_at, updated_at, owner_user_id) SELECT id, name, description, visibility, created_at, updated_at, owner_user_id FROM teams').run()
      db.prepare('DROP TABLE teams').run()
      db.prepare('ALTER TABLE teams_new RENAME TO teams').run()
    }
    // 重建会连带删除该表的索引;这 4 张表在 SCHEMA_SQL 里只有一个索引,原样补回
    db.prepare('CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id)').run()
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
export function migrateLegacySchema(db: DatabaseSync): void {
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
      root_queue_seq INTEGER,
      assignee_id    TEXT NOT NULL,
      creator_id     TEXT,
      title          TEXT NOT NULL,
      description    TEXT,
      state          TEXT NOT NULL,
      progress       INTEGER NOT NULL DEFAULT 0,
      retry_count    INTEGER NOT NULL DEFAULT 0,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      history_json   TEXT NOT NULL DEFAULT '[]',
      source_chat_message_id  TEXT,
      source_chat_delivery_id TEXT,
      close_reason   TEXT,
      deadline_at    TEXT,
      assignment_generation      INTEGER NOT NULL DEFAULT 0,
      execution_lease_id         TEXT,
      execution_lease_agent_id   TEXT,
      execution_lease_started_at TEXT,
      execution_lease_revoked_at TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    INSERT INTO tasks_new SELECT id, channel_id, parent_id, root_queue_seq, assignee_id, creator_id, title, description, state, progress, retry_count, artifacts_json, history_json, source_chat_message_id, source_chat_delivery_id, close_reason, deadline_at, assignment_generation, execution_lease_id, execution_lease_agent_id, execution_lease_started_at, execution_lease_revoked_at, created_at, updated_at FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;
    CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id, state);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, state);
    CREATE INDEX IF NOT EXISTS idx_tasks_root_queue ON tasks(channel_id, parent_id, root_queue_seq, state);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_root_queue_seq ON tasks(channel_id, root_queue_seq) WHERE parent_id IS NULL AND root_queue_seq IS NOT NULL;`)

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

/** AML Twin provider lineage on Channel profiles; additive and safe for legacy rows. */
export function migrateAmlTwinProviderColumns(db: DatabaseSync): void {
  migrateAddColumn(db, 'aml_channel_profiles', 'provider_id', 'TEXT')
  migrateAddColumn(db, 'aml_channel_profiles', 'provider_version', 'TEXT')
  migrateAddColumn(db, 'aml_channel_profiles', 'provider_hash', 'TEXT')
  migrateAddColumn(db, 'aml_channel_profiles', 'scene_pack_id', 'TEXT')
  migrateAddColumn(db, 'aml_channel_profiles', 'provider_generation', 'INTEGER')
}

/**
 * 模型人读身份面(场景/产线·配方·目标标识 + 描述 + 结构化区分);加列式迁移,既有行安全:
 * 历史模型四列为空串,展示层按「空则回退派生」处理,不回填改史。
 */
export function migrateAmlModelIdentityColumns(db: DatabaseSync): void {
  migrateAddColumn(db, 'aml_models', 'label', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'aml_models', 'description', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'aml_models', 'line_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'aml_models', 'objective_id', 'TEXT NOT NULL DEFAULT \'\'')
  // 索引必须在列存在之后建:SCHEMA_SQL 对既有库(CREATE TABLE IF NOT EXISTS 跳过建表)
  // 不保证新列已存在,放这里才能同时覆盖新库与升级库
  db.exec('CREATE INDEX IF NOT EXISTS idx_aml_models_line ON aml_models(line_id, stage)')
}

/**
 * AML 解耦:训练/工艺优化 Channel 拆分与模型绑定(2026-09-26 计划 v3)。
 * bound_model_id/bound_at:优化 Channel 绑定的 AML 模型(谱系+门禁校验通过后写入);
 * optimization_mode:工艺优化 Channel 子模式('exploration'|'aml')——探索模式对产线做
 * 受治理真实激励写入、无 MPC;aml 模式启用孪生验证/贝叶斯寻优。历史行 NULL=未设置。
 */
export function migrateAmlChannelOptimizationColumns(db: DatabaseSync): void {
  migrateAddColumn(db, 'aml_channel_profiles', 'bound_model_id', 'TEXT')
  migrateAddColumn(db, 'aml_channel_profiles', 'bound_at', 'TEXT')
  migrateAddColumn(db, 'aml_channel_profiles', 'optimization_mode', 'TEXT')
  // 探索记录表(幂等建表):优化 Channel 真实激励写入↔DAQ 响应配对,训练数据回流事实源。
  // DDL 主体在 schema.ts SCHEMA_SQL(新库);此处仅覆盖升级库的幂等建表。
  db.exec('CREATE TABLE IF NOT EXISTS optimization_explorations (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, agent_id TEXT NOT NULL, goal_json TEXT NOT NULL DEFAULT (char(123)||char(125)), control_node_id TEXT NOT NULL, control_before REAL, control_after REAL, control_step REAL, target_node_id TEXT NOT NULL, target_before REAL, target_after REAL, direction TEXT, hypothesis TEXT, write_status TEXT NOT NULL DEFAULT (char(111)||char(107)), write_message TEXT, created_at TEXT NOT NULL)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_opt_explorations_channel ON optimization_explorations(channel_id, created_at DESC)')
  // aml_training_plans 建表由 SCHEMA_SQL 的 CREATE TABLE IF NOT EXISTS 兜底(启动时全量幂等执行,新旧库同效)
}

/**
 * v27:数据分析报告人工修订列(updated_at/updated_by/updated_by_name)。
 * 既有库补列(新库由 SCHEMA_SQL 直建);无索引需求 —— 修订列只随行读,不作检索键。
 */
export function migrateAnalysisEditColumns(db: DatabaseSync): void {
  migrateAddColumn(db, 'analysis_reports', 'updated_at', 'TEXT')
  migrateAddColumn(db, 'analysis_reports', 'updated_by', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'analysis_reports', 'updated_by_name', 'TEXT NOT NULL DEFAULT \'\'')
}

/**
 * v29:Optimizer Manager + Process Model Service 的地基列(2026-10-22 计划 G1.3)。
 *
 * 新表由 SCHEMA_SQL 幂等建表覆盖;这里只补**既有表**的新列(加列式迁移,既有行安全):
 *  - aml_datasets/aml_jobs/aml_models:工件类型判别与谱系引用(历史行空串 = legacy,
 *    由 model-registry 的 resolveArtifactKindOfModel 从 metrics 推断,不伪造新语义);
 *  - twin_recommendations:legacy 标记,旧证书不追溯重算;
 *  - optimizer_bindings:channel_agents 删除时级联由 DDL 保证(FK),无需补。
 */
export function migrateOptimizerFoundationColumns(db: DatabaseSync): void {
  migrateAddColumn(db, 'aml_datasets', 'spec_ref', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'aml_datasets', 'spec_version', 'INTEGER')
  migrateAddColumn(db, 'aml_datasets', 'recipe_version', 'INTEGER')
  migrateAddColumn(db, 'aml_datasets', 'manifest_version', 'INTEGER NOT NULL DEFAULT 1')
  migrateAddColumn(db, 'aml_datasets', 'content_hash', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'aml_datasets', 'trainer_ref', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'aml_datasets', 'evidence_source', 'TEXT NOT NULL DEFAULT \'real\'')

  migrateAddColumn(db, 'aml_jobs', 'model_id', 'TEXT')
  migrateAddColumn(db, 'aml_jobs', 'trainer_ref', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'aml_jobs', 'artifact_kind', 'TEXT NOT NULL DEFAULT \'\'')

  migrateAddColumn(db, 'aml_models', 'artifact_kind', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'aml_models', 'schema_version', 'INTEGER NOT NULL DEFAULT 1')
  migrateAddColumn(db, 'aml_models', 'model_interface', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'aml_models', 'artifact_hash', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'aml_models', 'legacy', 'TEXT NOT NULL DEFAULT \'\'')
  db.exec('CREATE INDEX IF NOT EXISTS idx_aml_models_artifact ON aml_models(artifact_kind, stage)')

  migrateAddColumn(db, 'twin_recommendations', 'legacy', 'TEXT NOT NULL DEFAULT \'\'')
  // 旧证书一次性打标:历史行签发口径是末拍代价(旧 twin_v1),不重算不发新证书。
  db.exec('UPDATE twin_recommendations SET legacy = \'twin_v1\' WHERE legacy = \'\'')
  // Optimizer Profile 内容 hash(发布不可变校验);新表可能由旧版本创建,补列幂等。
  migrateAddColumn(db, 'optimizer_profiles', 'content_hash', 'TEXT NOT NULL DEFAULT \'\'')
  // 新表引用保护需要的反向索引(删除模型前按 model_ref 扫描)
  db.exec('CREATE INDEX IF NOT EXISTS idx_optimizer_profiles_model_ref ON optimizer_profiles(model_ref, status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_optimizer_bindings_agent ON optimizer_bindings(channel_agent_id, profile_id)')
}

/**
 * v30:双驱动收敛列(总计划 SW2–SW5;expand/contract —— 只加可空/带默认列,只前滚)。
 * - aml_datasets.lineage_verified:D18 数据谱系(0=未核验禁优化资格;新 builder 每 run 有 confirmed segment 才置 1)
 * - optimizer_recommendations 下发状态机(D14):dispatch_state idle→dispatched→committed→executed|failed|cancelled|denied|expired;
 *   旧行回填 idle(历史建议从未建卡,dispatched_at 派生仅供对账)
 * - optimizer_profiles.problem_ir_hashes_json:D21 多工况按 condition 冻结 hash(空 = 单 hash 旧形态)
 * - process_model_eligibility.dataset_id/dataset_hash:D20 精确资格谱系
 */
export function migrateDualDriveColumns(db: DatabaseSync): void {
  migrateAddColumn(db, 'aml_datasets', 'lineage_verified', 'INTEGER NOT NULL DEFAULT 0')

  migrateAddColumn(db, 'optimizer_recommendations', 'dispatched_at', 'TEXT')
  migrateAddColumn(db, 'optimizer_recommendations', 'approval_id', 'TEXT')
  migrateAddColumn(db, 'optimizer_recommendations', 'initiator_user_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'optimizer_recommendations', 'dispatch_state', 'TEXT NOT NULL DEFAULT \'idle\'')
  // 旧库可能曾被写入过 dispatched 状态(防重):按幂等锚派生,未建卡的一律 idle
  db.exec('UPDATE optimizer_recommendations SET dispatch_state = \'idle\' WHERE dispatch_state = \'dispatched\' AND dispatched_at IS NULL')
  // 候选行携带求解模型(SW4 互校锚;旧行为空 → 互校回退 run.profile 解析)
  migrateAddColumn(db, 'optimizer_candidates', 'model_id', 'TEXT NOT NULL DEFAULT \'\'')

  migrateAddColumn(db, 'optimizer_profiles', 'problem_ir_hashes_json', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'process_model_eligibility', 'dataset_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'process_model_eligibility', 'dataset_hash', 'TEXT NOT NULL DEFAULT \'\'')
}
