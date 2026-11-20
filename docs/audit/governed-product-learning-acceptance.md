# 受治理产品学习：隔离软件与模拟验收（Task 13）

> 范围：**候选分支 + 隔离影子孪生**。本文件是机制与证据结论，不是现场准入、安全认证或收益验证。
> 运行环境、模型来源、失败分母与未覆盖项逐条记录；物理与外部依赖单列，不用夹具补结论。

## 1. 本轮执行事实（2026-11-20 TSA3）

| 项 | 值 |
| --- | --- |
| 代码基线 | 远端 `main` `58d6d703`（PR-A 合并后）；候选分支含 PR-B/C/D/E |
| 实例 | AW 0.13.0，持久 home 复活（`AW_MODE=home`，隔离端口 3021） |
| 模型 | omp rpc / ustc-deepseek-flash（真实模型回合；非 mock leader） |
| 模拟目标 | 影子孪生 `:4056`，归属证明 bundle 在档（api 4056 / mqtt 64830 / modbus 37642,37646 / opcua 37648） |
| 证据目录 | `docs/audit/evidence/2026-11-20-governed-acceptance-round/` |

## 2. 检查项与口径

| ID | 内容 | 结论 | 证据 |
| --- | --- | --- | --- |
| A1 | 真实工况文档 → 节点/场景 → 绑定 → 频道 | PASS（V6 按既有口径 SKIP） | provision 33/33、forge 15/15、verify-line 24/24、冒烟回读 72=72 |
| A2 | 受控下发 + 独立回读 + 负例 | PASS | 七轮复合调参 31.03→32.58g 进带；越量程 400；跨用户 403 |
| A3 | RSI 候选/晋升门/人审拒绝 | PASS（含反射缺口证据） | 3 条负样本候选；单条晋升门拒；人审拒绝负证据晋升 |
| A4 | 记忆沉淀与召回；kb_agent 终态 | PASS（含降级可见性） | save/search 往返；kb_agent 内部权限拒 → 只读降级并如实回答 |
| A5 | 跨频道消息双向 | PASS | 送达+回执+反向送达+共享记忆落账 |
| A6 | 产线 Project 编排收口 | PARTIAL | leader 规划→批准→R1s/R2s 完成；完成后无产物且无返工通道（记为缺口） |
| A7 | 非产线 Project（落地页） | PARTIAL | W3 交付 40054B/自测 62/62；正式提交/L1 在途 |
| A8 | 物理现场 | NOT_RUN | 全程影子孪生；无现场签核 |

## 3. 可复现运行

```bash
# 1) 隔离模拟清单必须先通过预检(未知/非模拟/未证明归属 → BLOCKED,不启动任务)
node scripts/acceptance-governed-product-learning.mjs --manifest <signed-simulation-manifest.json>

# 2) 汇总索引(严格口径:非终态不计 PASS、无 decisionId 不计 PASS、物理恒 NOT_RUN)
node scripts/acceptance-governed-product-learning.mjs --manifest <manifest.json> --index docs/audit/evidence/2026-11-20-governed-acceptance-round/acceptance-index.json
```

清单字段：`environment` 必须 `simulation`；`revision` 固定；`awHome` 隔离；`allowedTargets/targets`；`ownershipProofRef` 指向可读归属证明；`arms[].dataRoot` 互不复用；凭据只允许 `vault:`/引用形式。

## 4. 明确不主张

- 不把影子孪生结果记为物理 PLC/HIL；不把 32.58g 进带记为冻结协议下的效果验证（效果验证为 `NOT_RUN`）。
- 不把客户端自报评测当发布证据（PR-C 起晋升门要求宿主来源）。
- Mimosa 提交扫描在本分支不完整（`scanner_enobufs`），不作为安全结论。
- 现场准入以独立清单为准，本文件不替代。
