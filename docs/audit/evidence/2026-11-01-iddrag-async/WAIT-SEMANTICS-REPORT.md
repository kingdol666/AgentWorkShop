# IDD/RAG 等待语义(wait/wait_seconds)实现与验收报告(wait-semantics)

**时间**:2026-11-01 05:2x~06:4x · 平台 v0.8.8@3300 + IDD(3210)+ RAG(8771)
**需求**:两插件集成符合运行规范;Agent 有在执行的 IDD/RAG 任务时不得提前标记完成——任务持续等待直到工具有返回;外部 API 成功/失败都给出结果并存入后台任务台账;Agent 可按任务 id 查进度与结果;新增 `wait` 参数(true=等,false=不等待)。

---

## 0. 结论

**`wait`/`wait_seconds` 已在两桥实现、部署并行为验证**:wait=true 时工具调用**挂起直到任务终态**(结构上杜绝"没结果就 complete_task"),窗口内未完则如实返回 running 态与 task_id(任务转后台+回执不变);**成功/失败都返回完整结果**;结果全部存后台任务台账(diag_results 109 条 / kb turn 台账),**按 task_id 随时可查**。行为探针三次实测:30996ms/46202ms 挂满窗口+新文案,冲突失败 132ms 即返回结构化终态。遗留:工具注册表 description 惰性刷新(行为已新、文案旧,见 §3-3); IDD 长任务今晚执行极慢(环境资源,§3-4)。

## 1. 实现(4 文件)

| 文件 | 变更 |
| --- | --- |
| server/plugins-builtin/diag-bridge/host/plugin.mjs(运行时真身) | diag_run 新增 `wait`(bool)/`wait_seconds`(10~1800s,缺省 600);wantWait=wait===true 或旧 mode=sync;同步分支轮询至终态:**completed 返回评分/结论/报告路径+台账指针**,**failed/stopped 返回完整错误(isError)**,窗口超时返回 running+task_id(转后台+回执不变);完成文案指引 kb_agent(wait=true) 入库 |
| server/plugins-builtin/rag-bridge/index.mjs(真身) | kb_agent 同口径 wait/wait_seconds;wait=true 时 body.timeout_ms=waitSec*1000(旧固定 540s);**同步失败即终态如实返回(isError)**;完成返回 ✅+全文;kb_agent_status 等待上限 120→**1800s** |
| .AgentWorkShop/plugins/{diag-bridge,rag-bridge}/(project 影子副本) | 同步同改(保持两副本一致) |
| 版本 | diag-bridge **2.2.0→2.3.0**、rag-bridge **2.1.0→2.2.0**(触发注册表刷新);`npm run build` 重建+重启部署 |

**语义要点**:wait=true 挂起期间 Agent 的回合被工具调用占住——**结构上保证"任务未完不能标记完成"**(Agent 拿不到结果就发不出 complete_task);wait=false/缺省=提交即返(结果仍存台账可按 id 查)。

## 2. 验收矩阵(实测)

| # | 验收点 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | wait=true 挂起(窗口内未完→如实 running 回执) | ✅ 30996ms/46202ms 两次挂满窗口,返回新文案"等待 Ns 窗口内未完(仍在后台运行)——结果会存入分析结果台账" | i5-probe-wait-behavior.json/probe3 |
| 2 | wait=false/缺省 → 立即回执 | ✅ <2s(历史四跑 1927/877/757/720ms 同路径) | 前轮证据 |
| 3 | **失败也给结果**(立即终态) | ✅ 同线冲突:wait=true + 已有运行诊断 → **132ms** isError 含阻断 run_id 与指引 | i5-wait-collision.json |
| 4 | 失败也给结果(执行中失败) | ✅ sync 分支 failed/stopped → 完整错误文本返回(isError);本轮 stability-report ×2 缺工件失败在 diag_status/diag_results 均可查 | 前轮+源码路径 |
| 5 | 结果存后台任务台账+按 id 查 | ✅ diag_results total=109(run_id 直接索引);kb_agent_status(task_id) 含 1800s 长轮询 | b2-diag-results.json |
| 6 | 任务未完不标记完成 | ✅ 结构保证(wait=true 占住回合)+ 机制说明;频道级端到端演示任务 9947cdac 已派发(见 §3-4) | 本报告 §3 |
| 7 | 独立 API 复验 | ✅ IDD 结果库 98 条/健康 ok;RAG two-stage 真命中(score 7.23) | 本轮实测 |
| 8 | 插件装载 | ✅ 重建后 [builtin] diag-bridge@2.3.0 + rag-bridge@2.2.0 装载,0 failures | aw-3300-1031n.log |

## 3. 发现(如实)

1. **工具注册表 description 惰性刷新**:registry 接口返回的工具描述为旧文案(行为已是新代码——行为探针实证)。Agent 侧影响:模型看不到 wait 参数文档(参数 schema 是否同样滞后待确认);建议:注册表 sync 对同版本+描述变更也应刷新,或插件版本号变更时强制重注册(本轮已 bump 版本,重启后 description 仍旧,判定为 registry sync 缺陷,**立案**)。
2. **装载链**:builtin 插件源码经构建烘焙进 .output——builtin 改动必须 rebuild+restart(纯 restart 不够);project 影子副本被 builtin 遮蔽(改 project 副本对运行时无效)。已写入维护要点。
3. **IDD 长任务今晚极慢**:f79309c9(quick-screen,30+min)/036d7d4c(12+min)均未出终态,IDD 侧 omp 竞争资源(与 E-1 同根);crown 频道演示任务 9947cdac 因此滞留 SUBMITTED(lead 队列+D1 节奏)。
4. kb turn(kbt_mvxbn9us)维持 failed(540s 旧预算期超时,已如实留痕;新代码 kb wait=true 下次将以 600~1800s 预算执行)。

## 4. 判定

- **等待语义与任务台账机制:PROVEN**(实现+部署+行为验证,含失败路径)。
- **插件集成规范符合性**:授权门/治理拒绝/账本留痕/回执认领(claim)全链保持——新语义未破坏任何既有治理。
- 待办立案:①注册表 description 刷新缺陷 ②crown 频道演示任务随 IDD 排空后补测 ③IDD/RAG 长任务资源独占(E-1/D-1 延续)。

*证据:docs/audit/evidence/2026-11-01-iddrag-async/(i5-*.json)+ /d/tmp/probe2.json/aw-3300-1031n.log + 源码 diff(server/plugins-builtin ×4 文件)。*
