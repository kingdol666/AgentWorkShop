# 实机操作演示(2026-10-28)——v0.8.6 全功能真机走查

- 实例:`http://127.0.0.1:3415`(隔离 AW_HOME=`D:/tmp/aw-live-demo-20261028`,生产构建 `.output`,version **0.8.6**;演示后保留运行供查看)
- 模型:本机 LM Studio `qwen3.5-9b-32k`,harness = **omp 真实子进程**;作业身份 = **worker**(实机演示-作业员)
- 演示方式:浏览器真实点击(登录/导航/界面批准),任务经平台 API 下发;全程截图入本目录
- 种子脚本:`scripts/live-demo-seed.mjs`;状态台账:`.omc/live-demo-state.json`

## 演示时间线(全部为实机操作)

| # | 操作 | 画面 | 结果 |
|---|---|---|---|
| 1 | 浏览器打开首页 → 登录弹窗输入演示管理员账密 → 登录 | `01-dashboard.png` | 仪表盘:产线 1/1 运行、累计 97 样本、14/14 执行引擎、v0.8.6 |
| 2 | 侧栏进入「数采中心」 | `02-daq-live.png` | 腔体温度实时 **107.04C**、配方越限告警在列、管线 发布 127/入库 127/丢失 0、实时事件流滚动 |
| 3 | 点击产线链接进入「产线运营」 | `03-line-before.png` | 温度设定 **60.00C(已 ACK)**、配方 v1(50~70C/单步 4C)、写历史 1 条 |
| 4 | 查看「Agent 模板库」 | `04-agent-templates.png` | 实机演示-线长/作业员(omp,私有,实例数 1)在册 |
| 5 | REST 下发任务 `d773244a` 给 worker(四步剧本) | — | 任务 ASSIGNED,omp+Qwen3.5 起回合 |
| 6 | worker 依次调用 `my_industrial_nodes → daq_query → recipe_trial`;**HITL 卡挂在产线页** | `05-hitl-card.png` | 卡面:试验下发 · 实机演示配方 · 批次 rr-79a39;**Agent 理由**(数采证据 60→56);参数对照 60C→56C;意见框+批准/拒绝 |
| 7 | **在界面上**填写裁决意见并点击「批准」 | — | 卡消失,写历史新增 `56 raw 56 ACK(批次 rr-cdd17637)` |
| 8 | 回到产线页(刷新) | `06-line-after-56c.png` | 当前设定/PLC 读数 **56.00C(已 ACK)**、写入 2 失败 0、**配方仍 v1**(trial 不写版本)、新批次 rr-cdd17637 在册 |
| 9 | 任务收口 | `task.json` | **COMPLETED/100%**;交付物含节点卡(单步≤4C/窗口/量程)、daq_query 判读(21 桶点/均值 107.04C)、recipe_trial 完整回执 |
| 10 | 「产线日志」审计 | `07-audit-log.png` | `recipe.trial`(Agent 作业员,证实 1/1,60→56,含假设)→ `recipe.dispatch.ack` → `dcw.write.recipe` → 告警 `daq.alarm.raise` → `line.start` 全链 10 条留痕 |

## 独立核验(REST 复核,与 UI 互证)

- 账本锚点:60→56(16:26:04)与 null→60(16:15:37)两条;
- 审批历史:`ap-6fe7ffe4` status=approved,comment="实机演示:依据数采证据批准 60→56C 试验";
- 任务:COMPLETED,progress=100,assignee=worker;
- 配方版本:界面「版本历史 · v1」(trial 不写版本 ✓)。

## 门禁复核(演示前重跑,日志入 `logs/`)

| 项 | 结果 |
|---|---|
| lint / typecheck | 0 / 0 |
| 单测 | **739/739** |
| 产线治理 e2e | **44/44** |
| npm registry | `agentworkshop@0.8.6` |

## 覆盖边界(诚实声明)

- 设备为内置 mock(DAQ 数值恒 107.04C、DCW 写入回显+独立读补验),**无物理工艺响应耦合**;
- `complete_task` 由平台按交付物隐式收口(Qwen 未显式调用,`task.json.toolCalls` 如实记录);
- OPC UA 子模块(F1)未在本次演示路径内;生产试点前置清单见 `docs/audit/2026-10-28-multiexpert-remediation-acceptance.md` 第五节。
