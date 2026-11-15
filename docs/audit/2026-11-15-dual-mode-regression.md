# 双模式 Channel 全功能回归（2026-11-15）

**结论：PASS（修复一个 P0 后）**。在 `main@79723a85` 上完成 generic 与 production_line_integrated 两种 Channel 的完整回归，并修复 PR #221 引入的 Channel 激活 500。

## 结果汇总

| 层 | 结果 |
| --- | --- |
| 静态门禁 | lint / typecheck / i18n 3342 parity / docs 87-0 全绿 |
| 单元 | `test:unit` **1720/1720**；双模式 focused **67/67** |
| 辅助契约 | MCP 14/14、plugin 22/22、SDK pass、twin 5/5、skills 167/167 |
| 构建/启动 | `npm run build` 通过；`.output` 隔离 home `/api/health=ready` |
| REST 实机 | 双模式 **68/68** |
| 真实 harness | omp + USTC/deepseek-flash **50/50** |

## 双模式判定

- 两种模式均具备完整 Channel 框架能力：群聊、memory、mailbox、task、session clone、协作工具。
- generic：不注入产线上下文与工业工具；执行面也拒绝工业工具（fail-closed）。
- production_line_integrated：注入工业只读工具与绑定产线/产品/会话快照上下文；会话快照在频道 rebind 后保持不变；模式切换只回收基础运行时，既有会话 clone 保持冻结模式。

## P0 修复

PR #221 的 `wireMember` 解构 `setChannelSessionScope` 后裸调用，丢失 `this`；所有 `BaseAgentImpl` 系 harness（omp/claude/codex/…）在 Channel 激活时 `TypeError: reading 'bridgeCtx'`，`POST /channels` 500。修复为保留接收者调用，并新增 `tests/channel-session-scope-wiring.test.ts`。修复后真实 omp 双模式 50/50。

## 边界

模拟产线 + mock 数采；工业工具只读；无物理 PLC/HIL 写；未做浏览器像素走查。

Mimosa 深度扫描已执行并产出 seal（`scan-2026-11-15T04-19-13.703Z-d5fddcefc407`），但覆盖状态为 **partial / inconclusive**、47 条静态 advisory，**未通过安全验收**，不宣称项目安全。

完整过程、逐项断言与复现命令：`docs/audit/evidence/2026-11-15-dual-mode-regression/REPORT.md`。
