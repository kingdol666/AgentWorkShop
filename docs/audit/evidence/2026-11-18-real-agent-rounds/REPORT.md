# 真实 Harness/模型执行轮 汇整报告(2026-11-18 凌晨)

> 轮次目标(用户指令):检查上一轮(2026-11-17 夜)完成度;再做**产线 + 非产线**两轮真实测试;
> **必须真实 harness + 真实模型 + 真实任务**(不得带测试)。本报告为 ralph 轮收口。

## 1. 上一轮完成度核查(诚实口径)

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 完整功能实机演示(接入→Channel→闭环) | ✅ 完成 | 接入 9/9 + verify 10/10 + 闭环治理全链 + 9 截图 + 视频 + 落地页 |
| 产线管理 | ✅ 完成 | 线/节点/配方/批次/开跑/数字孪生页实时同帧 |
| 产线实际优化 | ⚠️ 治理面真实,驱动面 fallback | 闭环 SP 156→138 + 复测 3/3 真实完成,但探索步由 owner 经 invoke 桥驱动(omp 回合停滞) |
| 普通 Channel 任务作业 | ⚠️ 派发完成,回合未跑通 | 种子任务派发真实,但 omp 回合 2×900s 停滞,未由真实模型完成 |
| Project 模式 | ❌ 未做 | 本轮补齐 |
| 监控执行输出 | ✅ 部分 | events/journal/任务史全程监控 |

## 2. 本轮根因修复(为什么真实回合此前停滞)

**根因链(全部实机取证)**:

1. **omp 默认模型空输出**:平台模板不配 provider/model → 依赖「omp 默认」;本机 omp 默认模型
   `omp run` 无 `--model` 时输出为空("Working..." 后无响应)→ 回合 900s 硬超时。
   修复:全部频道成员显式绑定 `provider=ustc, model=deepseek-flash`(PATCH channel agents config)。
2. **rpc-ui 无头停滞**:lead 默认 `--mode rpc-ui`,无头 stdio 下进程活但零 CPU。
   修复:lead 显式 `rpcMode='rpc'` + 完整重启实例(运行时不热读配置,重建沿用内存旧配置——记为改进项)。
3. **supervisor 健康探针误杀**:审批在飞/机器高负载时段 API 请求 6.5s 级排队 → aw-start 健康探针
   3 次失联 → 判僵死重启(防线正确但放大为回合反复中断)。
4. **kb_agent SSRF 拦截(历史悬案破案)**:rag-bridge 调本机 RAG 服务(127.0.0.1)被 SSRF 防护拒绝
   → 设 `AW_ALLOW_PRIVATE_OUTBOUND=1` 后打通(此前历轮「kb 写路径不可靠」的真正根因)。
   修复后下一层暴露:rag-knowledge token 401 过期(需在设置页轮换,属 rag 后端凭据依赖,如实记录)。

## 3. 本轮真实执行证据(全部真实 harness + 真实模型 + 真实任务)

### 3.1 产线回合(omp + ustc/deepseek-flash)✅ 真实打通

- **lead(AML 首席数据科学家)真实回合**:任务 cd74519e,182 条工具史;
  真实调用 `daq_query` 拿到 dn-03084b36 真实时序(00:35~01:35 窗),
  真实拆解并派发子任务 47206653 给数据工程师(带结构化 Objective)。
- **执行器(优化执行器,omp)真实回合**:任务 f1262c1a,WORKING 134+ 条史:
  my_industrial_nodes 授权确认 → daq_query 基线 → 撞上 `PROJECT_WRITE_INTENT_REQUIRED`
  治理门(**正确 fail-closed**:项目成员高频写必须走项目来源任务 + owner write_intent)→
  转入真实数据取证(Recipe 变更史/eval 分析 DAQ CSV/进度上报 20%)。
- **治理归因**:journal `dcw.write.agent` ×4、`dcw.write.manual`、`dcw.write.rejected` 三类事件同屏
  (06-journal.png)。

### 3.2 非产线回合 ✅ 真实打通

- **复盘与知识沉淀频道(无产线绑定,ctpl-generic-optimize-default 实例化)**:
  任务 497c68e9/f89815bb,lead 真实回合 76 条史:`todo` 五步真实规划 →
  `kb_agent(sync)` 检索(触发并破案 SSRF 拦截)→ 失败如实回传。
- 复盘作业的知识入库最终被 rag token 401 阻断(见 §2.4);真实回合行为本身全程留痕。

### 3.3 Project 模式 ✅ 真实打通(端到端)

- **真实 leader**:`leaderHarness='omp' + leaderConfig{provider:ustc, model:deepseek-flash}`(非 mock)。
- **真实计划回合**:decision seq2 `plan.proposed`(02:09)——leader 产出**结构化计划**,
  交付物验收判据含 `text.contains:156/138/数据链/治理事件/时间线`、`min_bytes:6000`
  (可机检查证,非空话)。
- **owner 批准** → `work.instance_created` + `work.dispatch_auto`(Router v3 technical)
  → 工作项真实派发到复盘频道(a3b7e79c,真实回合 49 条史,真实调用 `mcp__kb_mcp_experience_list`
  做去重检索)。
- 项目页 UI 实拍:10-projects.png(1 项目/进行中/2 频道/4 工作项/plan v1)。

### 3.4 dsh 路径(第二真实 harness)✅ 回合真实,工具面缺口如实

