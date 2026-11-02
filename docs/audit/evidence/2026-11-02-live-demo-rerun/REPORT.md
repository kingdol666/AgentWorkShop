# 复测报告:F-1 / F-3 修复 + 数采·数控·产线管理·Agent 全链真机复测

**时间**:2026-11-02 16:30~17:00 · v0.8.8(重建产物)· 注塑线 `ln-b715163a` · 频道 `RERUN-产线对话-1102b`(`2bb10927-0dbe-4c94-8554-63fce82c2fb1`)

---

## 0. 结论

**F-1(OPC UA/MQTT 依赖悬空)与 F-3(群聊提问被 poll 抢走、答复不落群聊)均已修复并在真机复测通过:**
- OPC UA 读回成功(保压寄存器 **45 bar**、保时 6 s、注速 85),MQTT 被动订阅零失败;
- 人类群聊提问由消息回合消费并**在群聊得到完整答复**(16:56:07);
- 数控下发 63 bar → 回读 63 → **1 分钟内克重 31.25 → 32.20 g 入窗**;
- 产线 stop(关窗、停采)→ start(11 参数整批 `readback-verified`,新批 `rr-c14ddb76`,采样恢复 32.19 g)。

## 1. F-1:依赖悬空 → 已修 ✅

**根因**:pnpm 虚拟 store 悬空链接 —— `node_modules/.pnpm/node-opcua-crypto@5.6.0/node_modules/@peculiar/webcrypto → ../../../@peculiar+webcrypto@1.7.1/...` 的目标目录不存在;`@babel/runtime@7.29.7` 同样缺失。`pnpm install --frozen-lockfile` 因 `node_modules/.pnpm/lock.yaml` 判 "Already up to date" 而不修复。

**修复**:删除 `node_modules` → `pnpm install --frozen-lockfile --prefer-offline` 全量重装(4m55s,exit 0)。
**验证**:
- `require.resolve('@peculiar/webcrypto')` / `@babel/runtime/helpers/defineProperty` 均命中 .pnpm 实体;
- OPC UA:保压 **45 bar**、保时 **6 s**、注速 **85** 读回 ok;
- 平台日志 `订阅失败` 计数 **0**,PROTO2/3 MQTT 被动订阅全部建立。

## 2. F-3:群聊提问被 poll 读即取 → 已修 ✅

**根因**:`poll_messages` 对非任务消息「读即取」(`ackMailbox` → claim+consumed);而群聊回写 `platformReply` 只在消息回合 `processMessage` 收尾触发。Agent 在 supervise 回合里 poll 到人类提问后,答复只留在其会话,群聊永远收不到(15:15 提问 → 15:50 无回复)。

**修复**:
- `server/services/workshop/types/a2a.ts` 新增 `isHumanChatDelivery()`(有 `x-aw-source-chat-message-id` 且无 `x-aw-from-agent`);
- `runtime/agent-runtime/state.ts` `waitPending` 过滤该类消息(不返回、不认领,留给消息回合);
- `host-tool-bridge/tools/messaging.ts` poll 侧二次过滤(双保险);
- 新增 `tests/poll-chat-filter.test.ts` **2/2 通过**;
- 回归:全量单测 **922 项 / 920 pass / 0 fail / 2 skipped**;`npm run typecheck` 通过;改动 4 文件 ESLint 0。

**验证**:重建 `.output` 后重启,群聊提问 16:39:33 被 lead 消息回合消费(consuming),**16:56:07 群聊答复送达**(全文见 `chat-transcript.txt`)。

## 3. 复测 A:Agent 对话 + 数采判读 ✅

提问(16:39:33)要求:①保压设定值与实际执行值;②克重/熔温/模温/飞边 10 分钟窗口判读;③是否保压执行不一致;只读。

答复要点(16:56:07):
- 保压设定 63 bar;实测执行 **51.88 bar 均值**(inj-pressure-pv,15 s 桶),偏差 **−11.1 bar(−17.6%)**,波动 ±1 bar;
- 克重 **31.247 g**(31.18–31.27)→ 低于下限 0.90 g;熔温 246.68 ℃、模温 39.99 ℃、飞边 0.011% 正常;缩痕 2.16% 越限;
- 结论:**保压不足/补缩不充分**(非热工/飞边约束);引用 dcw_journal(最后写入 10-31 16:17:56)与工艺工程师反算 44.97 bar;
- 明确"本轮未向 PLC/配方写入任何值"。

