#!/usr/bin/env node
/**
 * AgentWorkShop 全链路闭环 E2E —— **入口薄壳**。
 *
 * 实现按职责拆到 ./e2e-closedloop/ 下(断言框架与 HTTP 辅助 / 共享上下文 /
 * s1~s11 各阶段场景 / 清理 / 主流程)。入口路径与用法保持不变,便于 README 与习惯用法的
 * `node scripts/e2e-full-closedloop.mjs [baseUrl]` 继续可用。
 *
 * 需要服务端已在运行(默认 http://127.0.0.1:3111,可用参数或 AW_BASE 覆盖)。
 */
import { main } from './e2e-closedloop/main.mjs'

main().catch((err) => {
  console.error('E2E 致命异常:', err)
  process.exit(1)
})
