import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes, randomUUID, scryptSync, createHash, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Paginated, User, UserListQuery, UserToken } from '../types/user'
import type { UserCreate, UserUpdate } from '../schemas/user.schema'

/**
 * 全局用户数据访问层（Repository）—— SQLite 持久化（data/users.sqlite）。
 * - users 表：用户档案 + 密码哈希（scrypt，salt 内嵌，明文不进库）
 * - user_tokens 表：每用户多个 API Token（仅存 SHA-256 哈希；明文只在签发时返回一次）
 * 进程内单例 DB 懒加载；数据源与业务逻辑解耦，service 层零改动。
 */

const DB_PATH = resolve(process.cwd(), 'data', 'users.sqlite')

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
`

/** 种子用户（首次建库时写入；默认密码 Awshop@123，便于开箱登录） */
const SEED_USERS = [
  { name: '张伟', email: 'zhangwei@awshop.io', role: 'admin', status: 'active' },
  { name: '王芳', email: 'wangfang@awshop.io', role: 'editor', status: 'active' },
  { name: '李娜', email: 'lina@awshop.io', role: 'user', status: 'disabled' },
  { name: '刘洋', email: 'liuyang@awshop.io', role: 'editor', status: 'active' },
  { name: '陈静', email: 'chenjing@awshop.io', role: 'user', status: 'active' },
  { name: 'Michael Chen', email: 'michael@awshop.io', role: 'user', status: 'active' },
]

let db: DatabaseSync | null = null

function getDb(): DatabaseSync {
  if (!db) {
    mkdirSync(resolve(process.cwd(), 'data'), { recursive: true })
    db = new DatabaseSync(DB_PATH)
    db.exec(SCHEMA_SQL)
    migrateSchema(db)
    seedIfEmpty()
    importLegacyWorkshopUsers(db)
  }
  return db
}

/** 轻量迁移：旧库 user_tokens 补 token_plain 列（明文存档，支持随时查看） */
function migrateSchema(d: DatabaseSync): void {
  const cols = d.prepare('PRAGMA table_info(user_tokens)').all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'token_plain')) {
    d.exec('ALTER TABLE user_tokens ADD COLUMN token_plain TEXT')
  }
}

/** 掩码预览：前 6 后 4（token 形如 ut-xxxxxxxx…，前 6 含前缀可辨识） */
function maskPreview(raw: string): string {
  return `${raw.slice(0, 6)}${'•'.repeat(8)}${raw.slice(-4)}`
}

/** 首次建库写入种子用户（幂等：users 非空即跳过） */
function seedIfEmpty(): void {
  const d = db!
  const { n } = d.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  if (n > 0) return
  const insert = d.prepare('INSERT INTO users (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const hash = hashPassword('Awshop@123')
  for (const u of SEED_USERS) {
    insert.run(randomUUID(), u.name, u.email, hash, u.role, u.status, now())
  }
}
/**
 * 一次性迁移：旧 workshop 本地用户（data/workshop.sqlite 的 users 表）导入全局用户系统。
 * - 保留原 id/name（资源归属 owner_user_id 不变，历史数据不丢）
 * - 旧 token 原值重新注册为全局 token（老客户端免重新登录）
 * - email 派生 + 随机密码（不可经密码登录，可用管理面重置）
 * 幂等：按 id 判断已存在则跳过。
 */
function importLegacyWorkshopUsers(d: DatabaseSync): void {
  const wsPath = resolve(process.cwd(), 'data', 'workshop.sqlite')
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

/** 签发新 token：明文返回一次并存档（token_plain，支持随时查看），库中另存哈希用于认证比对 */
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
    hasPlain: true,
  }
  const d = getDb()
  d.prepare('INSERT INTO user_tokens (id, user_id, label, token_hash, token_plain, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.id, userId, label, hash, raw, row.createdAt)
  return { raw, row }
}

/** 按 token 明文查用户（命中则刷新 last_used_at）；无效返回 null。tokenId 供前端识别当前会话 token。 */
export function findByToken(token: string): (User & { tokenId: string }) | null {
  const d = getDb()
  const hash = hashToken(token)
  const row = d.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.created_at AS createdAt, t.id AS tokenId
     FROM user_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ?`,
  ).get(hash) as (User & { tokenId: string }) | undefined
  if (!row) return null
  d.prepare('UPDATE user_tokens SET last_used_at = ? WHERE token_hash = ?').run(now(), hash)
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
