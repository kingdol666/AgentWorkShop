import { existsSync } from 'node:fs'
import { backupRegistry } from '../services/workshop/db/backup-registry'
import { join, resolve } from 'node:path'
import { randomBytes, randomUUID, scryptSync, createHash, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ensureDataDir } from '@/shared/config/home.mjs'
import type { Paginated, User, UserListQuery, UserToken } from '../types/user'
import type { UserCreate, UserUpdate } from '../schemas/user.schema'

/**
 * 全局用户数据访问层（Repository）—— SQLite 持久化（配置根 .AgentWorkShop/data/users.sqlite;
 * repo 模式 <repo>/.AgentWorkShop/data,home 模式 ~/.AgentWorkShop/data,经 ensureDataDir 统一解析
 * 并自动迁移旧 cwd/data 位置）。
 * - users 表：用户档案 + 密码哈希（scrypt，salt 内嵌，明文不进库）
 * - user_tokens 表：每用户多个 API Token（仅存 SHA-256 哈希；明文只在签发时返回一次）
 * 进程内单例 DB 懒加载；数据源与业务逻辑解耦，service 层零改动。
 */

// 配置根 .AgentWorkShop/data（repo: <repo>/.AgentWorkShop/data,home: ~/.AgentWorkShop/data;
// ensureDataDir 统一解析并自动迁移旧 cwd/data 位置）
const DB_PATH = join(ensureDataDir(), 'users.sqlite')

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT '',
  token_hash   TEXT NOT NULL UNIQUE,
  token_plain  TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens(user_id);
