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

## 六、发布轮(npm 打包→远端→全局拉起→同套验收)

**发布:agentworkshop@0.7.58 → 0.7.59(dist-tags.latest),registry.npmjs.org(kingdol)。**

1. 0.7.58 发布后全局拉起验收中,**发现两颗 MCP 产品雷**(0.7.58 及之前所有版本均带):
   - **`aw mcp` CLI stdio 秒退自杀**:`run()` 里 `runStdio(); return 0` → main 立即 `process.exit(0)`,stdio 服务刚启动即被杀(所有环境;此前无人踩中因客户端按 print-config 直连脚本文件)。
   - **直连脚本文件在 nvm-windows 下静默失效**:`isMain` 用 argv 路径对比 `import.meta.url` —— `C:\nvm4w\nodejs` 是目录 junction,ESM realpath 后二者永不相等 → `runStdio` 不启动,进程 exit 0 无输出。**nvm-windows 全局用户的 MCP 客户端直连(文档推荐形态)全部中招**。
   - 处置:isMain 改 `realpathSync` 对比;CLI 路径挂起至 stdin 关闭。以临时 junction 实测两修均生效。→ **0.7.59 修复发布**(commit a864a8b)。
2. **全局包(0.7.59)全新 home 验收:33 PASS / 1 FAIL**,唯一 FAIL 为断言正则未随版本替换的假阴性(版本三证一致:aw --version / health / npm view 均 0.7.59)。覆盖:冷启动首注册 admin→7 内置插件三桥齐→MCP 通道→PLC 模拟(4029)→建线(3SV+3PV)→优化频道装配→数采自动抓取→两轮阶跃→产线报告 skill 两轮(R1=64/C 起步窗,R2=86.3/A 稳定窗,评分随真实窗口变化)→RAG 闭环(入库→检索命中→R2 引用 R1 定口径→双报告可检索)。
3. 发布工程事实:默认 registry=npmmirror(只读),发布须 `--registry npmjs`;pack 含预构建 .output(40.6MB/3724 文件),全局首起免构建秒级;CDN 版本可用性延迟 ~7 分钟(按精确版本安装可先行,dist-tag latest 同步最慢);lint-staged 对暂存 mjs 全量 eslint --fix,scratch 脚本须 lint-clean 才可入库。

## 七、遗留(更新)

1. ~~MCP 双雷~~ 已修(0.7.59);**3001 repo 实例仍是 0.7.58 构建**,如需 MCP 直连请重建重启。
2. 深度诊断 LLM/VLM 供应商耗时;aw start 陈旧构建版本戳;MinIO 校时。
3. scratch 验收脚本(tmp-e2e/global-package-e2e.mjs 等 4 个)因 lint 风格暂未入库,本地可用。

## 八、时区与时间正确性专项(联网精确时间 → 三时区 → 落库 → MES 时间窗)

**命题**:从互联网获取精确时间;测试上海/UTC/US 三地时间选择;确认数据库时区统一;MES API 支持按时间查询。

| 测试 | 结果 |
|---|---|
| T1 联网精确时间 | **三独立 NTP 源(ntp.aliyun/time.windows/time.cloudflare)两两相差 ≤74ms,双 HTTP Date 头(baidu/cloudflare)秒级一致**;精确时间 2026-10-12T13:44:36Z。**发现本机时钟慢 17.4s**(三源一致;`w32tm /resync` 需管理员权限未能自动校时) |
| T2 数采落库 | 样本存 **Timescale `daq_samples.ts` = timestamptz**(绝对瞬间/库内 UTC 微秒),`at` 为 epoch ms;28.3 万行新鲜可查;全部 SQL 参数绑定 |
| T3 三时区窗口一致性 | 同一瞬间(上海 21:40+08 = UTC 13:40Z = 纽约 09:40-04)三种墙钟表达 → **同一 epoch(1791812400000)**;三窗查询 **10935 行/24 节点/首末时间戳/数值总和逐字段一致** ✓ |
| T4 运行时时区切换 | `PATCH /api/system/settings {'time.timeZone':'America/New_York'}` 热生效:平台输出 ISO **21:50:49+08:00 → 09:50:49-04:00(同一瞬间)**;切回即复原;存储时间轴不动(渲染层切换);注意:审计等已存储的历史字符串保持写入时刻渲染,不随切换重渲(合理) |
| T5 MES 按时间查询 | mock MES(五格式仿真,ISO UTC 上游)→ mes-rest 节点(historyMap 须为 **JSON 字符串**,对象会被 "[object Object]")→ **v2 授权面经配方参数节点**(DCW 直绑已废弃)→ `mes_fetch(20:00~21:30+08)` → **mesds-ad5ce148:1801 行(30min×1s 精确),首末行统一渲染 +08:00,min/max/mean/stddev+sha256 齐全** ✓ |

**结论:时间维度可投产** —— 存储层(timestamptz/epoch)绝对统一,查询层任意时区表达等价,人读层 IANA 时区热切换;MES 时间窗取数行数精确、时区归一。**投产前置:目标主机必须先校时**(本机慢 17.4s 实测;`管理员: w32tm /resync` 或启用 Windows Time 自动同步),平台不做自有 NTP 纪律,时钟偏差会原样进入落库时间轴。

## 九、真实简单综合轮(数据获取/下发控制/AML 训练投用/IDD+RAG)

**15 PASS / 6 FAIL;6 个失败全部收敛到一个根因:AML 门禁如实拒绝小样本模型——这是设计行为,不是缺陷。**

| 环节 | 结果 |
|---|---|
| 数据获取 | ✅ 4 路 PV(含 SP 镜像)新鲜样本;时序入 Timescale |
| 下发控制 | ✅ 写入受理(dieGap 1→1.02);http 驱动只写不读,读回须走 SP 镜像 DAQ 通道(bench spMirror 设计) |
| AML 数据集自动构建 | ✅ 三批次(逐批开跑/闭合)从时序库自动拉批次打标数据;清洗门如实工作(1s 网格缺失率 32.2%>30% 拒绝 → beat 2000+插值放宽后通过;137 行 → 426 行) |
| AML 真实训练×2 | ✅ 训练真实执行(mlp baseline 80 epochs,loss 2e-5);**晋升被评测门如实拒绝**:G1 0.49/0.1、G3 val 切分空(3 批次不足,需 ≥4-5)、G4 426 行<500 |
| IDD 深诊 | ✅ 直连任务面提交(上传 CSV→建任务 d1df4bca),omp 引擎 running |
| 产线报告 skill | ✅ 快诊出报告 |
| RAG | ✅ 入库+检索命中 |

**结论**:「数据获取→下发控制→AML 自动建模→诊断检索」的机制链 100% 打通且每一道门都在如实工作(清洗门拒脏网格、评测门拒小样本、鉴权面拒越权);**要过 AML 晋升门需要产线级数据campaign**(≥500 清洗行 ≈ 30-40 分钟连续批次、≥4-5 批次供 val 切分、配 hybrid 训练器——历史实证 stage6b 用 1724 行/10 runs+hybrid 达 G1 0.0992/G2 0.1092/G3 14.6% 晋升 production)。这不是机制缺口,是数据工程量问题,与 P13 bench 的设计一致。

—— 综合轮追加 2026-10-12(3111;脚本 tmp-e2e/round-aml-idd-rag-20261012.mjs;数据集 ds-mv5iogha;IDD 748969db)
