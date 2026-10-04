# 循环式全功能验证报告(API/SDK/插件/Agent 实证/稳定性)

日期:2026-10-05 · 零系统代码改动,仅新增测试脚本(tmp-e2e/)

## 1. API 全表面循环测试 —— 44/44 ✅
覆盖 auth(错误密码/无 token 负向)、users(建/登/删)、channels CRUD、messages、events、tasks(判重语义)、queue、dcw(线态/运行门 409/写历史/批次台账)、daq(真实时序/告警/infra/不存在节点)、agent-tools(my_industrial_nodes 正向、dcw_control 禁用负向、未知工具、ops_log、绑定清单)、hitl、ops、audit、memory(agent 作用域读取 50 条 + 语义检索"断流"命中 5)、plugins、teams、notifications、隔离负向(无 grant 用户 0 绑线频道可见/禁用户管理/禁建节点)、清理。
发现小缺陷:不存在 DAQ 节点 samples 返回 500(应 404)——记录待修。

## 2. SDK 行为级实调 —— 12/12 ✅
sdk/index 聚合面:HookBus(异步串行/错误隔离/*/once+退订)4 项语义;createPlatformClient 登录→setToken→health/lines/daq/recipes 真实调用链;createClientContext 构建。

## 3. 插件开发全闭环 ✅
官方 lifecycle 脚本 22/22;**亲手开发测试插件**(驱动 verify-loop-burst + 处理器 verify-loop-norm + 模板 plug-loop-verify + omp 工具 loop_verify_echo)→ 装载(14 插件)→ omp 工具经 agent 实调回显 ✅ → 插件驱动节点经产线门控(挂线后)真实采样 → 帧管线入库+产线打标(line/product/recipe/run 四标注)→ 帧查询回读 ✅ → 清理恢复。
发现小缺陷:DAQ 驱动目录端点不合并插件驱动(builtin 的 verify-burst 也不显示)——可见性缺口,记录待修。

## 4. Agent 实证:数据+运维+下发的真实闭环 ✅
混合协议任务 34c51603 COMPLETED,交付含:ROOT_TIMEOUT 根因自入档(与我方分析一致)、mes_catalog 3 点位发现、mes_fetch 权限拒×3 如实上报(降级走遥测 8.23MPa)、daq 实测 203.805/203.779℃ 带内、**运行门三次硬拒未在跑配方(rc-efd5991e 无活动批次,a5726ec 修复正确工作)、提案包备好不越权**。

## 5. 稳定性循环 ✅
10 轮 × 15s:健康 10/10、采样计数单调增长、零异常。

## 6. 已知问题清单(不阻塞,已入档)
① 排队根任务 ROOT_TIMEOUT 预算挤爆(P0 建议修复);② DAQ 404→500;③ 插件驱动目录可见性;④ AML 场景-控制量发现缺口;⑤ 模拟器进程本机周期性退出(运维)。
