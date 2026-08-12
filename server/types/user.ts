import type { z } from 'zod'
import type { userCreateSchema, userListQuerySchema } from '../schemas/user.schema'

/** 用户实体（存储层领域模型） */
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

export type { UserCreate } from '../schemas/user.schema'