CREATE TABLE IF NOT EXISTS user_line_grants (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  line_id     TEXT NOT NULL,
  mode        TEXT NOT NULL,
  granted_by  TEXT,
  granted_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, line_id)
);
`

let db: DatabaseSync | null = null

function getDb(): DatabaseSync {
  if (!db) {
    // 目录由 ensureDataDir 内部创建(含旧位置迁移)
    db = new DatabaseSync(DB_PATH)
    // 主连接登记(备份 serialize 用;见 backup-registry 说明)
    backupRegistry.register(DB_PATH, db)
    // WAL:认证读路径不再与写互斥(rollback 模式每请求写锁+fsync 串行化全部 API)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(SCHEMA_SQL)
    migrateSchema(db)
    // 首启零用户:不播种任何账号,由使用者在登录页注册第一个账号(自动成为管理员,
    // 见 user.service.register 的初始化判定)
    importLegacyWorkshopUsers(db)
  }
  return db
}

/** 轻量迁移：旧库 user_tokens 补 token_plain 列（明文存档，支持随时查看）+ expires_at（R2 后端过期） */
function migrateSchema(d: DatabaseSync): void {
  const cols = d.prepare('PRAGMA table_info(user_tokens)').all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'token_plain')) {
    d.exec('ALTER TABLE user_tokens ADD COLUMN token_plain TEXT')
  }
  if (!cols.some(c => c.name === 'expires_at')) {
    d.exec('ALTER TABLE user_tokens ADD COLUMN expires_at TEXT')
  }
  // 安全迁移:清空存量明文 token——库中只保留哈希,备份/文件拷贝不再等于凭据泄漏
  d.exec('UPDATE user_tokens SET token_plain = NULL WHERE token_plain IS NOT NULL')
  // 存量 token 宽限 30 天(从部署时刻起算,避免升级即全员掉线)
  d.prepare('UPDATE user_tokens SET expires_at = ? WHERE expires_at IS NULL').run(isoInDays(TOKEN_TTL_DAYS))
}

/** token 有效期(天,R2):过期后 findByToken 拒绝,用户重新登录即可 */
const TOKEN_TTL_DAYS = 30

/** 当前时刻 + n 天的 ISO 时间戳 */
function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString()
}

/** 掩码预览：前 6 后 4（token 形如 ut-xxxxxxxx…，前 6 含前缀可辨识） */
function maskPreview(raw: string): string {
  return `${raw.slice(0, 6)}${'•'.repeat(8)}${raw.slice(-4)}`
}

/**
 * 一次性迁移：旧 workshop 本地用户（data/workshop.sqlite 的 users 表）导入全局用户系统。
 * - 保留原 id/name（资源归属 owner_user_id 不变，历史数据不丢）
 * - 旧 token 原值重新注册为全局 token（老客户端免重新登录）
 * - email 派生 + 随机密码（不可经密码登录，可用管理面重置）
 * 幂等：按 id 判断已存在则跳过。
 */
function importLegacyWorkshopUsers(d: DatabaseSync): void {
  // 迁移后配置根已有 workshop.sqlite;旧 cwd/data 位置兜底(仅历史未迁移场景)
  const migrated = join(ensureDataDir(), 'workshop.sqlite')
  const wsPath = existsSync(migrated) ? migrated : resolve(process.cwd(), 'data', 'workshop.sqlite')
  if (!existsSync(wsPath)) return
  let wdb: DatabaseSync
  try {
    wdb = new DatabaseSync(wsPath, { readOnly: true })
  }
  catch {
    return // workshop 库尚不存在或不可读：跳过
  }
  let rows: Array<{ id: string, name: string, token: string, created_at: string }>
  try {
    rows = wdb.prepare('SELECT id, name, token, created_at FROM users').all() as Array<{ id: string, name: string, token: string, created_at: string }>
  }
  catch {
    wdb.close()
    return
  }
  wdb.close()

  const exists = d.prepare('SELECT 1 FROM users WHERE id = ?')
  const insertUser = d.prepare('INSERT INTO users (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const tokenExists = d.prepare('SELECT 1 FROM user_tokens WHERE token_hash = ?')
  const insertToken = d.prepare('INSERT INTO user_tokens (id, user_id, label, token_hash, token_plain, created_at) VALUES (?, ?, ?, ?, ?, ?)')

  for (const row of rows) {
    if (exists.get(row.id)) continue
    const email = `legacy-${row.id.slice(0, 8)}@workshop.local`
    insertUser.run(row.id, row.name, email, hashPassword(randomPassword()), 'user', 'active', row.created_at ?? now())
    const hash = hashToken(row.token)
    if (!tokenExists.get(hash)) {
      insertToken.run(randomUUID(), row.id, 'legacy', hash, row.token, row.created_at ?? now())
    }
  }
}

/** 20 位随机口令（legacy 导入用户与自动建号共用） */
function randomPassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = randomBytes(20)
  let out = ''
  for (const b of bytes) out += chars[b % chars.length]
  return out
}

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

// ===== 密码哈希（scrypt）=====

/** 生成 scrypt 哈希（格式 salt:hash，均为 hex） */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

/** 校验密码：长度与哈希双重防御（timingSafeEqual 防时序侧信道） */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hex] = stored.split(':')
  if (!salt || !hex) return false
  const expected = Buffer.from(hex, 'hex')
  const actual = scryptSync(password, salt, expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

// ===== Token 哈希 =====

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 签发新 token：明文仅此一次返回,库中只存 SHA-256 哈希(0.7.10 起不再存档明文) */
function issueToken(userId: string, label: string): { raw: string, row: UserToken } {
  const raw = `ut-${randomUUID().replace(/-/g, '')}`
  const hash = hashToken(raw)
  const row: UserToken = {
    id: randomUUID(),
    userId,
    label,
    createdAt: now(),
    lastUsedAt: null,
    preview: maskPreview(raw),
    hasPlain: false,
  }
  const d = getDb()
  d.prepare('INSERT INTO user_tokens (id, user_id, label, token_hash, token_plain, created_at, expires_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
    .run(row.id, userId, label, hash, row.createdAt, isoInDays(TOKEN_TTL_DAYS))
  return { raw, row }
}

/** last_used_at 写节流:每 tokenId 60s 最多落库一次(高频认证路径不再逐请求写锁) */
const lastUsedSeen = new Map<string, number>()
const LAST_USED_THROTTLE_MS = 60_000

/** 按 token 明文查用户（命中且未过期则刷新 last_used_at）；无效/已过期返回 null。tokenId 供前端识别当前会话 token。 */
export function findByToken(token: string): (User & { tokenId: string }) | null {
  const d = getDb()
  const hash = hashToken(token)
  const row = d.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.created_at AS createdAt, t.id AS tokenId, t.expires_at AS expiresAt
FROM user_tokens t JOIN users u ON u.id = t.user_id
WHERE t.token_hash = ?`,
  ).get(hash) as (User & { tokenId: string, expiresAt: string | null }) | undefined
  if (!row) return null
  // R2:过期单点判定(resolveUser/resolveAgentOrUser/me 全部经此收敛)
  if (row.expiresAt && Date.parse(row.expiresAt) < Date.now()) return null
  // 禁用账号即时失效(此前存量 token 在禁用后最长 30 天仍可用)
  if (row.status && row.status !== 'active') return null
  const seenAt = lastUsedSeen.get(row.tokenId) ?? 0
  if (Date.now() - seenAt >= LAST_USED_THROTTLE_MS) {
    lastUsedSeen.set(row.tokenId, Date.now())
    d.prepare('UPDATE user_tokens SET last_used_at = ? WHERE token_hash = ?').run(now(), hash)
  }
  return row
}

/** users 行 → User 领域对象（禁带 password_hash） */
function toUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    role: row.role as User['role'],
    status: row.status as User['status'],
    createdAt: String(row.created_at ?? row.createdAt),
  }
}

