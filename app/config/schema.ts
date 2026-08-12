import { z } from 'zod'

/**
 * config.yml 的 Zod 校验模式。
 * 任何不符合约束的配置都会在构建/启动期 fail-fast，避免错误配置流入运行时。
 */
export const appConfigSchema = z.object({
  app: z.object({
    name: z.string(),
    title: z.string(),
    version: z.string(),
    description: z.string().optional().default(''),
  }),
  mode: z.enum(['dev', 'prod']).default('dev'),
  server: z.object({
    host: z.string().default('0.0.0.0'),
    dev: z.object({
      port: z.number().int().min(1).max(65535),
    }),
    prod: z.object({
      port: z.number().int().min(1).max(65535),
    }),
  }),
  api: z.object({
    baseURL: z.string().default('/api'),
    timeout: z.number().int().positive().default(15000),
    // 服务端 API 默认分页与上限（config 驱动）
    pageSize: z.number().int().positive().default(20),
    maxPageSize: z.number().int().positive().default(100),
  }),
  i18n: z.object({
    defaultLocale: z.string(),
    locales: z.array(z.object({
      code: z.string(),
      name: z.string(),
    })),
  }),
  theme: z.object({
    primaryColor: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, '须为合法十六进制颜色，如 #1677ff'),
    mode: z.enum(['light', 'dark']).default('light'),
  }),
  security: z.object({
    sessionPassword: z.string().min(16, 'session 密钥至少 16 位').default(''),
  }),
})

export type AppConfig = z.infer<typeof appConfigSchema>