- 任务 8a3b3cd3:**COMPLETED,147 条真实工具史**(pwsh/read/write/edit 全真实);
  `dsh-permission` HITL 卡真实审批回环(approved, native=true)。
- 缺口:dsh 0.2.2-rc.1 的 `session/new` 不接受 mcpServers 参数,平台工具需 profile 级
  mcp-client 配置(本机未配)→ dsh 回合只能用自带 shell 工具,工业工具面未接通
  (dsh-agent.ts:463 注释已注明此契约)。记为部署配置项,非平台缺陷。

## 4. 发现与修复(本轮代码/配置变更)

| # | 发现 | 处置 |
| --- | --- | --- |
| F1 | optimization_explore u0 退化角(value=null 被 0 强转) | **PR #232 已合 main(4ebb279e)**:先读后探三级回退 + 3 单测 |
| F2 | 孪生 follows[].sp codegen 用 id 而 vars 按名索引 → 因果静默死亡 | **PR #232 已合**:id→name 双解析 + 未解析键 FAIL 上报 |
| F3 | omp 默认模型空输出 | 配置修复(显式绑定真实模型);改进候选:模板种子携带 provider/model |
| F4 | rpc-ui 无头停滞 + 运行时不热读 agent 配置 | 配置修复(显式 rpc + 全量重启);改进候选:配置 PATCH 触发 harness 重建 |
| F5 | supervise 任务史归因 bug(「仅 assignee 可上报」) | 如实记录(lead 派工后 supervision 把工具史写到子任务上)——P2 平台缺陷待修 |
| F6 | kb_agent SSRF 拦截环回 | env 修复(AW_ALLOW_PRIVATE_OUTBOUND=1)——同时破案历轮 kb 不可靠悬案 |
| F7 | rag-knowledge token 401 | 如实记录(需在设置页轮换 rag 凭据;本机 rag 后端依赖) |
| F8 | PROJECT 写意图门 | **正确行为**(非缺陷):项目成员高频写强制项目来源 + owner write_intent |

## 5. 结论

- **真实 harness + 真实模型 + 真实任务:已打通并多路取证**(omp lead/omp 执行器/dsh/Project leader
  四条真实回合线,均为 ustc/deepseek-flash 或 DeepSeek 官方 API 的真实推理,零 mock leader)。
- **产线闭环治理面全链真实**:HITL 审批、写意图门、步限/量程/频控、journal 归因全部在真实回合下
  正确工作(包括对真实回合的拒绝——fail-closed 不是摆设)。
- **边界(如实)**:①agent 端到端发出 optimization_explore→HITL→写 的完整闭环在本轮窗口内
  未走完(上游 deepseek-flash 对真实负载时通时断 + 执行器转向深度取证,预算到时);
  ②知识入库被 rag token 401 阻断(基础设施凭据依赖);③ustc 上游不稳定性是外部依赖,
  平台侧防线(hard-timeout/rescue/审批 fail-closed/任务取消)全部验证有效。
- 治理零违规:全轮 0 越权写、0 越界写、0 未审批下发。

## 6. 证据清单

- 截图:01-dashboard / 03-channel / 05-line-final / 06-journal / 10-projects / 11-project-detail(本目录)
- 运行实例:AHOME=D:/tmp/aw-demo-1117/home(:3010,演示后保留供核查)
- 任务 id:cd74519e(lead 真实回合)/ 8a3b3cd3(dsh)/ f1262c1a(omp 执行器)/
  497c68e9·f89815bb(非产线)/ a3b7e79c(项目工作项)
- Project:a7e01018-d074-4c33-8a9f-09f97c7cbec3(decisions seq1-5 全链)
- HITL:dsh-be365c81(dsh-permission 真实审批回环)
- 上轮(2026-11-17 夜)闭环:SP 156→138、复测 3/3、PR #232

## 7. 续轮收口(2026-11-18 03:00 前后追加)

- **仓库完整性验收**:main 与 origin 同步;全量 unit **2019 pass / 0 fail / 1 skip**;
  目标文件 eslint 0;PR #232 已合(quick-gate SUCCESS)。
- **kb 链路终态**:SSRF 已破(env 修复生效,调用可达 rag 后端 :8770);后端开启鉴权而
  本 fresh home 无 rag 凭据(token 属用户基础设施依赖,不回显不复用)→ 知识入库如实
  记为「凭据依赖待用户配置」。
- **聚焦探索补测(ddec0aae)**:模型端点探针可通(短 prompt),但执行器真实回合持续
  静默 → 按预算收口取消。结论不变:完整 agent 驱动 explore→HITL→写 链受上游
  deepseek-flash 负载稳定性制约;平台侧(harness/RPC/工具面/治理门/任务生命周期)
  已分别独立取证有效。
- **落地页完善**:新增「真实执行轮」章节(四条真实回合线+根因破案+PR 链接)、轮播扩至
  7 帧(含项目中心/项目详情实拍)、工程发现卡片更新;修复两处真问题:
  ①曲线卡标注被数据线穿过(visual-judge fail → 重排);②滚动显现动画在内嵌渲染
  环境不推进 transition 帧导致内容不可见 → 移除入场隐藏,内容恒显。
- **ultragoal 台账**:7/8 封口(G001–G007 complete);G008 工作完成但最终 checkpoint
  需原生 /goal hook 状态(本 harness 无该机制),如实记录。
