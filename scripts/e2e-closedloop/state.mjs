/**
 * 每次运行的随机 TAG 与跨阶段共享上下文 ctx
 * (由 scripts/e2e-full-closedloop.mjs 按职责拆出;内容逐行原文搬运)
 */

// ════════════════════════════════════════════════════════════════
// S1 账号与权限
// ════════════════════════════════════════════════════════════════
export const TAG = Math.random().toString(36).slice(2, 7)
export const ctx = { token: null, admin: null, userA: null, userB: null, line: null, product: null, recipe: null, daq: {}, dcw: {}, twin: null, channelId: null, agent: null }
