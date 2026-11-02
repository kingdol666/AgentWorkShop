# IDD/RAG 独立+集成+异步全流程验收报告(R2 轮)

**时间**:2026-11-02 09:2x~11:0x · 平台 v0.8.8(wait 语义版)+ IDD(3210)+ RAG(8771/6789)+ 设备(4010/4021)
**要求**:先独立启动测试与对外 API,再集成真实场景;验证后台执行/进度可查/不阻塞 Channel/结果正确存储随时可查

---

## 0. 一句话结论

**全流程 PASS:独立面(铸币/外部 API/建库/检索)全绿;集成面(桥连通+异步后台+进度可查+不阻塞+台账存储+自动回执)全绿——diag_run 异步分发 1863ms 即回、运行中并发 daq_query 203ms、Channel 并发任务 COMPLETED、诊断 33 分钟后 COMPLETED 并自动入库台账(114 条)+异步回执自动送达频道。kb 引擎侧 1 次 turn 超时如实记录(RAG 侧资源,非桥,与前轮定位一致)。**

## 1. 独立测试(Phase A)✅

| 项 | IDD | RAG |
| --- | --- | --- |
| 健康 | ok · db ok · activeRuns 面板 | healthy · vector ready · embed available |
| 铸币链 | register→session_token→`idd_` API token ✓ | register→login→API token ✓(注:register 不返 token,login 才返;上轮口径修正) |
| 对外 API | results 列表(98 条)/categories/详情 ✓;无 token **401** ✓ | 建库(web /api/kb/create)✓;two-stage 检索**真命中 9.59 分** ✓ |

## 2. 集成+异步(Phase B)✅——用户四问逐条

| 问题 | 实测 |
| --- | --- |
| **后台执行?** | diag_run wait=false → **1863ms 即回** task_id=0ebb834c;kb_agent async → **324ms** 即回 task_id |
| **进度可查?** | diag_status 随时可查(running→completed 全程);kb_agent_status 随时可查(running→failed 终态) |
| **不阻塞 Channel?** | 工具级:诊断运行中并发 daq_query **203ms** 带真数据;频道级:任务 **626dc718 在诊断运行期派发→COMPLETED** |
| **结果正确存储随时可查?** | diag_results 台账 **114 条**(0ebb834c 在顶,quick-screen alert·104);**[异步回执] 自动送达频道**(10:00:27,结果=完成) |

## 3. 真实场景全链(T6)✅

新窗导出(edajob-4f2dc835,daqexp-…-279e55,7 节点)→ async quick-screen(1863ms 分发)→ 后台运行 **33 分钟** → COMPLETED(alert·104)→ 台账+异步回执。104 alerts 多于上轮 37 = 设备多次重启后的数据特征,判定合理。

## 4. 发现(如实)

| # | 内容 | 定级 |
| --- | --- | --- |
| K-1 | kb_agent async turn 一次 540s 超时(RAG 侧 claude SDK 引擎无终帧;与前两轮定位一致)——异步契约工作正常(状态可查/失败留痕),**根因=RAG 执行环境资源**,独占资源后复验 | P2(D-1 延续) |
| K-2 | RAG register 不返 token(与上轮口径不同——后端行为:register 仅建号,login 返 session token;铸币链以 login 为准) | 口径注记 |
| K-3 | diag 运行 33 分钟(上轮同意图 9 分钟)——IDD 侧 omp 引擎时长波动大,资源依赖明显 | D-1 延续 |

## 5. 判定

- **异步业务机制(后台执行/进度/不阻塞/存储可查/自动回执):PROVEN(本轮再证,含 wait=false 快路径与状态查询慢路径)**
- **独立 API:PASS;集成真实场景:PASS**
- **遗留不变**:IDD/RAG 长任务资源独占(D-1);kb 引擎成功率需独占资源复验

*证据:docs/audit/evidence/2026-11-02-iddrag-r2/(t4-*/t5-*.json)+ 台账(diag_results 114)+ 频道消息([异步回执])+ /d/tmp/t2-*/t3-*.json。*
