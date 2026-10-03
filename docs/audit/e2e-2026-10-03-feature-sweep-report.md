# 全功能全链条穿透测试报告 —— 63 项断言全绿

- **日期**:2026-10-03 · **平台**:AgentWorkShop v0.7.54(生产构建 :3001) · **方法**:前端实际调用的 REST 面 + Agent 工具桥 + 16 页 SSR 渲染验证
- **结论**:✅ **63 通过 / 0 失败** —— 系统全部功能面(认证、产线、产品、配方、节点、写控、开跑、数采、MES、日志、Channel、群聊、任务、HITL、记忆、导出、权限、用户、令牌、插件、设置)穿透通过,16 个 UI 页面全部正常渲染。
- **复跑**:`OMP_LEAD=<omp lead 成员id> node scripts/feature-sweep-e2e.mjs <adminToken>`(幂等,自动清理测试实体)

## 覆盖矩阵(9 域 63 断言)

| 域 | 断言数 | 覆盖点 | 结果 |
|----|--------|--------|------|
| 1 认证与用户 | 5 | me/列表/建号/登录/删号(admin) | ✅ |
| 2 产线/产品/配方 | 4 | 建线/PATCH 线/建产品(挂线)/建配方(挂产品) | ✅ |
| 3 节点域 | 8 | 建 DAQ/建 DCW/双向 test-driver 连通/启停/恢复/**手动写控(治理链)**/配方参数化→v2/版本史 | ✅ |
| 4 开跑与数采 | 4 | 产线开跑(批次创建)/批次列表/DAQ 历史采样/产线停止 | ✅ |
| 5 日志面 | 2 | ops-logs/audit | ✅ |
| 6 Channel/任务/HITL/记忆 | 10 | 建频道(绑线)/公开+群聊 PATCH/加 worker/绑配方/lead→worker **授权+收权**/群聊收发/任务派发(mock 闭环)/HITL 快照 | ✅ |
| 7 MES 与导出 | 5 | mes_catalog/**mes_fetch 实时直读(8.30MPa)**/daq_export 异步 CSV(export_id)/line_context/save+search_memory | ✅ |
| 8 平台面 | 7 | 权限矩阵读写/插件清单/系统设置/**API Token 签发**/健康门 | ✅ |
| 9 SSR 渲染 | 16 | 仪表盘/daq/dcw/monitor/operations/permissions/plugins/settings/tokens/users/logs/workshop×4 | ✅ |

## 关键实证摘要

- **手动写控治理链**:`POST /dcw/:id/write` 返回 ok + 回读(outcome.ok=true),四层限界联锁在位
- **lead→worker 委派**:grant(3 条节点授权)→revoke 全链路 REST 通
- **MES 实时直读**:dw-1c9e0458 经 mes-rest 驱动回 8.30MPa(真实 REST 往返)
- **daq_export**:异步全量导出落 CSV,export_id=daqexp-20261003082845-8
- **Token 自助签发**:POST /api/users/tokens 200(0.7.10 起只存哈希)
- **SSR 全页面**:16 页全部 200 且含页面特征标记(修复 v0.7.52 的 /dcw SSR 500 后回归稳定)

## 方法说明(诚实披露)

- 本轮为**API 边界穿透 + SSR 渲染验证**,非浏览器鼠标级操作——会话中 computer-use/browser-use 依赖的 `mcp__node_repl__js` 工具未挂载;API 面即前端页面实际调用的接口层,SSR 200 + 特征标记验证了页面服务端渲染正常。浏览器内交互(CSS/水合后交互)建议在有 node-repl 的会话中用 browser-use 复验。
- 工具桥类断言(save_memory/mes_*/daq_export)走 real-harness omp lead——mock 引擎无工具桥是既有设计(mock 闭环 13/13 断言"工具桥显式拒绝")。
- 发现的测试侧修正(非产品缺陷):消息载荷为 `{text}`、token 端点为 `/api/users/tokens`、DAQ 模板目录由页面内嵌无 GET 列表端点。
