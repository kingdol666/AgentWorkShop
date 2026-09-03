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
    // HITL 审批超时窗(超时默认拒绝;security.hitl_timeout_ms / env HITL_TIMEOUT_MS)
    hitl_timeout_ms: z.number().int().min(1000).max(86400000).default(180_000),
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
      qos: z.number().int().min(0).max(2).default(0), // 事件总线发布 QoS(legacy DAQ_MQTT_QOS)
      rejectUnauthorized: z.boolean().default(true), // mqtts 证书校验(legacy DAQ_MQTT_REJECT_UNAUTHORIZED)
    }),
    timescale: z.object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(5432),
      user: z.string().default('postgres'),
      password: z.string().default('awshop'),
      database: z.string().default('awshop'),
    }),
    // 对象存储(v2 帧管线:图像帧像素;MinIO S3 兼容。不可达 → 本地磁盘降级,采集不中断)
    objectstore: z.object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(9000),
      accessKey: z.string().default('awshop'),
      secretKey: z.string().default('awshop-secret'),
      bucket: z.string().default('daq'),
    }).optional(),
    // 保留策略(legacy DAQ_TS_RETENTION_H / DAQ_FRAME_RETENTION_H)
    tsRetentionH: z.number().int().min(1).max(8760).default(168),
    frameRetentionH: z.number().int().min(1).max(8760).default(720),
    // 告警升级(legacy ALARM_WEBHOOK_URL / ALARM_ESCALATE_MINUTES)
    alarmWebhookUrl: z.string().default(''),
    alarmEscalateMinutes: z.number().int().min(1).max(1440).default(15),
  }).default({ startInfrastructure: 'auto', mqtt: { host: '127.0.0.1', port: 1883 }, timescale: { host: '127.0.0.1', port: 5432, user: 'postgres', password: 'awshop', database: 'awshop' } }),
  // —— 以下运行语义组:config 缺省即用默认;env AW_<键>(点转下划线)/历史别名可覆盖 ——
  memory: z.object({
    primer_tokens: z.number().min(50).max(4000).default(300),
    inject_total: z.number().min(100).max(8000).default(500),
    maintenance_ms: z.number().min(60000).max(604800000).default(21_600_000),
    expire_days: z.number().min(1).max(3650).default(180),
    expire_session_days: z.number().min(1).max(365).default(14),
    cap: z.number().min(50).max(50000).default(500),
    reflect_trigger: z.number().min(1).max(100).default(8),
    embed_base_url: z.string().default(''),
    embed_model: z.string().default(''),
    embed_api_key: z.string().default(''),
  }).default({}),
  omp: z.object({
    compact_enabled: z.boolean().default(true),
    compact_threshold: z.number().min(0.3).max(0.95).default(0.7),
    compact_min_interval_ms: z.number().min(30000).max(3600000).default(300_000),
    compact_wait_ms: z.number().min(10000).max(600000).default(120_000),
  }).default({}),
  dcw: z.object({
    rollback_cooldown_ms: z.number().min(0).max(3600000).default(300_000),
    rollback_min_window_ms: z.number().min(0).max(3600000).default(120_000),
    rollback_baseline_ms: z.number().min(0).max(7200000).default(600_000),
    rollback_stale_ms: z.number().min(60000).max(14400000).default(1_800_000),
  }).default({}),
  workshop: z.object({
    idle_sweep_ms: z.number().min(5000).max(600000).default(30_000),
    idle_grace_ms: z.number().min(10000).max(3600000).default(120_000),
  }).default({}),
  backup: z.object({
    disabled: z.boolean().default(false),
    interval_hours: z.number().min(1).max(720).default(24),
    keep: z.number().min(1).max(100).default(7),
  }).default({}),
  retention: z.object({
    disabled: z.boolean().default(false),
    events_days: z.number().min(1).max(365).default(7),
    messages_days: z.number().min(1).max(3650).default(30),
    audit_days: z.number().min(1).max(3650).default(90),
    approval_days: z.number().min(1).max(3650).default(180),
  }).default({}),
  log: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }).default({}),
})

export type AppConfig = z.infer<typeof appConfigSchema>
