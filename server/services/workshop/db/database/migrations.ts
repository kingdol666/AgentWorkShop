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
 */
export function migrateDropOwnerFks(db: DatabaseSync): void {
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
