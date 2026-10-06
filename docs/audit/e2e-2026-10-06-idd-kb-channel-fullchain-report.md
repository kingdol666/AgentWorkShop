# IDD×KB 插件 Channel 内全链实测 —— 数采→分析→入库→检索两轮闭环报告(2026-10-06)

> 场景:模板 859c2742「哨兵巡检-入库工作流」全新实例化 Channel 37599c0d(绑线1 ln-d7e0a2a2),PLC 保持 disturb 强化工况,IDD(:3210)+rag-knowledge(:8770/:6789)双插件在线。模板种子任务 5694caa4 与外派任务 c827cdc9 **先后完整执行同一全链条,双双 COMPLETED、8/8 环节留痕**;每一跳均由测试者用独立通道(磁盘/IDD API/KB API/平台代理)交叉核验。

## 结论(TL;DR)

**全链条真实打通,两轮复现,插件模块化集成与「取数→分析→入库→检索」闭环均确认可行。** 无一处 mock:数采数据出自 TimescaleDB 真实样本(5000 行宽表),IDD 哨兵亚秒完成确定性统计(137/159 条告警),KB 入库过 A0 去重裁决与 A7 八项终检,闭环检索新文档 Rank #1(0.8524/0.9120)。agent 判读质量高:137/159 条告警未被数量带节奏,以 R1 run_length=1 孤立单点、regime steady 全窗一致、晶点整数计数已知假阳性等机理证据判定「受控稳态,不提案」,与历史指纹互证。

## 1. 完整作业流程(实测口径)

```
设备层   PLC 模拟器 :4010(castfilm,disturb:heaterDecay 2.5/进料漂移 0.6)
数采层   4 节点(modbus-tcp/rtu 桥)→ TimescaleDB(15s 桶,实时可查)
模板层   859c2742 一键实例化 → Channel 37599c0d + omp lead + 种子巡检任务自动入队
接线     admin 绑 daq×2 + recipe(manual);插件 settings 补 exchange_dir 引导
执行层   lead(GLM-5.3-flash)领任务:
         ① daq_export(merge:true) 2 节点×5000 行宽表
         ② 全窗+近窗 400 行双份 CSV 入 IDD 沙箱交换目录
         ③ 基线保障(有则复用/无则 sentinel_baseline)
         ④ sentinel_screen 快筛 + sentinel_watch 全窗批筛(异步 task_id)
         ⑤ kb_agent 检索历史结论(6~8 篇 P0,带匹配/排除理由)
         ⑥ kb_agent 异步入库(regime_key 场景化,A0→A9 门控)
         ⑦ 控制判断分支:受控→不提案留证;非受控→recipe_propose(HITL 五要素)
         ⑧ complete_task 全链自评交付(a2a.artifact)
治理层   HITL 审批卡/五要素提案/KB A0 去重裁决+A7 终检/记忆 dedup/共享记忆沉淀
观测层   AEP 事件流(seq 帧序)/ops 审计/IDD watch_report.md 落盘/KB 文档落盘
```

## 2. 两轮执行与四跳独立核验

| 跳 | 轮1(5694caa4,模板种子) | 轮2(c827cdc9,外派) | 测试者独立核验 |
|---|---|---|---|
| ①数采→文件 | `daqexp-20261006093952` 5000 行(06:47~09:39) | `daqexp-20261006100448` 5000 行(07:11~10:04) | 磁盘 wc -l=5000✓,首尾值与 DAQ API 同区间(204.1~207.4℃)✓ |
| ②IDD 分析 | screen 6 条;watch `SNW…1mizc3022` **137 条**(R1×18/R5×39/R6×42/R2×34/R3×4) | screen 10 条;watch `SNW…pfgv07024` **159 条**(R1×23/R5×46/R6×47/R2×39/R3×4) | IDD API 直查:completed/alert/5000 行✓;watch_report.md+alert.json 落盘✓(50ms 确定性计算) |
| ③结果入库 | `kbt_muw0s08b` → doc `982e9f8a`(9 chunks,regime_key=steady206-20261006) | `kbt_muw1lm7t` → doc `beaa8ecd`(10 chunks+图谱 related=10,A7 八项终检过) | KB 存储 9→10→11 项落盘✓;web 任务 API 直查 completed✓ |
| ④KB 检索 | 入库前检索命中 6 篇 P0 取判别指纹;入库后探针 Rank#1(0.7297) | 命中 8 篇(regime_key 全链对齐);闭环探针 Rank#1(0.9120) | 平台代理 /search 复测:新文档第 1 名 score 0.8524✓ |

