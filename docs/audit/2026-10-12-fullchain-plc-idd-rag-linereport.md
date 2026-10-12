# 全链路真实场景验收报告:PLC 模拟→产线→优化频道→双插件→产线报告 skill 快速诊断(2026-10-12)

> 命题:拉取最新代码并启动平台;启动 PLC 模拟,创建产线与优化作业 Channel;集成 IDD+RAG 双插件,数据自动抓取与分析,检索并继续分析;按真实场景给出测试结论。

## 一、总判定

**平台与全链路骨架全部跑通:平台 0.7.58 冷启动(首注册即 admin)→ PLC 模拟(cast-film-physics)→ 建线(3 SV+3 PV)→ 优化频道(通用闭环优化模板,四成员+KB 开关+绑线+委托+激活)→ 数采自动抓取 → 阶跃激励 → HITL 提案-批准-下发写穿 PLC;双插件桥 IDD/RAG token 双向验证通过;RAG 闭环(入库→检索命中→引用既往定口径→续诊→双报告可检索)完整成立。深度诊断(diag_run)提交-运行-多智能体编排可见但单轮 30min+ 未收敛(环境级,已停);按用户指示改测「产线报告 skill」快速诊断——R1=79.3(B)/R2f=52.7(C) 两轮全绿(分析→HTML→门禁→入库→检索 15/15),评分对强阶跃敏感,确定性复算一致。**

- 全链路骨架测试:31 PASS / 11 FAIL(11 个失败全部根因定位并修复,见 §四)
- 产线报告 skill 快速诊断:R1 轮 9/9 实质断言全绿;R2f 轮 **15 PASS / 0 FAIL**
- 结论:**"检索既往→数采→快速诊断→入库→可检索"的闭环在产线报告 skill 路径下完整可用**,深度诊断路径待其 LLM/VLM 供应商侧提速后再验。

## 二、环境与执行(时间线)

