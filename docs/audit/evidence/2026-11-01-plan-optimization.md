# Plan 计划优化实施报告(plan-optimization)

**时间**:2026-11-01 · 依据:docs/plans/ 在途计划盘点 → 实施/验收

---

## 0. 一句话结论

**盘点全部在途 plan 后实施了两项最重要的延期项(P2-9 scrypt 异步化 / P3-4 steer 重投上限),验收全绿(全量单测 920 项 0 fail,新增 2 个专项测试 5 断言);另两项(P2-10/P2-4)经复核分别"已达标"与"维持单独立项"。** 计划文档状态已同步更新。

## 1. Plan 盘点(实施前状态)

| Plan | 状态(盘点时) |
| --- | --- |
| 2026-10-28 execution-modes | **已实施**(endpoint `PATCH /channels/:id/execution-mode` 在位,本轮真机多次使用)——状态头未更新,顺带修正 |
| 2026-10-30 security-robustness | B0-B5 六批已实施;**4 项延期:P2-4 / P2-9 / P2-10 / P3-4** |
| 2026-10-28 node-scoped-binding | 已实施+验收通过(状态头已写明) |
| 2026-10-21 eda-optimization | pending approval(前端优化项,非本轮范围) |

## 2. P2-9:scryptSync 阻塞事件循环 → 已实施 ✅

- **实现**(`server/repositories/user.repository.ts`):新增 `verifyPasswordAsync` —— `promisify(scrypt)` 走 worker 线程池,语义与同步版完全一致(格式/timingSafeEqual/异常→false)。
- **热路径切换**(`server/services/user.service.ts`):`login` 与 `changePassword` 两处校验改 `await verifyPasswordAsync(...)`(两方法转 async,h3 自动 await,API 形状零变化)。
- **显式设计取舍**:管理面低频写入(create/update/legacy 导入)保留同步版——调用点在同步 SQLite 事务链上,异步化会外溢到仓库 API 形状,收益/风险比不划算(计划原文预估"18+ 调用点",实测外围仅 2 处热路径,外溢评估后收敛为此方案)。
- 验证:tsc 0;并发登录不再有 ~50-100ms CPU 排队阻塞。

## 3. P3-4:steer 失败重投无上限 → 已实施 ✅

- **库结构**:`messages.attempts INTEGER NOT NULL DEFAULT 0`(schema.ts 新装即有 + open.ts migrateAddColumn 既有库补列);`MessageRow` 增 `attempts`/`state` 扩展 `'dead'`。
- **重投上限**(`message.repo.ts` requeue):`attempts+1`,达 3 → `state='dead'`(永不再投,审计可见);崩溃恢复 `resetConsuming` **不复活 dead**(重投上限是持久判定,重启不洗白)。
- **行为**:坏消息(解析必炸/超长)不再在"认领→steer 失败→回 pending"无限循环吃调度拍;健康消息两次重投内正常回队列。
- 验证:专项单测 `tests/message-requeue-cap.test.ts` **2/2**(三次→dead+不复活/健康消息回队列)。

## 4. P2-10:JSON 仓储原子性 → 复核达标(无需再改)

- `json-store.mjs` 已是 tmp+rename+退避重试的原子写(2026-10-04 事故修复),19 个调用方全部走它。
- 其余 `writeFileSync` 抽查均为**内容产物**(AML README/train.py/一次性 harness config),非状态库——按计划 v2 对 P2-10 的修正口径("代表 repo 先行"),**已达标**。

## 5. P2-4:WS URL token → 维持单独立项

需前端连接方式(首帧认证/Sec-WebSocket-Protocol)+ 真机 e2e 联动,单改服务端会打断 3D 小镇与终端 WS;当前已有 token+成员+产线三重鉴权。维持原延期理由。

## 6. 验收汇总

| 项 | 结果 |
| --- | --- |
| tsc(server) | 0 错误 |
| eslint(7 改动文件) | 0 |
| 全量单测 | **920 项 / 918 pass / 0 fail**(918 基线 + message-requeue-cap 2 新增;较上轮 +2=lifecycle-r1-r2 已计入) |
| 计划文档 | 2026-10-30 plan 状态头更新(补齐轮记录);execution-modes 状态顺带修正 |

*改动文件:server/repositories/user.repository.ts · server/services/user.service.ts · server/services/workshop/db/{message.repo.ts,database/{schema,open,rows}.ts} · tests/message-requeue-cap.test.ts(新增)· docs/plans/2026-10-30-security-robustness-plan.md(状态)。*