**KB 治理亮点**:轮2 入库时 A0 去重检出与轮1 文档相似度 **0.9402**,经内容裁决确认「同系列不同轮次」(时间窗/导出ID/批筛task_id/基线均不同)放行——重复入库防护与系列化归档同时成立。

**记忆连续性**:轮2 开场自动召回轮1 情景记忆(score 0.99,命中率 98%),直接复用交换目录允许根、命名规范与受控判别指纹,执行节奏显著快于轮1;收尾将「交换目录实测值+受控指纹」沉淀进 Channel 公共记忆(dedupKey 生效)。

**跨轮判读一致性**:轮1 137 条 vs 轮2 159 条,两轮独立得出同一「受控稳态」结论,且证据可复算(熔体 mean 206.04/206.031℃,σ 0.399/0.403,σ比≈1.00;GOAL 余量 +0.53℃;晶点假阳性 54~64% 与历史同源)。

## 3. 问题收集(本轮新增/复现实证)

### D6(P2,新发现,已定位根因):IDD 插件回扫键不一致,清单永停 running
- 现象:IDD 服务端 5 个任务 4 completed/1 failed,插件 kv.json `idd_closedloop_runs` 全部停留 `running`;每 15s sweep 永久重轮询已终态任务。
- 根因:`plugins/idd-closedloop-bridge/host/plugin.mjs:44` 完成分支写 `ctx.kv.set(runKey(id),…)`(单任务键 `iddcl:<id>`,helpers.mjs:63),而 sweep 扫描与展示读的是清单键 `idd_closedloop_runs`(helpers.mjs:48);中间态分支(plugin.mjs:46-48)反而正确写回清单。结果/轮询双失真,重启后仍复现。
- 修复建议(≈10 行):完成分支改为按清单映射写回(复用 else 分支模式,单任务键可保留作结果缓存);装载时加一次对账(把 kv running 而 IDD 已终态的任务收敛)。

### D1 族(P1,既有第一缺陷,本轮 +2 例):lead 入场/续跑卡滞,需人工唤醒
- 例1:频道实例化后两任务在队,lead idle 心跳正常但不领取,activate+A2A immediate nudge 后立即入场。
- 例2:轮1 COMPLETED 转 idle 后不领轮2,同样 nudge 后立即执行。
- 平台缺「任务入队/任务完成 → lead 确定性唤醒」事件,当前靠 omp 轮询(15min 起)。本轮再次验证:nudge 即愈,指向调度触发缺失而非会话本身。

### 次要(记录在案)
- SNB 首试被 IDD 沙箱拒(`data/idd-in` 在允许根外,exit=2 显式报错)——agent 读 kv 历史自愈换到 aw-exchange;建议 daq_export 输出文本直接拼接 exchange_dir 提示,把自愈变免疫。
- task.state 全程显示 SUBMITTED 直到 COMPLETED,缺 RUNNING 中间态(队列视图可读性)。
- AEP 工具帧完成侧显示 `[object Object]`(D4 已知,本轮再现)。
- kb_agent 异步入库 6~8 分钟,agent 只能 sleep 轮询(还撞 eval 30s 上限,靠自拆步长绕过);建议 kb_agent_status 支持长轮询或完成回写 AEP 事件。
- 测试侧插曲:误重跑 setup 脚本多建一个频道,已删除(55fb7f7a);上轮 root_timeout_ms 清理未生效(本轮实测为 3600000,已恢复 900000)——设置类清理动作应有断言而非仅执行。

