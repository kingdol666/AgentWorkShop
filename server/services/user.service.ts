import { userRepository, findByToken, verifyPassword } from '../repositories/user.repository'
import type { UserListInput, UserListQuery, UserToken, AuthResult } from '../types/user'
import type { UserCreate, UserUpdate, UserLogin, UserRegister } from '../schemas/user.schema'
import { AppError, ErrorCodes } from '../utils/errors'
import { useServerConfig } from '../utils/config'
import { randomBytes } from 'node:crypto'
/**
 * 用户业务逻辑层（Service）
 * 职责：领域规则、认证（注册/登录/token 签发）、token 隔离（仅本人可 CRUD）、
 * 默认值解析（config 驱动）、跨仓库编排。
 * 不感知 HTTP 细节（h3），不直接触碰数据源。
 */

/** 经 token 解析的用户档案（附带当前 tokenId，可识别会话 token） */
export type UserProfile = AuthResult['user'] & { tokenId: string }

/** 从 Authorization 头解析用户（供 workshop 等跨模块认证共用）：token → 用户档案或 null */
export function resolveUserByToken(token: string): UserProfile | null {
  const user = findByToken(token)
  return user
    ? { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt, tokenId: user.tokenId }
    : null
}

export const userService = {
  // ===== 管理面（与既有契约一致）=====

  list(input: UserListInput) {
    const { api } = useServerConfig()
    const query: UserListQuery = {
      page: input.page,
      pageSize: Math.min(input.pageSize ?? api.pageSize, api.maxPageSize),
      keyword: input.keyword,
    }
    return userRepository.list(query)
  },

  getById(id: string) {
    const user = userRepository.findById(id)
    if (!user) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, '用户不存在')
    }
    return user
  },

  create(input: UserCreate) {
    if (userRepository.findByEmail(input.email)) {
      throw new AppError(409, ErrorCodes.CONFLICT, '邮箱已被注册')
    }
    const password = input.password ?? randomPassword()
    return userRepository.create({ ...input, password })
  },

  update(id: string, input: UserUpdate) {
    if (input.email) {
      const exists = userRepository.findByEmail(input.email)
      if (exists && exists.id !== id) {
        throw new AppError(409, ErrorCodes.CONFLICT, '邮箱已被占用')
      }
    }
    const user = userRepository.update(id, input)
    if (!user) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, '用户不存在')
    }
    return user
  },

  remove(id: string) {
    if (!userRepository.remove(id)) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, '用户不存在')
    }
    return { id }
  },

  /** 管理面：重置指定用户密码 */
  resetPassword(id: string, password: string) {
    const user = userRepository.update(id, { password })
    if (!user) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, '用户不存在')
    }
    return { id }
  },

  // ===== 认证（公开端点）=====

  /** 注册：创建账号 + 签发首个 token（邮箱/用户名占用 → 409） */
  register(input: UserRegister): AuthResult {
    if (userRepository.findByEmail(input.email)) {
      throw new AppError(409, ErrorCodes.CONFLICT, '邮箱已被注册')
    }
    if (userRepository.findByName(input.name)) {
      throw new AppError(409, 'USER_EXISTS', `用户名已存在: ${input.name}`)
    }
    const user = userRepository.create({ ...input, role: 'user', status: 'active' })
    const { raw } = userRepository.createToken(user.id, 'default')
    return { user: this.publicProfile(user), token: raw }
  },

  /** 登录：密码校验通过后签发新 token（每次登录生成一个可独立吊销的会话 token） */
  login(input: UserLogin): AuthResult {
    const { id, hash } = userRepository.getPasswordHash(input.email) ?? {}
    if (!id || !hash || !verifyPassword(input.password, hash)) {
      throw new AppError(401, 'UNAUTHORIZED', '邮箱或密码错误')
    }
    const user = userRepository.findById(id)
    if (!user) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, '用户不存在')
    }
    if (user.status !== 'active') {
      throw new AppError(403, 'FORBIDDEN', '账号已禁用')
    }
    const { raw } = userRepository.createToken(id, `session-${Date.now()}`)
    return { user: this.publicProfile(user), token: raw }
  },

  /** 登出：吊销当前 token（仅该 token 失效，其余会话不受影响） */
  logout(token: string): { ok: boolean } {
    return { ok: userRepository.revokeTokenByValue(token) }
  },

  // ===== 当前用户（Bearer token 身份）=====

  me(token: string): AuthResult['user'] {
    const profile = resolveUserByToken(token)
    if (!profile) {
      throw new AppError(401, 'UNAUTHORIZED', 'token 无效或已吊销')
    }
    return profile
  },

  // ===== Token CRUD（仅本人可操作自己的 token）=====

  listTokens(userId: string): UserToken[] {
    return userRepository.listTokens(userId)
  },

  /** 创建 token；返回明文一次（label 缺省空串） */
  createToken(userId: string, label: string): { id: string, label: string, token: string, createdAt: string } {
    const { raw, row } = userRepository.createToken(userId, label)
    return { id: row.id, label: row.label, token: raw, createdAt: row.createdAt }
  },

  updateToken(userId: string, tokenId: string, label: string): UserToken {
    if (!userRepository.updateTokenLabel(userId, tokenId, label)) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'token 不存在或不属于当前用户')
    }
    const token = userRepository.findTokenById(userId, tokenId)
    if (!token) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'token 不存在')
    }
    return token
  },

  revokeToken(userId: string, tokenId: string): { id: string } {
    if (!userRepository.revokeToken(userId, tokenId)) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'token 不存在或不属于当前用户')
    }
    return { id: tokenId }
  },

  /** 公开档案（不含敏感字段） */
  publicProfile(u: { id: string, name: string, email: string, role: string, createdAt: string }): AuthResult['user'] {
    return { id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt }
  },
}

/** 20 位随机口令（管理面创建用户未给密码时使用） */
function randomPassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = randomBytes(20)
  let out = ''
  for (const b of bytes) out += chars[b % chars.length]
  return out
}
