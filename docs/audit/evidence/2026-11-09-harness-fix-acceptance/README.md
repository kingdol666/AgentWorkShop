# 2026-11-09 三维度修复统一验收证据

构建基线：origin/main @ d21f6c94 + PR #111/#112/#113/#114（隔离 home `/tmp/aw-accept-home`，端口 3011，`AW_MODE=home`）。

## 结论

| 层 | 套件 | 结果 |
|---|---|---|
| T0 静态 | lint / typecheck | ✅ 0 error |
| T0 静态 | i18n:check | ✅ 3291/3291 PARITY, unresolved=0 |
| T0 静态 | docs:check | ⚠️ 75 通过 / 12 失败 —— **origin/main 基线问题**（设置项计数 140→143 未同步、站点副本 CRLF 差 1 字符）；本轮 diff 未触及 schema.json/docs，证据见 PR 说明 |
| T1 单元 | test:unit | ✅ **1261 pass / 0 fail / 2 skipped**（1263） |
| T1 专项 | test:mcp / plugin-lifecycle / sdk-surface / twin-provider / skills | ✅ 全绿（插件 22/22、skills 167/167） |
| T2 实机 | test:e2e-line（产线治理 L1-L12） | ✅ **44/44 PASS** |
| T4 注册面 | plugins / tools / harnesses | ✅ tools 147 全 available、harness 14/14、plugin failures=[] |
| T5 产物 | `/`=200、`/api/workshop/aml`=401、缺 NUXT_SESSION_PASSWORD 拒绝启动(exit=1) | ✅ |
| 统一验收 | accept-harness-fix.mjs | ✅ **17/17 PASS** |
| UI 走查 | shots.mjs 20 页暗色 | ✅ 0 横向溢出、0 落点偏移；4 页 hydration 警告为 main 基线 |

## 三维度修复的验收锚点

- **会话身份（H1-H3）**：基线 sessionId 非空 → terminate → 重建后 sessionId 非空且 **≠ 旧值**（无陈旧绑定）
- **API 写面（S1-S9）**：九个非法形状全部 400 且字段精确；`z.coerce` 与旧 `Number()` 语义对齐（`[]`→0）
- **子资源读面（G1-G3）**：主路径 200；跨项目 id → 404 统一信封

## 本轮明确不做（防误伤）

- **dcw_control / param_control / dcw_rollback 补声明**：经代码与 `fallback-hints.ts` 确证为权限模型 v2 有意禁用桩 —— 补声明会注入恒错工具。已由 `tests/host-tool-surface-consistency.test.ts` 将该意图编码为可执行断言。
- **WriteGrant 签发器**：属设计文档规划中特性（`docs/aml-hybrid-twin-mpc-integration-plan.md` §3.11），实现即新增功能。
- **prompt 超时设置化**：main 已有 `workshop.harness_stall_timeout_ms`。
