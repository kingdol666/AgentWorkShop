# 执行计划:PIPELINE 全流程真实实验(2026-10-30 起草,2026-10-31 Architect 修订后共识执行,zcode 会话)

> 状态:pending approval → 用户当轮已明确"真实执行一遍实验",批准执行。
> 共识记录:Architect 初审 NEEDS-REVISION(6 项定点修订已并入本稿);Critic 终审结论见文末。
> 依据:bench/PIPELINE.md 执行卡(883 行执行合同)+ bench/PIPELINE/EXPERIMENT-PLAN.md(P12 手册)。

## RALPLAN-DR 摘要

**Principles(原则)**
1. 结论只来自真实启动的服务与真实执行的命令;判据不满足即停,如实报告(PIPELINE 核心原则 1)。
2. 隔离第一:专用端口 3005/专用模拟器 4011/专用 AW_HOME,常驻实例零接触。
3. 消融以机制归因为准:四臂差异必须与理论一致,否则作废重跑(AW_BENCH_MODE=1+AW_BENCH_ACK=1 双保险丝必须在平台启动前存在)。
4. warn 不是 fail:仅 P10 双拉 warn 允许按协议重跑一次,如实披露。
5. 证据链完整:逐层 runId + seed/git/harness 三指纹 + 跨层总报告(build-final-report)。

**Decision Drivers(决策驱动,Top 3)**
1. 用户要求:真实执行 + 消融实验 + 结果汇整 + 真实 harness 实机演示 → 全执行卡①-⑥ + 第4步复现 + P12 episode + build-final-report。
2. 预算约束:extended(P13/P14)单轮 40-50min×2 且 P13 含 20-25min AML 训练,超出本轮预算 → 不跑,P14 能力面已在本日 T4 验收覆盖(126 工具全 available)。
3. A1/A2 论文消融执行器**尚未实现**(PIPELINE.md 明示) → 本轮消融=已实现的 E1a 四臂;A1/A2 如实标注为规划内未执行,不伪造。

**Viable Options**
- **A(选定)**: 全执行卡 integrated 档(①静态→②流水线 77/0/0→③plc 13/13→④E1a 四臂消融→⑤api-live 60→⑥三场景达标)+ 第4步复现(二次流水线+compare-pipeline+冻结基线比对+selftest)+ P12 真 harness episode(omp lead+2worker,LM Studio qwen3.5-9b-64k)+ 第5步跨层总报告。
  - pros: 完整覆盖用户四项要求;每步有硬判据;证据包审稿人级。
  - cons: 总时长 1.5-3h;P12 episode 有 NOT-QUALIFIED/主终点失败风险(如实报告)。
- B: extended 全量(111/0/0×2 + P13 AML 训练)。pros: 覆盖 P13/P14。cons: +80-100min,P13 训练非确定性放大时长风险;排除理由=单会话预算,P14 已有 T4 覆盖。
- C: 仅单次流水线。pros: 最快。cons: 无复现无消融,不满足用户要求。排除。

## 执行序列(按执行卡编号)

