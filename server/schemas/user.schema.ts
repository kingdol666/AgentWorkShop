import { z } from 'zod'

/**
 * 用户模块请求契约（Zod 校验）
 * 路由层通过 getValidatedQuery / readValidatedBody 消费。
 */

export const userRoleSchema = z.enum(['admin', 'editor', 'user'])
export const userStatusSchema = z.enum(['active', 'disabled'])

/** 密码规则（注册/登录共用）：6-128 位，至少含字母与数字 */
export const passwordSchema = z
  .string()
  .min(6, '密码至少 6 位')
  .max(128, '密码最多 128 位')
  .regex(/[A-Za-z]/, '密码需包含字母')
  .regex(/[0-9]/, '密码需包含数字')

/** 创建用户请求体（管理面；password 可选——缺省随机，供登录使用） */
export const userCreateSchema = z.object({
  name: z.string().trim().min(2, '用户名至少 2 个字符').max(32, '用户名最多 32 个字符'),
  email: z.string().trim().email('邮箱格式不正确').max(128, '邮箱过长'),
  password: passwordSchema.optional(),
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

/** 公开注册请求体（name + email + password） */
export const userRegisterSchema = z.object({
  name: z.string().trim().min(2, '用户名至少 2 个字符').max(32, '用户名最多 32 个字符'),
  email: z.string().trim().email('邮箱格式不正确').max(128, '邮箱过长'),
  password: passwordSchema,
})

/** 登录请求体（email + password） */
export const userLoginSchema = z.object({
  email: z.string().trim().email('邮箱格式不正确').max(128, '邮箱过长'),
  password: z.string().min(1, '密码不能为空').max(128, '密码过长'),
})

/** 创建 API Token 请求体 */
export const userTokenCreateSchema = z.object({
  label: z.string().trim().max(64, '标签最多 64 字符').default(''),
})

/** 更新 API Token 请求体 */
export const userTokenUpdateSchema = z.object({
  label: z.string().trim().max(64, '标签最多 64 字符').min(1, '标签不能为空'),
})

export type UserCreate = z.infer<typeof userCreateSchema>
export type UserUpdate = z.infer<typeof userUpdateSchema>
export type UserListQueryInput = z.infer<typeof userListQuerySchema>
export type UserRegister = z.infer<typeof userRegisterSchema>
export type UserLogin = z.infer<typeof userLoginSchema>
export type UserTokenCreate = z.infer<typeof userTokenCreateSchema>
export type UserTokenUpdate = z.infer<typeof userTokenUpdateSchema>