export const userRepository = {
  list({ page, pageSize, keyword }: UserListQuery): Paginated<User> {
    const d = getDb()
    const kw = keyword?.toLowerCase() ?? ''
    const where = kw
      ? `WHERE LOWER(name) LIKE ? OR LOWER(email) LIKE ?`
      : ''
    const params = kw ? [`%${kw}%`, `%${kw}%`] : []
    const total = (d.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).get(...params) as { n: number }).n
    const rows = d.prepare(
      `SELECT id, name, email, role, status, created_at AS createdAt FROM users ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>
    return { items: rows.map(toUser), total, page, pageSize }
  },

  /** 全量用户(不分页;管理面授权矩阵用,避免分页截断) */
  listAll(): User[] {
    const d = getDb()
    const rows = d.prepare('SELECT id, name, email, role, status, created_at AS createdAt FROM users ORDER BY created_at DESC').all() as Array<Record<string, unknown>>
    return rows.map(toUser)
  },

  /** 全部产线授权(单查询;管理面按 userId 分组,替代逐用户 N+1) */
  allGrants(): Array<{ userId: string, lineId: string, mode: string, grantedBy: string | null, grantedAt: string }> {
    const d = getDb()
    return d.prepare('SELECT user_id AS userId, line_id AS lineId, mode, granted_by AS grantedBy, granted_at AS grantedAt FROM user_line_grants').all() as Array<{ userId: string, lineId: string, mode: string, grantedBy: string | null, grantedAt: string }>
  },

  findById(id: string): User | undefined {
    const d = getDb()
    const row = d.prepare('SELECT id, name, email, role, status, created_at AS createdAt FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? toUser(row) : undefined
  },

  findByEmail(email: string): User | undefined {
    const d = getDb()
    const row = d.prepare('SELECT id, name, email, role, status, created_at AS createdAt FROM users WHERE LOWER(email) = LOWER(?)').get(email) as Record<string, unknown> | undefined
    return row ? toUser(row) : undefined
  },

  findByName(name: string): User | undefined {
    const d = getDb()
    const row = d.prepare('SELECT id, name, email, role, status, created_at AS createdAt FROM users WHERE name = ?').get(name) as Record<string, unknown> | undefined
    return row ? toUser(row) : undefined
  },

  /** 是否存在活跃管理员(初始化判定:false → 系统处于首启注册模式,首个注册账号将成为管理员) */
  hasActiveAdmin(): boolean {
    const d = getDb()
    const { n } = d.prepare('SELECT COUNT(*) AS n FROM users WHERE role = \'admin\' AND status = \'active\'').get() as { n: number }
    return n > 0
  },

  // ===== 产线授权(user_line_grants;admin/editor 不查此表,全量全权)=====

  /** 某用户全部产线授权 */
  listGrants(userId: string): Array<{ lineId: string, mode: string, grantedBy: string | null, grantedAt: string }> {
    const d = getDb()
    return d.prepare('SELECT line_id AS lineId, mode, granted_by AS grantedBy, granted_at AS grantedAt FROM user_line_grants WHERE user_id = ?').all(userId) as Array<{ lineId: string, mode: string, grantedBy: string | null, grantedAt: string }>
  },

  /** 单条授权(mode 非 readonly/operate → 撤销);返回是否发生变化 */
  setGrant(userId: string, lineId: string, mode: string | null, grantedBy: string | null): boolean {
    const d = getDb()
    if (mode !== 'readonly' && mode !== 'operate') {
      return d.prepare('DELETE FROM user_line_grants WHERE user_id = ? AND line_id = ?').run(userId, lineId).changes > 0
    }
    d.prepare(`INSERT INTO user_line_grants (user_id, line_id, mode, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, line_id) DO UPDATE SET mode = excluded.mode, granted_by = excluded.granted_by, granted_at = excluded.granted_at`)
      .run(userId, lineId, mode, grantedBy, now())
    return true
  },

  /** 用户 → 产线访问映射(lineId → 'readonly'|'operate');无记录 = 无权 */
  lineAccessMap(userId: string): Map<string, string> {
    const d = getDb()
    const rows = d.prepare('SELECT line_id AS lineId, mode FROM user_line_grants WHERE user_id = ?').all(userId) as Array<{ lineId: string, mode: string }>
    return new Map(rows.map(r => [r.lineId, r.mode]))
  },

  /** 内部：取密码哈希（仅认证路径使用，不参与领域对象外泄） */
  getPasswordHash(email: string): { id: string, hash: string } | null {
    const d = getDb()
    const row = d.prepare('SELECT id, password_hash AS hash FROM users WHERE LOWER(email) = LOWER(?)').get(email) as { id: string, hash: string } | undefined
    return row ?? null
  },

  create(input: UserCreate & { password: string }): User {
    const d = getDb()
    const user: User = {
      id: randomUUID(),
      name: input.name,
      email: input.email,
      role: input.role,
      status: input.status,
      createdAt: now(),
    }
    d.prepare('INSERT INTO users (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, user.name, user.email, hashPassword(input.password), user.role, user.status, user.createdAt)
    return user
  },

  /** 原子注册(IMMEDIATE 事务内判定管理员空缺):并发注册不会产生第二个 bootstrap admin */
  createWithRoleBootstrap(input: UserCreate & { password: string }): { user: User, bootstrap: boolean } {
    const d = getDb()
    d.exec('BEGIN IMMEDIATE')
    try {
      const bootstrap = !this.hasActiveAdmin()
      const user = this.create({ ...input, role: bootstrap ? 'admin' : input.role })
      d.exec('COMMIT')
      return { user, bootstrap }
    }
    catch (err) {
      try {
        d.exec('ROLLBACK')
      }
      catch { /* 事务已自滚 */ }
      throw err
    }
  },

  update(id: string, input: UserUpdate): User | undefined {
    const d = getDb()
    const current = this.findById(id)
    if (!current) return undefined
    const fields: string[] = []
    const params: string[] = []
    if (input.name !== undefined) {
      fields.push('name = ?')
      params.push(input.name)
    }
    if (input.email !== undefined) {
      fields.push('email = ?')
      params.push(input.email)
    }
    if (input.role !== undefined) {
      fields.push('role = ?')
      params.push(input.role)
    }
    if (input.status !== undefined) {
      fields.push('status = ?')
      params.push(input.status)
    }
    if (input.password !== undefined) {
      fields.push('password_hash = ?')
      params.push(hashPassword(input.password))
    }
    if (fields.length === 0) return current
    d.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params, id)
    return this.findById(id)
  },

  remove(id: string): boolean {
    const d = getDb()
    return d.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0
  },

  // ===== API Token（每用户多个，CRUD）=====

  /** 列出某用户全部 token（含掩码 preview，不含哈希/明文） */
  listTokens(userId: string): UserToken[] {
    const d = getDb()
    const rows = d.prepare(
      'SELECT id, user_id AS userId, label, token_plain AS tokenPlain, created_at AS createdAt, last_used_at AS lastUsedAt FROM user_tokens WHERE user_id = ? ORDER BY created_at ASC',
    ).all(userId) as Array<{ id: string, userId: string, label: string, tokenPlain: string | null, createdAt: string, lastUsedAt: string | null }>
    return rows.map(r => ({
      id: r.id,
      userId: r.userId,
      label: r.label,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      preview: r.tokenPlain ? maskPreview(r.tokenPlain) : null,
      hasPlain: r.tokenPlain != null && r.tokenPlain !== '',
    }))
  },

  /** 创建 token（label 缺省空串；明文仅此一次返回） */
  createToken(userId: string, label: string): { raw: string, row: UserToken } {
    return issueToken(userId, label)
  },

  /** 按 id 找某用户的 token（越权场景返回 null） */
  findTokenById(userId: string, tokenId: string): UserToken | undefined {
    const d = getDb()
    const row = d.prepare(
      'SELECT id, user_id AS userId, label, created_at AS createdAt, last_used_at AS lastUsedAt FROM user_tokens WHERE id = ? AND user_id = ?',
    ).get(tokenId, userId) as unknown as UserToken | undefined
    return row
  },

  /** 按 id 取某用户 token 的存档明文；非本人/不存在 → undefined，未存档（旧数据）→ null */
  findTokenPlain(userId: string, tokenId: string): string | null | undefined {
    const d = getDb()
    const row = d.prepare(
      'SELECT token_plain AS tokenPlain FROM user_tokens WHERE id = ? AND user_id = ?',
    ).get(tokenId, userId) as { tokenPlain: string | null } | undefined
    return row ? row.tokenPlain : undefined
  },

  /** 改 token 标签；不存在或非本人返回 false */
  updateTokenLabel(userId: string, tokenId: string, label: string): boolean {
    const d = getDb()
    return d.prepare('UPDATE user_tokens SET label = ? WHERE id = ? AND user_id = ?').run(label, tokenId, userId).changes > 0
  },

  /** 删除/吊销 token；不存在或非本人返回 false */
  revokeToken(userId: string, tokenId: string): boolean {
    const d = getDb()
    return d.prepare('DELETE FROM user_tokens WHERE id = ? AND user_id = ?').run(tokenId, userId).changes > 0
  },

  /** 登出当前 token（仅吊销该 token 本身） */
  revokeTokenByValue(token: string): boolean {
    const d = getDb()
    return d.prepare('DELETE FROM user_tokens WHERE token_hash = ?').run(hashToken(token)).changes > 0
  },

  /** 测试钩子：替换内部 DB（重开内存库等） */
  _resetForTest(): void {
    db?.close()
    db = null
  },
}