| 步 | 命令 | 判据 |
| --- | --- | --- |
| 0 前置 | .output 在/子模块在/LM Studio 已加载 qwen3.5-9b-64k 且**实测上下文窗 ≥32k**(手册记载 n_ctx=32,768 下 n_keep 33k-96k 溢出史,修复未经真机确认——不足以承载 P12 时,P12 如实 NOT-QUALIFIED,不影响①-⑥)/`node bench/compare.mjs --selftest` | selftest 退 0「门槛正确拒绝篡改」 |
| 1 端口 | 探测 3005/4011 身份(人工判 body 形状) | 空闲或基准形;冒名即换位 |
| 2 隔离块 | 每个 shell 重设:`export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost`(本机 7890 代理拦 localhost)+ `export AW_BASE=http://127.0.0.1:3005 SIM_BASE=http://127.0.0.1:4011 AW_HOME=$PWD/../aw-bench-home AW_MODE=home AW_BENCH_MODE=1 AW_BENCH_ACK=1 NUXT_SESSION_PASSWORD=aw-bench-isolated-2026`(URL 形态,全部工具按 URL 读) | — |
| 3-① | `node bench/run.mjs --tier static --seed 42` | 退 0,s2=100% |
| 3-② | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` | 退 0 且「PASS(pass 77 · warn 0 · fail 0)」;仅 P10 双拉 warn → 按协议重跑一次 |
| 3-③ | `node bench/run.mjs --tier plc --seed 42` | 退 0,13/13,intercept_rate=1,false_block_rate=0 |
| 3-④ | `node bench/e1-lite.mjs --seed 42 --repeats 3` | full/no-readback 6/6;no-interlock/ungated 4/6 且 windowBreach>0;falseBlock 恒 0;否则作废重启平台 |
| 3-⑤ | `node scripts/api-live-e2e.mjs 2>&1 \| tee bench/results/apilive-zcode-20261030.log` | 退 0,「ALL PASS (60 passed)」;日志供第 5 步 --api-live-log |
| 3-⑥ | `node bench/scenarios.mjs --seed 42` | 三场景全部「达标 ✔」 |
| 4-复现 | 第二次 pipeline 同命令 → `node bench/tools/compare-pipeline.mjs --a <干净跑runId> --b <复现跑runId>`;`compare.mjs --baseline 20260914-baseline/run-plc-fx0 --b <plc>`;`--baseline …/run-e1lite-4arm --b <e1a>`。**--a 必须取干净跑**:若 3-② 曾 warn 后重跑,取重跑的干净 runId,warn-run 只作披露。**复现跑自身出 warn**:按同一协议重跑一次,再 warn 即停(总盲跑上限 2 次内) | compare-pipeline 退 0(REPRODUCIBLE,判定类 0 失败,77/0/0×2,闭环 ratio∈[0.966,0.973]);compare 两退 0;selftest 退 0 |
| P12 交接 | **两栈显式交接**(D1/D3):① 停 bench 栈——杀 4011 模拟器进程树(taskkill //T)+ `node scripts/_audit/detached-start.mjs --port 3005 --log ../aw-bench-home.log --stop`(**必须传同一个 --log**),curl 确认 $AW_BASE 不可达;② **新 shell** 重设环境并自证:`unset AW_BENCH_MODE AW_BENCH_ACK`(echo 确认为空)+仅保留 P12 所需变量;③ 按 EXPERIMENT-PLAN §4 建本轮目录+审计 sink | 4011/3005 端口空闲自证;`echo $AW_BENCH_MODE` 为空;审计目录含 capture_ready 前置要求已传递给平台启动步骤 |
| P12 | `run-agentteam.mjs prepare` → `start-simulator --run-id` → `preflight` → `execute` → **操作员停止本轮隔离 AW 实例**(手册阶段 B 第 8 步硬前置,finalize 会先确认端口无 listener)→ `finalize --run-id`;env: 新 shell 仅设 P12_PROVIDER=lm-studio P12_MODEL=qwen3.5-9b-64k P12_AUTH_REF=none:local-lm-studio AW_AGENTTEAM_EVENT_LOG/RUN_ID 平台启动前注入;**P12 专用模拟器服务不由 runner 关闭,保留现场**(手册语义);episode 预算 90min,超时未收口如实按当时状态判定 | preflight 全过(否则 NOT-QUALIFIED 如实报告);**判定三字段分别落报告**(EXPERIMENT-PLAN §5):① qualification(资格门通过/NOT-QUALIFIED)② workflow_outcome(主终点=完整受治理链成功,执行完成但目标未达如实区分)③ evidence_integrity(审计对账完整,缺事件即不合格);NOT-QUALIFIED/失败亦进总报告「诚实限制」节 |
| 5 报告 | `node bench/tools/build-final-report.mjs --static … --pipeline … --plc … --e1lite … --api-live-log … --out bench/reports-archive/<日期>-zcode-final` | report.md+html 落盘;质量清单逐项自查 |
| 6 收尾 | `node scripts/_audit/detached-start.mjs --port 3005 --log ../aw-bench-home.log --stop` 停 3005 → curl 确认不可达;bench/results 与 baselines 永不删除 | — |

## 消融实验设计(用户要求项)

- **已实现消融(本轮执行)**:E1a 四臂 ×3 repeats——`full`(全治理)/`no-readback`(无回读证实)/`no-interlock`(无 60s 写联锁,需双 env 保险丝)/`ungated`(无授权门)。归因判据见 3-④;产物 e1-lite.csv+figure-*.svg 进总报告「治理归因」章。
- **规划内未执行(如实标注)**:A1(审批门 ON/OFF 单机制消融)与 A2(Harness×模型对照)执行器尚未实现(PIPELINE.md 明示),AW_BENCH_MODE 不能作审批单点消融——本轮不伪造,留待执行器落地。

## 风险与处置

| 风险 | 处置 |
| --- | --- |
| 流水线 warn-run(P10 双拉残余非确定性) | 同命令重跑一次;干净跑 vs 干净跑比较;**重跑仍 warn → 停止,不得第三次盲跑**;warn-run 披露进报告限制节 |
| P12 NOT-QUALIFIED / 主终点失败 | 如实报告 episode 判定与证据包,不降低资格门 |
| 端口被占/冒名 | 人工判 body 形状,按 3010→3050→3060 顺延 |
| 时长超预算 | extended 已裁;P12 episode 预算 90min 上限 |
| 并行会话抢 4011/3005 | 清场脚本 kill-acceptance-strays + 换位 |

## 共识记录(ralplan,2026-10-31)

- **Architect**: 初审 NEEDS-REVISION → 6 项定点修订(隔离块 URL 形态+NO_PROXY / --stop 带 --log+curl 确认 / finalize 前操作员停 AW / compare-pipeline --a 取干净跑+复现跑 warn 处置 / LM Studio n_ctx 实测前置 / AUTH_REF=none:local-lm-studio 对齐手册)全部并入本稿;修订后判 SOUND。
- **Critic**: **APPROVE**(六项强制检查全 PASS;两条非阻断备忘:①会话中断续跑时先重做第 1 步身份探测;②"总盲跑上限 2 次"取保守解释)。
- 用户当轮已明确授权真实执行 → 本计划进入执行态。
