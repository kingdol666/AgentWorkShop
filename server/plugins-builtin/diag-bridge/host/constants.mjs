/**
 * 模块头与常量(超时 / 快照桶 / 冷却 / 进行中产线集合)
 * (由 server/plugins-builtin/diag-bridge/index.mjs 按职责拆出;内容逐行原文搬运)
 */

/**
 * diag-bridge —— industrial-deep-diagnostic 深度诊断服务桥接插件。
 *
 * 把诊断服务(http://127.0.0.1:3210)接入 AgentWorkShop:导出 DAQ 时序快照 CSV →
 * 上传并发起深度诊断 → 轮询状态 → 完成后报告自动入知识库(文档/索引/经验三步)。
 * 工具对 lead/worker 全体 agent 生效;3210 不可达时一律 isError 文本,绝不抛异常。
 */
export const MIN = 60 * 1000
export const DEFAULT_BASE = 'http://127.0.0.1:3210'
export const SNAPSHOT_BUCKET_MS = 5000 // 快照降采样桶宽
export const SNAPSHOT_LIMIT = 10000 // 与 ctx.daq.query limit 一致(截断断言阈值)
export const UPLOAD_FOLDER = 'aw-snapshots'
export const AUTO_COOLDOWN_MS = 30 * MIN // 自动诊断同产线冷却

/** 每产线「启动中」互斥(进程内同步集合,堵住 kv 检查与远端落库之间的并发窗口) */
export const startingLines = new Set()

// ── 基础工具 ──────────────────────────────────────────────────────────────

/** 诊断服务 base(kv diag.base_url;只允许 http/https 且 host 为 127.0.0.1/localhost) */
