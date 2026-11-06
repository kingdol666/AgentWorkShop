# Track B 验证记录：Project 层驱动真实 LLM 开发「库存管理单页」演示

日期：2026-11-04（run1–run7）。隔离实例（`AW_MODE=home`，独立 AW_HOME，真 LLM = 本地 omp + LM Studio 9B）。

## 演示目标（用户指定场景）

以「开发一个简单管理系统」为任务导向，观察 Project 层能否真正完成一次项目开发验收：
leader 真 LLM 提案计划 → owner 批准 → 派发工作项 → channel lead 真 LLM 自主执行 → 成果 → 复核 → owner 验收 → 完成门禁 → 项目 completed。

## 断言面（D0–D7，scripts/demo/track-b-mgmt-system.mjs）

D0 隔离实例 · D1 项目/频道/交付物/激活 · D2 leader 真 LLM 提案计划+批准 · D3a 派发 ·
D3b lead 自主执行至 COMPLETED · D3c HTML 工件 · D4a–d 成果/提交/复核/验收 · D5 浏览器验证 · D6 完成门禁。

## 各轮结果（演进史 = 三个真实缺陷的发现与修复史）

| Run | 结果 | 发现 |
|---|---|---|
| run1–3 | root 被 lead 监督回合自动 CANCELED | **真实缺陷 A**：lead 可自取消项目 root → PR16 取消护栏（#38） |
| run4 | 护栏有效（root 全程 WORKING）但 ROOT_TIMEOUT @25% | 小模型执行慢 → 预算 20→45min |
| run5 | 40% 后停滞 | **真实缺陷 B（关键）**：隔离实例 `NUXT_SESSION_PASSWORD`<32 字符 → iron-webcrypto 要求 ≥32 → **agent-token 路由全部 500**（audit：tasks×161/approvals×18/decisions×17）→ lead 一直在"盲执行" → PR18 dev fail-loud 告警（#40） |
| run6 | **D0–D2 ✔ · D3a ✔ · D3b ✔（root COMPLETED）· D4a–d ✔（成果→提交→复核→验收）· D6 ✔（项目 completed）**；仅 D3c/D5 ✖ | server.error=0（修复实证）；工件链缺口：任务**列表** API 按设计置空 artifacts（元数据行视图）；且 9B lead 未把 HTML 放进 complete_task 的 deliverable 参数（lead 无文件写工具，deliverable 是唯一交付通道） |
| run7 | brief 明确「完整 HTML 全文放 deliverable 参数」+ 提取改为 治理链正源（成果 draft summary） | （本轮结论见下） |

## run7 结论（2026-11-04 23:50，最终轮）

**root COMPLETED @100%，工件 3397 字节（name='deliverable'），server.error=0。**
脚本输出 pass=15 fail=2（D3c/D5）——经查证两处 ✖ 均为**脚本提取缺陷**而非 lead 失败：
1. D3c 从任务**列表** API 读 artifacts（该视图按设计置空 artifacts）→ run7 已改从任务**详情** API（`GET /tasks/:id`）提取。
2. D4b 的 project_submit_result 摘要覆盖了 draft 的工件文本（干扰兜底提取）。

**直接从 run7 实例 DB 提取 lead 真实工件后浏览器实测（inventory-system.html / .png）：**

| 验收标准（D1e 定义） | 结果 |
|---|---|
| 浏览器可打开 | ✅ 页面渲染「简易库存管理」 |
| 含商品表格 | ✅ 商品/数量/单价/金额/操作 列表 |
| 支持新增/删除 | ✅ 添加「轴承-6204」×120 @ ¥8.5 → 行出现（+/- 调整/编辑/删除），金额 ¥1020.00 |
| localStorage 持久化 | ✅ key=`inv.v1`，刷新后数据仍在 |
| 含库存统计 | ✅ 「品种 1 种 · 总件数 120 件 · 总价值 ¥1020.00 · 低库存(＜5) 0 种」 |

**验收标准 5/5 全中 —— 一次由 Project 层治理、本地 9B 真 LLM 自主完成的真实端到端项目开发验收。**

## 陈述边界（诚实口径）

- 隔离实例 + 本地 9B 模型：演示证明的是**平台链路**（提案/批准/派发/执行/成果/验收/完成门禁/护栏/内核）在真 LLM 下全通；
  工件质量与完成速度受本地小模型能力限制，不代表接更强 provider 后的表现。
- 验收链的治理语义（幂等/审批 CAS/审计事务化）由 mock 单测与 E2E（64/0）覆盖；本演示是真实 LLM 的端到端佐证。
