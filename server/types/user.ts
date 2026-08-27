import type { z } from 'zod'
import type { userCreateSchema, userListQuerySchema } from '../schemas/user.schema'

/** 用户实体（存储层领域模型，不含密码哈希——密码只进不出） */
export interface User extends z.infer<typeof userCreateSchema> {
  id: string
  createdAt: string
}

/** 分页结果 */
export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

/** 用户列表查询（service 入参；pageSize 缺省时由 config.yml 驱动默认值） */
export type UserListInput = z.infer<typeof userListQuerySchema>

/** 用户列表查询（repository 入参；pageSize 已由 service 解析为确定值） */
export interface UserListQuery {
  page: number
  pageSize: number
  keyword?: string
}

/** API Token（每用户多个；列表仅含掩码 preview，明文经 reveal 接口按需获取） */
export interface UserToken {
  id: string
  userId: string
  label: string
  createdAt: string
  lastUsedAt: string | null
  /** 掩码预览（前 6 后 4）；旧 token 未存档明文时为 null */
  preview: string | null
  /** 是否可随时查看明文（旧数据仅存哈希 → false） */
  hasPlain: boolean
}

/** 登录/注册成功载荷（token 明文仅此处一次性返回） */
export interface AuthResult {
  user: {
    id: string
    name: string
    email: string
    role: string
    createdAt: string
  }
  token: string
}

export type { UserCreate } from '../schemas/user.schema'
