import { z } from 'zod'

/**
 * 用户模块请求契约（Zod 校验）
 * 路由层通过 getValidatedQuery / readValidatedBody 消费。
 */

export const userRoleSchema = z.enum(['admin', 'editor', 'user'])
export const userStatusSchema = z.enum(['active', 'disabled'])

/** 创建用户请求体 */
export const userCreateSchema = z.object({
  name: z.string().trim().min(2, '用户名至少 2 个字符').max(32, '用户名最多 32 个字符'),
  email: z.string().trim().email('邮箱格式不正确').max(128, '邮箱过长'),
  role: userRoleSchema.default('user'),
  status: userStatusSchema.default('active'),
})

/** 更新用户请求体（部分更新） */
export const userUpdateSchema = userCreateSchema.partial()

/** 用户列表查询参数（query string 由 h3 coerce 处理） */
export const userListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).optional(),
  keyword: z.string().trim().max(64, '关键词过长').optional(),
})

export type UserCreate = z.infer<typeof userCreateSchema>
export type UserUpdate = z.infer<typeof userUpdateSchema>
export type UserListQueryInput = z.infer<typeof userListQuerySchema>