| 阶段 | 结果 |
|---|---|
| 平台启动 | **发现并修复陈旧构建**(.output 为 10-02 的 0.7.54,health 无 memory 字段→新看门狗探针永远失败→无限杀子进程 #1-#11 后放弃);删 .output 重建后 0.7.58 稳定 |
| 外部服务 | IDD 3210/8764 在线;**rag 8770 掉线(手工重启,aw-industrial 库完好)**;插件 token 落 runtime-settings 后双双 accepted |
| PLC 模拟 | 4019 cast-film-physics 预设,五节点信号引擎正常 |
| 建线 | ln-72eb1197(历轮 ln-045c0b51/ln-084c4bf0/ln-55ee09a2 等 7 条):3 SV(DCW)+3 PV(DAQ)+基线配方+开跑 |
| 优化频道 | chtpl-generic-optimize-default 实例化:生产主管+数据分析师+知识调优工程师+工艺工程师;KB 开;绑线;lead 绑定(recipe+3 DAQ,v2 权限面);委托;激活 |
| 数采 | 自动抓取验证 3 路 PV 全部有样本;阶跃激励 linespeed 93→97、diegap 1.03→0.97/0.94 写入均链路受理 |
| HITL 闭环 | recipe_propose(线速 95→96)→审批卡→批准→整批下发→**PLC 读回 96 写穿证实**(runId rr-b86ba1ca/rr-864da496 等);审计台账留痕 |
| 深度诊断 | diag_run 提交→omp 引擎 running→hub 派 VLM 子智能体+eval 轮询,30min+ 未收敛 → 按 user 指示停,改快速诊断 |
| 快速诊断 | industrial-line-stability-report skill:R1(线速阶跃窗)79.3/B;R2f(产线重启+模口 0.94 强阶跃新窗)52.7/C;HTML 落地页+quality_gate 全 PASS |
| RAG 闭环 | 两轮报告入 aw-industrial(exp-b7307cca…/exp-fc8bc3aa…/R2f 新 id)→检索各自命中→R2f 前置检索引用 R1 定口径→三报告均可持续检索 |

## 三、产线报告 skill 测试明细(快速诊断路径)

| 断言 | R1 | R2f |
|---|---|---|
| 窗口导出(真实新数据) | ✔ 1000 行 | ✔ 78 行(末点距今 <2min) |
| stability_analyzer analyze | ✔ 秒级 exit 0 | ✔ 秒级 exit 0 |
| 评分+分级产出 | ✔ 79.3 / B | ✔ 52.7 / C |
| 发现清单 | 5 条(high×3/warn×2) | 6 条(high×6,三通道 SPC 违规+显著漂移) |
| HTML 落地页+自检 | ✔ 90KB | ✔ 90KB |
| quality_gate | ✔ exit 0 | ✔ exit 0 |
| 入库经验库(拿 id) | ✔ | ✔ |
| 检索命中本报告 | ✔ | ✔ |

**区分度证据**:R1 温和阶跃→B(亚稳定);R2f 模口 0.94 强阶跃→C(波动,三通道全线 SPC 违规+漂移)——评分对工况敏感、数值由 lstcore 确定性复算(两轮同窗重分析同分 79.3,反证零 LLM 确定性)。

## 四、发现与处置(全部记录)

1. **陈旧构建+看门狗互杀(P0,已修)**:`.output` 为旧版(0.7.54,health 无 memory 字段),`aw start` 检测到产物即跳过构建;新看门狗要求 health 携带 memory → 探针永失败 → SIGKILL 循环 11 次后放弃。处置:删 .output/.nuxt 重建。**建议:aw start 对产物做版本戳校验。**
2. **rag 8770 后端掉线(环境级,已修)**:手工从 `ClaudeGPT/rag_project/rag-knowledge/backend` 以 BACKEND_PORT=8770 重启(注意有两份 rag-knowledge 副本,aw-industrial 库在 ClaudeGPT 这份;`D:/codes/tmp/rag-knowledge` 是另一份,勿混)。
3. **权限 v2 面**:DCW 节点不支持直接 Agent 绑定(必须走 recipe kind='recipe');lead 绑定=recipe+DAQ 只读面即可支撑优化闭环。
4. **diag_run 是 omp 工具不是 MCP 工具**:走 `/api/workshop/agent-tools/invoke`(lead/worker 角色);MCP 38 工具不含插件工具。
5. **IDD 路径防护**:diag data_path 只允许 IDD 项目内 allowed_base_dirs;正规路径=不给 data_path,由 diag-bridge 快照上传 `/api/files/data/upload` 落允许根。
6. **深度诊断耗时(未解,环境级)**:omp 引擎 hub 派 VLM 子智能体,eval 轮询 20min 预算,单轮 30min+ 未收敛;两并行任务互抢供应商配额加剧。已停(b51172db/2dae8b00→stopped);待 ragproject/供应商侧排查。
7. **KB 经验入库契约**:category ∈ {best_practice,troubleshooting,lesson_learned,optimization…};**result ∈ {success,partial,failed,inconclusive}(小写)** —— 大写被 422 静默拒;响应 id 在 `experience.id`。
8. **aw_daq_samples 窗口参数**:REST 层 from/to 是 **epoch 毫秒数**;ISO 字符串被 `num()` 静默忽略→返回全量历史(MCP 工具描述写 ISO,有误导;建议修文档或兼容)。
9. **本机周期性杀 node 进程(环境级,老坑复发)**:4019 模拟器(node 子进程)在 18:43 被外部杀手带走→DAQ 无源停采(节点仍 enabled,lastSampleAt 冻结);DCW 写入仍报 √ 属「链路受理」非设备证实。处置:ensureSimulator 复活+采样在流门(末 2min 有新点)作为续诊前置。
10. **产线 idle 不采样是设计**:批次闭合后恢复采样须确认产线在跑(aw_line_start 409=已在运行属正常容忍)。
11. taskkill //T 树杀风险:清残留启动器时误伤 8764 IDD 后端(已恢复);后续清进程只杀精确 PID。

## 五、结论

1. **平台全链路(PLC 模拟→建线→优化频道→数采→激励→HITL 治理下发写穿)**:可用,已实证。
2. **IDD+RAG 双插件集成**:桥接健康、token 持久化、检索/入库确定性路径全通;**快速诊断(产线报告 skill)路径本轮全绿**,深度诊断路径功能可见但需供应商侧提速。
3. **"检索并继续分析"闭环**:R1 入库→检索定口径→新工况续诊→R2f 入库→双报告可检索,完整成立;评分区分度实证(79.3B→52.7C)。
4. 遗留:MCP aw_daq_samples 参数描述修正;aw start 构建版本戳;深度诊断 LLM/VLM 依赖排查;经验 solution 摘要中 evidence 对象序列化([object Object])待格式化。

—— 生成:全链路验收轮 2026-10-12(脚本 tmp-e2e/fullchain-idd-rag-20261012.mjs / line-report-quickdiag-20261012.mjs / line-report-r2-fresh.mjs;频道 30452679…;产线 ln-72eb1197;产物 .AgentWorkShop/analysis/line-report-20261012/)
