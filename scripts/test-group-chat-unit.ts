/**
 * 群聊 / 权限 / HITL 单元 + 集成测试(主计划 §11 单元 + 集成面)。
 *
 * 覆盖:
 *  - v17 迁移:新表/新列存在;既有 Channel 迁移后仍为 private/owner_approve/owner_only/chat_enabled=0
 *    (即**不改变任何既有可见性/权限行为**);owner 成员记录回填为「有且只有一条 active owner」。
 *  - 权限矩阵:owner-only 管理端点对普通成员 403;成员可群聊读/写;非成员 403;
 *    遗留 owner=NULL Channel 既不可 join 也不可被成员读。
 *  - 成员生命周期不变量(§13.7):owner 不能 leave;移除后立即失去访问;
 *    退出后重新加入 generation+1 且旧审批资格不恢复。
 *  - mention 解析:稳定 ID;文本 @ 服务端重新解析;非本 Channel 目标不投递;
 *    无 @ / 仅 @用户 → Agent 执行次数严格为 0。
 *  - 群聊事实层:clientMessageId 幂等;同一 chat message 对同一 Agent 只一条 delivery;
 *    Agent 回复经 sourceChatMessageId/requesterUserId 定位唯一提问者并自动 @。
 *  - 用户通知:eventId 幂等;跨用户零泄漏;游标补发。
 *  - 白名单投影(§13.1):非管理者快照不含 config/token/workspace/内部 mailbox。
 *
 * 结构:本文件是薄入口 —— 先设置隔离环境变量,再把顺序编排交给 ./test-group-chat-unit/main;
 *       断言框架与场景搭建在 ./test-group-chat-unit/lib.ts,分节场景在 ./test-group-chat-unit/section-*.ts
 *       (每段一个 async function runSectionX(ctx),共享 manager/db/用户 id)。
 *
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-group-chat-unit.ts
 *       (--tsconfig 必需:server 侧依赖 @/* 路径别名;拆分前后一致,与本次拆分无关)
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离:用户仓储惰性 getDb() 会走 AW_DATA_DIR;指向临时目录,绝不触碰真实数据
process.env.AW_DATA_DIR = mkdtempSync(join(tmpdir(), 'aw-chat-test-'))
process.env.AGENTWORKSHOP_TEST = '1'

// 环境变量必须先于任何 server 模块求值 → 动态 import(与拆分前同一时机)
const { runGroupChatUnitSuite } = await import('./test-group-chat-unit/main')
await runGroupChatUnitSuite()
