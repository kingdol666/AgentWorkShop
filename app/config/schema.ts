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
    // R3:高危管理操作双人复核闸门(默认关;开启后 apply/controller/delete 需另一 admin 批核)
    approvalGate: z.boolean().default(false),
  }),
  daq: z.object({
    startInfrastructure: z.enum(['auto', 'always', 'never']).default('auto'),
    mqtt: z.object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(1883),
      // S1:生产 broker 鉴权/TLS(可选项;dev 零配置 no-auth 不受影响;另可整体用 DAQ_MQTT_URL 覆盖)
      username: z.string().default(''),
      password: z.string().default(''),
      secure: z.boolean().default(false), // true → mqtts://(8883 + CA)
      caFile: z.string().default(''), // 自签 CA 证书路径(mqtts 时建议设置)
    }),
    timescale: z.object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(5432),
      user: z.string().default('postgres'),
      password: z.string().default('awshop'),
      database: z.string().default('awshop'),
    }),
  }).default({ startInfrastructure: 'auto', mqtt: { host: '127.0.0.1', port: 1883 }, timescale: { host: '127.0.0.1', port: 5432, user: 'postgres', password: 'awshop', database: 'awshop' } }),
})

export type AppConfig = z.infer<typeof appConfigSchema>
