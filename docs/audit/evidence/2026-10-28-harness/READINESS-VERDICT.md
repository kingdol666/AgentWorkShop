# 真实产线启用就绪裁决(2026-10-28 harness 能力验收)

**一句话裁决:支持直接在真实产线启用 —— 绑定节点即获得"语义卡注入 + 抓数 + 分析 + 受控下发 + HITL"全链,omp 原生注入与 11 引擎 MCP 桥接双通道就绪;当前唯一硬限制是 OPC UA 族节点的植物耦合(F1,模拟器子模块在途回归),modbus/mqtt/HTTP 族控制链实测物理有效。**

## 实测全链(3470 实例,注塑线 ln-e27a1867,真实 omp 引擎)

| 环节 | 证据 | 结果 |
| --- | --- | --- |
| 按绑定注入 | us102-nodes-response.json | 分析师只见数采卡(附取数指引);工艺工程师只见数控卡:量程[160,300]/配方窗 240℃/当前设定/单步上限 ≤2.8℃/**manual 逐动作 HITL 守则** |
| 数据抓取 | us103-daq-fetch.json | daq_query 121 点熔温(246.78℃)+活动批次 run/recipe 回传指引+工况判读自动注入 |
| 控制下发(负例) | us104-trial.json + hitl respond | 400℃ 越窗候选升级人工闸门,**拒绝+指导**(decisionId 留痕) |
| 控制下发(正例) | us104-105-control-hitl.json | recipe_trial 240→242.8℃ → HITL 批准 ap-74fbc4bb → 整批下发设备证实✓(批次 rr-7b4b40f2) |
| 物理耦合 | 同上 | 熔温基线 246.66 → 90s 后 247.22(**Δ+0.57℃**,理论 ~0.66 吻合)——modbus 路径真通 |
| 台账 | dcw journal | `03:33:07 dw-166865f2 240→242.8 src=recipe run=rr-7b4b40f2` 追溯锚点 |

## 直接启用产线的条件与限制

**条件(全部就绪)**:aw-line-onboarding(供给→forge→verify)或 bench 场景供给;节点绑定(daq 观察/recipe 控制面,权限模型 v2 禁直写节点);频道插件按需开;MCP 集成开关开。

**限制(如实)**:
1. **OPC UA 族控制节点**当前受 F1(模拟器子模块在途回归:变量↔signal 失联)——平台写"回读一致"但植物收不到;真实 PLC 场景不受此模拟器缺陷影响,但联调环境用 OPC UA 模拟设备时控制验证会假通过,建议联调用 modbus/mqtt 族或等子模块修复。
2. **pi 引擎**无程序化 HITL(一次性进程模型);需要 HITL 的控制任务选 omp/ACP 族。
3. 一次性进程引擎(qwen 单飞)steer 降级 deferred。
4. 数采读面为线内全节点设计(绑定管语义卡与控制面;跨线读取才拒)。

## 证据索引(docs/audit/evidence/2026-10-28-harness/)
- HARNESS-MATRIX.md — 14 引擎注入矩阵(omp 原生/pi 扩展/11×MCP 桥)
- us102-toolfaces.json + us102-nodes-response.json — 按绑定工具面与节点卡实调对照
- us103-daq-fetch.json — 绑定 agent 抓数(121 点+判读)
- us104-trial.json — 负例(400℃)与正例(242.8℃)候选
- us104-105-control-hitl.json — HITL 批准→下发→Δ+0.57℃ 物理响应
