#!/usr/bin/env node
/**
 * 三系统集成 e2e — AgentWorkShop × industrial-deep-diagnostic × rag-knowledge
 *
 * 覆盖(对应 .omc/plans/2026-09-07-three-system-integration.md 验收标准):
 *   Stage 1 系统与插件健康:四服务存活特征 / 插件装载 / 插件路由鉴权门(auth:'user')
 *   Stage 2 工具链与团队演示:DAQ 实时→快照 CSV / kb_index+kb_search 回环 / kb_store /
 *           双团队(数据分析组+闭环控制组)/ 跨通道消息 / DCW(manual)→HITL→写回
 *   Stage 3(--full)真实诊断:diag_run(omp 引擎)→ 轮询至完成 → 报告自动入 KB → 检索命中
 *   Stage 4 插件启停:plugins-state.json 热重载 → 工具与路由同时消失/恢复
 *
 * 用法:node scripts/three-system-e2e.mjs [--full]
 * 鉴权:沿用 api-live-e2e 惯例(env AW_E2E_TOKEN 复用,否则注册临时用户);
 *       产线权限由脚本直接向 users.sqlite 种一行 user_line_grants(测试夹具,非平台面)。
 *
 * ——本文件是**入口薄壳**:原单文件(663 行顶层线性脚本)按职责拆到 ./three-system-e2e/ 下,
 *   入口路径与用法保持不变。环境变量语义不变:AW_BASE / KB_BASE / KB_WEB / DIAG_BASE /
 *   E2E_LINE / E2E_DCW_NODE(另沿用 AW_E2E_TOKEN / AW_E2E_ADMIN_TOKEN / KB_MCP_TOKEN /
 *   KB_ROOT / IDD_API_TOKEN / FULL_WAIT_MIN)。
 *
 * 模块划分:
 *   three-system-e2e/lib.mjs                          配置 / 断言与计数 / HTTP 辅助
 *   three-system-e2e/state.mjs                        跨阶段可变状态(getter/setter)
 *   three-system-e2e/phases/phase-0-user-token.mjs    0. 用户 token
 *   three-system-e2e/phases/phase-0a2-line-autoselect.mjs 0a2. 目标产线自适应
 *   three-system-e2e/phases/phase-0b-fixture-grants.mjs   0b. 产线 operate 授权夹具
 *   three-system-e2e/phases/phase-0c-plugin-outbound-auth.mjs 0c. 插件出站鉴权夹具
 *   three-system-e2e/phases/stage-1-health.mjs        Stage 1 系统与插件健康
 *   three-system-e2e/phases/stage-2-teams-tools-hitl.mjs  Stage 2 团队与工具链
 *   three-system-e2e/phases/stage-2-5-team-plugins.mjs    Stage 2.5 团队插件链
 *   three-system-e2e/phases/stage-3-diag.mjs          Stage 3 真实诊断
 *   three-system-e2e/phases/stage-4-plugin-toggle.mjs Stage 4 插件启停
 *   three-system-e2e/main.mjs                         主流程 + 汇总 + 退出码
 */
import { main } from './three-system-e2e/main.mjs'

main().catch((err) => {
  console.error('E2E 致命异常:', err)
  process.exit(1)
})