## 4. 优化 Plan

| 级 | 项 | 动作 | 预估 |
|---|---|---|---|
| P0 | D6 回扫键不一致 | plugin.mjs 完成分支写清单+启动对账;补一条「kv running 且 IDD 终态→收敛」回归断言 | 0.5 人日 |
| P1 | D1 调度唤醒 | 任务入队/完成事件触发 lead 唤醒(平台级,既有首要缺陷,本轮 +2 例证据) | 1~2 人日 |
| P1 | KB 长任务等待体验 | kb_agent_status 增 wait_seconds 长轮询(≤120s);或完成态回写 AEP 事件供订阅 | 0.5 人日 |
| P2 | 沙箱路径免疫 | daq_export 结果文本拼接 exchange_dir 提示(读插件设置或平台共享 hint) | 0.5 人日 |
| P2 | task RUNNING 中间态 + [object Object] 帧修复 | 状态机补中态;工具帧完成侧载荷取字段修正 | 0.5 人日 |
| P2 | 晶点计数口径 | 泊松/3min 窗变换消 54~64% 假阳性(KB 已双留痕) | 1 人日 |
| P2 | v9 配方 205 vs 实值 206 | 人工 recipe_update 固化(遗留第三轮) | 人工裁决 |

## 5. 系统设计与插件集成设计评价

**插件模块化集成:优秀,可作范式。** 三证据:①接缝窄——两插件各以 1 个单入口工具(kb_agent)+9 个哨兵/经验/寻优工具暴露能力,平台只见 task_id 与文本结果,内部引擎可整体替换;②异步范式统一——提交即返 task_id + status 查询 + 回扫兜底(回扫有 D6 但模式本身对);③治理内嵌——KB 侧 A0 去重内容裁决(0.9402 相似仍能分辨轮次)、A7 八项终检、图谱关联,IDD 侧路径沙箱显式拒绝,安全和质量门在插件内部闭环,不依赖平台兜底。

**全链闭环:真实可行。** TimescaleDB 真样本 → 宽表 CSV → IDD 确定性哨兵(50ms/万行) → KB 场景化归档 → 亚秒检索回命中,两轮全链 8/8 留痕;判断分支(受控不提案/非受控提案)有历史指纹库支撑,跨轮结论一致可复算。

**系统短板依旧在调度层**:lead 唤醒缺失(D1)是当前唯一需要人工扶一把的环节;其余均为可定位、可小步修复的工程缺陷(D6 即 10 行级)。平台的「数据-分析-知识-控制」分层与治理设计经受住了连续两轮真实工况检验。

## 6. 留痕

- Channel `37599c0d-b99b-417d-936f-46d356e63027`(模板 859c2742,线1 ln-d7e0a2a2,lead 780bd82c)
- 任务 `5694caa4`(模板种子)/`c827cdc9`(外派)均 COMPLETED,8/8 留痕
- 导出 `daqexp-20261006093952-f924e5` / `daqexp-20261006100448-eba3c8`;交换目录 `line1-*-20261006T0940/1004.csv`(全窗+近窗)
- 批筛 `SNW-20261006014144-1mizc3022`(137)/`SNW-20261006020512-pfgv07024`(159);基线 `SNB-20261006015834-b3nsq4023`(纯稳态重刷,center 205.993/σ0.405)
- KB 文档 `982e9f8a`(轮1)/`beaa8ecd-b814-4206-b27f-85fda23b7539`(轮2);KB 异步任务 `kbt_muw0s08b_f336155d`/`kbt_muw1lm7t_616c5fbf`
- 测试脚本:tmp-e2e/{setup-round,dispatch-task,watch-chain,ev-detail,artifact-read,kb-verify,kb-probe,idd-verify,lead-check,nudge2,nudge3}.mjs(不提交)
- 设置恢复:workshop.root_timeout_ms=900000 已确认;exchange_dir=D:/codes/industrial-deep-diagnostic/workspace/aw-exchange 保留(属插件常规配置)
