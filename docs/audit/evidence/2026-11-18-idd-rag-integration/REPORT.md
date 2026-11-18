# IDD 与 RAG 系统集成实测报告(2026-11-18)

> 轮次目标:启动简单案例,调用 IDD(diag-bridge)与 RAG(rag-bridge)两插件集成,查看执行如何。全部真实后端、真实数据、真实链路。

## 1. 集成前状态盘点(G001)

| 系统 | 后端 | 探测结果 |
| --- | --- | --- |
| IDD(diag-bridge v2.2) | http://127.0.0.1:3210 | remote **ok**,activeRuns 0,engine harness=omp(在 IDD 侧,与平台解耦) |
| RAG(rag-bridge v2.1) | http://127.0.0.1:8770(backend)+ :6789(web) | backend **healthy**;/api/* 开启鉴权;开放注册 |

两桥初始均为匿名配置 → 真实调用分别卡 401(诊断快照上传)与 401(kb API)。

## 2. 鉴权打通(合法路径:本地实例开放注册,注册**全新**本地账号,零凭据复用)

1. RAG:`POST /api/v1/auth/register`(awdemo-nwtkmg)→ login → `POST /api/v1/auth/tokens`
   铸 sk- API token(365d)→ 平台 `PATCH /api/system/settings` 热配
   `plugins.rag-bridge.token` → health:`auth=bearer, token accepted=true`,
   **ensureKB 自愈建库 kb.id=3aea5973(aw-industrial)**。
2. IDD:`POST /api/auth/register`(iddnwtkmg)→ login(session)→ `POST /api/auth/tokens`
   铸 idd_ token → 热配 `plugins.diag-bridge.token` → health:`auth=bearer, accepted=true, remote auth ok`。

## 3. IDD 实测:quick-screen 简单案例(G002)✅ 全链闭环

- 发起(以数据工程师 Agent 身份经 invoke 桥):`diag_run{line=ln-58f3a3eb, 窗=150min,
  analysis_intent=quick-screen, wait=true}`;提交后 run_id=**0802a2c5**。
- 链路:平台 DAQ 快照导出(1798 行,2.5h 窗)→ 上传 IDD(鉴权后通过)→
  IDD 侧 industrial-sentinel `watch` 批筛(纯分析,零 LLM 零网络)→ 完成。
- **结果:completed · alert · 82 alerts**(SPC 判异 82,多变量离群 0,
  告警最多参数=**dn-03084b36 主轴实测温度**——恰为本轮 156→138 下行的被控量,
  分析对象精准);7 工件(ontology/sentinel alert.json/watch_report.md/
  quick_screen_report.html/report.md);每个数字带溯源(工件路径#字段);
  HTML 看板在线可看;run 可续聊。
- **结果库**:默认关闭(数据边界设计),本轮由 admin 显式开启
  (`plugins.diag-bridge.results_enabled=true`)后入册;`diag_results` **仅 lead 可读**
  的权限模型在 worker 调用下正确拒绝(治理面正样本)。
- 过程韧性:分析期间平台健康探针两次误杀自愈重启,**IDD 侧分析独立存活不受影响**
  (分析业务与平台解耦的设计得到实证)。

## 4. RAG 实测:入库→检索闭环(G003)✅ 全链闭环

- **入库**:`POST /api/v1/experience/{kb}/search` 同族 REST ——
  `POST /api/v1/experience/{kb}` 写入《CNC-850 主轴热漂移治理:受治理小步探索闭环》
  (category=optimization;含 SP↔PV 因果数据、四步 HITL 链、复测 3/3、CI 判定)
  → **200,exp-c600290408ec**。
- **检索**:`POST /api/v1/experience/{kb}/search{query:"CNC-850 热漂移 治理 SP PV 闭环"}`
  → **200,命中 3 条,新入库经验排名第 1**;同时命中历史既有经验(库为用户长期运行实例)。
- **agent 面如实**:`kb_agent(mode=sync)` 依赖知识库内部 agent 回合,本轮该回合挂断
  (桥接层报错信息本身即指引:改用 async + kb_agent_status);REST 面已完整证明集成。

## 5. 平台防线与治理(正样本)

- results_enabled 默认关闭 = 数据边界决策由 admin 裁定(本轮显式开启并记录)。
- diag_results lead-only 权限模型:worker 调用被拒,行为正确。
- 系统设置写入留痕(system.settings.update;值不落审计——凭据保护)。
- IDD 分析与平台解耦:平台重启不影响分析任务存活。

## 6. 如实边界

1. kb_agent 的 sync 模式依赖 RAG 内部 agent 回合,本轮回合挂断(未解,属 rag-knowledge
   内部引擎稳定性;REST 面不受影响)。
2. rag web(:6789)探活超时(文档写盘面),后端 API 面不受影响。
3.IDD 分析期间平台探针误杀重启×2(supervisor 已知行为,防线正确,但打断平台侧交互)。

## 7. 集成评分

| 维度 | IDD | RAG |
| --- | --- | --- |
| 后端健康 | ✅ | ✅ |
| 鉴权打通 | ✅(注册→铸 token→热配) | ✅(同法) |
| 简单案例执行 | ✅ quick-screen 82 alerts 完整报告 | ✅ 入库+检索第 1 命中 |
| 结果/知识沉淀 | ✅ 结果库+溯源+HTML 看板 | ✅ aw-industrial 库持久 |
| 治理/权限 | ✅ lead-only 结果库正确拒 worker | ✅ token 热生效 |
| 韧性 | ✅ 平台重启不影响 IDD 分析 | ✅ 热配置免重启 |

**总判定:两插件集成真实可用,简单案例全链闭环。**