> 注:答复中"平台和 PLC 侧回读均为 63 bar"一句与实测不符——复测前 OPC 寄存器实为 **45 bar**;lead 未绑定 dcw 节点,读不到寄存器值。核心判断与后续依据不受影响。已立 R-1。

## 4. 复测 B:数控 OPC UA 写穿 + 数采闭环 ✅

| 步骤 | 实测 |
| --- | --- |
| 写前 OPC 读 | hold-pressure **45 bar**;hold-time 6 s;inject-speed 85 |
| 手动写 63 bar | ok:"写入并回读一致:63,回读 63",ack=`readback-verified` |
| 独立再读 | **63 bar**(16:56:49) |
| 数采响应 | 克重 60 s 桶:16:55=31.257 → 16:56=31.482 → **16:57=32.195 g**(进入 [32.15,32.85]) |
| 留痕 | ops_log `dcw.write.manual` 16:56:45 "hold-pressure-sp → 63bar(手动)" |

> 注:DCW journal 未新增锚点(平台缓存值本就是 63,逻辑值未变);物理寄存器 45→63 的变更记录在 ops_log。已立 R-2(建议 journal 以物理回读差值为准)。

## 5. 复测 C:产线管理 stop / start ✅

| 步骤 | 实测 |
| --- | --- |
| stop | run `rr-387b8f7c` `endedAt=16:58:02`;停线后无新样本(末点 32.17 g @16:58:01) |
| start(recipeId=rc-923da07b) | 新批 **rr-c14ddb76** @16:58:18;**11 个参数全部 `readback-verified`** |
| OPC 寄存器 | hold-pressure **63** / hold-time **6** / inject-speed **85**(16:58:23 读回) |
| 采样恢复 | 16:59:02 克重 **32.19 g**(在窗) |
| 留痕 | ops_log `line.start` + 5 条 `dcw.write.recipe`(保压 63/hold-time 6/注速 85/模温 40/锁模 1600 等) |

## 6. 附带修复:F-2(kb-mcp 拖慢会话启动)✅

启动环境补 `RAG_PROJECT_ROOT=D:/codes/ClaudeGPT/rag_project/rag-knowledge`(全局 `~/.omp/agent/mcp.json` 的 `${RAG_PROJECT_ROOT}/kb-mcp` 依赖此变量)。复测会话 **2 秒内**完成 `MCP prompt commands refreshed`,此前需 30s×5 重试。

## 7. 残留观察(非本轮阻断)

| # | 内容 | 建议 |
| --- | --- | --- |
| R-1 | lead 未绑 dcw 节点,读不到寄存器实际值,答复把"设定 63"写成"PLC 回读 63" | 给 lead 绑 dcw 只读即可,或在 line_context 明确"设定/回读/实测"三层口径 |
| R-2 | journal 不记录"逻辑值未变但物理寄存器已变"的写入 | journal 以物理回读差值为准记录 |
| R-3 | 历史 run 存在 `endedAt=null` 残留(rr-34a74744、rr-a5544a3e) | 清理/归档历史 run |

## 8. 判定

- **F-1、F-3 修复并真机验证通过**;F-2 一并消除;
- **数采获取(DAQ)**、**数控下发(DCW,含 OPC UA)**、**产线管理(stop/start/配方整批)**、**Agent 集成作业(群聊对话→取数→判读→答复)** 四条链路全部真机复测通过;
- 车辆级结论不变:受控试点 GO;R-1/R-2/R-3 为可读性/留痕完善项,不阻断。

*证据:`docs/audit/evidence/2026-11-02-live-demo-rerun/`(chat-transcript.txt、rerun-chat1-resp.json、rerun-wr63.json、weight-transition.json、line-stop/start.json、ops-logs.json、f3-unit-test.log、channel-create.json)。*
