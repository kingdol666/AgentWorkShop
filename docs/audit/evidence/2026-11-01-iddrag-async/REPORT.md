# IDD/RAG 独立+集成+异步非阻塞验收报告(iddrag-async)

**时间**:2026-11-01 03:57~05:5x · 平台 v0.8.8@3300 + IDD(3210/5180)+ RAG(8771/6789)
**用户问题**:独立测试→对外 API→集成真实场景;**异步后台执行+进度可见+不阻塞 Channel Agent+结果正确存储随时可查**

---

## 0. 结论

**异步业务机制全链 PROVEN:分发 <2s 即回(四次实测 1927/877/757/720ms)、进度随时可查(diag_status running→终态)、Channel Agent 作业全程不被阻塞(并发工具调用 379ms;频道任务在诊断运行期 COMPLETED)、结果正确存储且随时可查(diag_results 台账 109 条,报告全文在档)。** 失败路径同样按设计工作:五种运行形态(成功/缺工件失败/空数据诚实终止/超时记录/静默僵死后 40min 帽收敛)全部落正确终态、不假成功。**未竟:IDD/RAG 长任务在本机混合负载下执行成功率低(根因=资源挤压,同 E-1),需独占资源复验;受控试点判定不变。**

## 1. 独立测试(Phase A)✅

| 项 | 结果 |
| --- | --- |
| 四服务启动 | IDD 3210/5180 + RAG 8771/6789 全 200(IDD `npm start --detach`;RAG `start.sh dev`) |
| IDD 健康 | status ok + database ok + activeRuns 面板 |
| IDD 铸币链 | register→login(session_token)→tokens(idd_ 前缀)全通 |
| IDD 外部 API | `/api/external/v1/results` 列表(98 条历史)+ categories;**发现:跨用户 PATCH 命中存量 NULL 属主行**(10-25 已知残留,修复仅覆盖新行,产品决策项维持) |
| RAG 铸币链 | register(注册即返 token)→tokens(sk- 前缀,scopes read/write) |
| RAG 独立 | web `/api/kb/create` 建库 ✓;backend `/api/v1/search/two-stage` **真实检索命中**历史 DOE 报告(score 10.95) |

## 2. 集成+异步非阻塞(Phase B,核心)✅

### 2.1 桥接面
- diag-bridge health:`remote.status=ok, auth=ok`(IDD token accepted)
- rag-bridge:频道未启用时 agent 调用被**结构化拒绝**("该团队未启用插件「rag-bridge」…可在团队设置→插件中开启")——治理面正确;PUT plugins 启用后即用

### 2.2 异步执行+进度+不阻塞(用户核心问题逐条)

| 验证点 | 证据 |
| --- | --- |
| **工具异步执行** | `diag_run mode=async` 分发即回:**1927ms/877ms/757ms/720ms**(四跑),回执含 task_id+“IDD 在后台执行,Channel 无需等待——完成后自动回执信箱并唤醒;空闲可 diag_status 主动查询” |
| **后台执行+进度可见** | `diag_status(run_id)` 随时可查:状态=running(含窗口/数据集/问题)→ completed/failed;运行中亦可由 Channel Agent 亲自查询(并发任务实测) |
| **不阻塞 Channel Agent** | ①工具级:诊断运行中并发 `daq_query` **379ms** 带真数据;②频道级:任务 **753c6fc5 在诊断运行期间派发→执行→COMPLETED**(读数+查诊断状态+收口) |
| **结果正确存储** | `diag_results` 台账 **total=109**,本轮 run 035d5a1b 报告全文在档顶部;append-only 随时可查 |
| **失败不假成功** | stability-report ×2:omp 会话 5.5/7min 被处置→缺 line_report 工件→**failed 如实落账**(fail-closed 注释在源码 diagnosis.service.mjs:1382);EMPTY_EXPORT(批次已关无打标数据)诚实终止;kb turn 540s 超时如实记录 |

### 2.3 真实场景全链(新批 rr-4a617dab)

重开批次→设备复活→连续采集→`daq_export`(daqexp-…-c9e6c7,6 文件)→async deep-diagnosis(757ms 分发)→运行 20min(转录 105 事件)→omp 回合静默僵死(历史 R10e 模式)→40min 帽后 fail-closed→**终态 failed 如实可查**。期间 3300 第三次被内存挤压下线(E-1 同根:平台+IDD(omp)+RAG(embedding)+浏览器+并行会话)。

## 3. 发现(如实)

| # | 内容 | 定级 |
| --- | --- | --- |
| D-1 | **IDD 长任务执行稳定性受资源挤压**:2×stability-report 中途 dispose(5.5/7min)+1×deep-diagnosis 静默僵死(20min)+1×completed-但-EMPTY_EXPORT;omp/RAG 长任务与本机其他负载互斥 | P1(资源规划,E-1 同根) |
| D-2 | kb_agent:异步契约(171ms 回执+状态查询+失败留痕)全对,但 RAG turn 540s 预算内未出终帧(历史已知模式;RAG 侧可能仍在跑,回执机制存在) | P2(RAG 侧调参/观察) |
| D-3 | IDD 结果库存量 NULL 属主行仍可被任意用户 PATCH(10-25 已知残留) | P3(产品决策项) |
| D-4 | 3300 本轮三次死亡(E-1 同根);revival 按 runbook 执行;**异步业务不受平台重启影响的证据链完整**(IDD 侧任务继续运行,平台回来后状态照常可查) | 已有 E-1 记录 |
| D-5 | 设备重启致 device-side SP 状态回默认(2.6/210),平台账本保持真实历史——设备无状态是设计语义,留意割接时的 setpoint 下发 | 运维注记 |

## 4. 判定

- **桥接+异步+存储+可观测:PROVEN**——用户四问(后台执行/进度可见/不阻塞/结果可查)全部实测通过,含失败路径的诚实性。
- **IDD/RAG 长任务成功率:本机混合负载下不合格**(D-1)——与 E-1 同根因;**生产部署要求 IDD/RAG 与平台同机时预留独占内存预算(建议 ≥32GB 机器上平台 6GB+IDD 4GB+RAG 6GB+系统,且验收/IDE 会话不同机)**,否则错峰。
- 受控试点判定不变(GO);无人值守 NO-GO 理由新增 D-1。

*证据:docs/audit/evidence/2026-11-01-iddrag-async/(b2-*/b3-*.json 全序列)+ /d/tmp/aw-iddrag-*.log + IDD .runtime/backend.log + omp 会话转录(.omp-sessions/)。*
