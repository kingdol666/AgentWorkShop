# 安全与鲁棒性加固 · 实施与验收报告

- 日期:2026-10-30(实施轮)
- 计划:`docs/plans/2026-10-30-security-robustness-plan.md`(v2:41 项逐项源码实证 → 33 确认 / 5 部分成立 / 3 推翻)
- 本轮结果:**B0–B5 六批全部实施**(除 4 项显式延期,见 §4),安全批新增单测 57 条、真机 e2e 3 套共 52 条断言,全量单测 841/841 全绿。

## 一、实施清单(按批)

### B0 止血
| 项 | 改动 | 验收 |
|---|---|---|
| P0-1 | `channels/[id]/twin-profile.patch.ts` 补 `requireChannelOwner`(照抄同族 execution-mode)+ 治理变更 `recordOps` 审计 | 单测 3 条 + 真机 S1.1–S1.5 |
| P0-2 | 新增 `server/utils/request-ip.ts`(`AW_TRUST_PROXY` 才采信 XFF);限流/登录两处消费点统一走 `clientIp` | 单测 4 条 + 真机 S2.1–S2.2(伪造 XFF 第 19 次触顶 429) |
| P0-5 | compose 三端口改 `127.0.0.1`,9001 控制台移入 `docker-compose.debug.yml`,口令改 `${AW_DAQ_*:?}` 强注入;`config.yml` 凭据留空;新增 `infra-credentials.ts`(随机生成 / 存量容器自省 / 尊重显式配置)+ `00-daq-credentials` 插件在配置解析前注入;`daqUrls()` 与 compose 共用同一份 | 单测 3 条 + 真机 S3.1–S3.3(链路真实连通)、S4.1–S4.3(渲染只绑回环) |

### B1 停机语义
| 项 | 改动 | 验收 |
|---|---|---|
| P0-3 | `01-instance-guard` 删除信号内 `process.exit(0)`,只留 10s 兜底强退;`release()` 挂 close 钩子 | 单测 2 条 |
| P0-4 | `start.mjs` 停止子进程改 `taskkill /PID /T /F`(整树),POSIX 保留 12s 优雅窗口后强杀 | 单测 2 条 + 真机 T1–T3(孙进程无残留) |
| P1-5 | 数据锁改 `flag:'wx'` 独占创建;EEXIST 时探活:存活拒绝、死 PID 接管并留痕 | 单测 2 条 + 真机 L1–L4 |
| P1-9 | `env-lease` 死 PID 残留锁自愈接管(存活即拒绝,含同进程并发) | 单测 3 条 |

### B2 子进程与密钥
| 项 | 改动 | 验收 |
|---|---|---|
| P1-1 | omp RPC 启动器复用 `scrubPlatformSecrets`(不再全量继承) | 单测 2 条 |
| P1-2 | MES hook 改 `cleanEnv: true` + `hookEnv()` 白名单(系统键 + `AW_MES_*`) | 单测 1 条 |
| P1-3 | 新增 `system-config/secrets.ts`:出口掩码(admin 也只看 `***`)、入口剔除掩码回传;snapshot/事件/PATCH 响应统一接入 | 单测 4 条 + 真机 M1.1–M1.3 |
| P2-1 | ingest token 改 sha256 + `timingSafeEqual`,空值拒绝 | 单测 2 条 |
| P2-11 | 新增 `bench-mode.ts` 双 env 保险丝(`AW_BENCH_MODE=1` 且 `AW_BENCH_ACK=1`),4 处消费点全部接入;bench 文档同步 | 单测 2 条 |

### B3 授权补口
| 项 | 改动 | 验收 |
|---|---|---|
| P1-8 | analysis POST / ops-logs POST 补 `requireLineForResource(...,'operate')`;空 lineId 全局台账仅 admin;报告/上下文长度上限(P2-2) | 单测 3 条 + 真机 M2.1–M2.5 |
| P2-5 | DAQ 自定义模板加 `ownerUserId`,改删仅属主/admin | 单测 2 条 + 真机 M3.1–M3.3 |
| P2-6 | 孪生操控/改/删 + 资产上传收口 editor+(新增 `asset-auth.ts`) | 单测 2 条 + 真机 M4.1–M4.3 |
| P2-7 | 密码下限 6→8;每用户 token ≤20(淘汰最老);登录锁定**按账号**且**先验密码**(正确密码不受锁定影响,IP 仅入审计) | 单测 3 条 + 真机 M5.1–M5.2 |
| P3-8 | A2A AgentCard 加 `security.a2aCardPublic` 开关(默认 true) | 单测 1 条 + 真机 M6.1–M6.4 |
| P3-10 | 注册默认值注释纠正(默认 false) | 单测 1 条 |

### B4 韧性
- **P1-4** Modbus 首连 `modbusInflight` 去重(照抄 OPC UA 模式)。
- **P1-6** daq(250ms)/dcw(500ms) sweep 回调逐段 try/catch 隔离(含逐节点判定与回退评估)。
- **P1-7** 报警 webhook、embedding baseUrl、插件 `ctx.http` 三处出站统一 SSRF 护栏(`AW_ALLOW_PRIVATE_OUTBOUND` 显式放行内网)。
- **P1-10** 限流三 Map 惰性清扫 + chunked body 直接 413。
- **P2-3** CSP 生产环境去 `unsafe-eval`。
- **P2-8** 全仓 legacy `Object.assign(new Error,{status})` 迁 `AppError`(6 文件 16 处),删除响应层直通分支。
- 验收:单测 15 条(含 B5)。

### B5 结构债
- **P2-12** 工具清单单一源:`OBSERVE_BLOCKED_TOOL_NAMES` 由 `HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES` 派生,dispatch 两处内联清单删除。
- **P3-2** `backupOnce` 在飞互斥;**P3-7** json-store 读失败(非 ENOENT)留痕。

## 二、验收矩阵

| 层 | 套件 | 结果 |
|---|---|---|
| T0 | `npm run typecheck` | ✅ 通过 |
| T0 | `npm run docs:check`(`node scripts/check-docs-sync.mjs`) | ✅ 89/89(设置项计数 128→129 已全仓同步) |
| T0 | `npm run i18n:check` | ✅ PARITY OK(3173/3173) |
| T0 | `npm run readme:lint` | ✅ 通过 |
| T0 | `npm run lint` | ⚠️ 仓库级基线红(~30k 条,集中在 data/workspaces 的 Agent 生成脚本与 paper 工具,与本次改动无关);**本次改动文件单独 eslint 0 error** |
| T1 | 全量单测 `tests/*.test.ts` | ✅ **841/841** |
| T1 | `test:mcp` / `test:plugin-lifecycle` / `test:sdk-surface` / `test:twin-provider` / `test:skills` | ✅ 全绿(插件 22/22、skill 124/124) |
| T2 | `scripts/e2e-security-b0.mjs` | ✅ 18/18 |
| T2 | `scripts/e2e-security-b1.mjs` | ✅ 8/8 |
| T2 | `scripts/e2e-security-b2b5.mjs` | ✅ 26/26 |
| T2 | `npm run test:e2e-line`(产线治理) | ✅ 44/44 |
| T2 | `scripts/e2e-binding-modes-real.mjs`(四绑定 × 真实协议) | ✅ 19/19 |
| T2 | `scripts/e2e-mes-mirror-real.mjs`(镜像数采 + **真实 Qwen3.5 64k**) | ✅ 17/17(含 Q1 模型自主 `daq_query`、Q2 可读结论) |
| T2 | `scripts/e2e-physical-effect-real.mjs`(真实 Modbus 物理生效 + Qwen) | ⚠️ 19/21(见 §5.1) |
| T3 | `npm run test:api-live`(REST 状态机/作用域/订阅/WS/级联删除) | ✅ 61/61 |

**未覆盖声明**:T2 其余套件(本体 87、模型闭环 54、优化器 104、注塑闭环、IDD 结果库)与 T3 其余套件(Team/HITL/多 Agent 工具面/模板隔离/权限矩阵/时区/鲁棒性/崩溃恢复)、T4(插件与工具注册面实调)本轮**未运行**——它们与本次改动的交叉面已被产线治理 44、四绑定 19、镜像数采 17、api-live 61 与 835 条单测覆盖,但不能据此宣称这些套件无回归。

### 真实模型说明
- LM Studio 实例:`qwen3.5-9b-64k`(qwen3.5-9b-claude-4.6-opus-reasoning-distilled-v2,**context 65536**)。
- **踩坑记录**:首次 `lms load -c 65536` 后 `lms ps` 显示 4096("PARALLEL 4"),omp 报 `n_keep: 19295 >= n_ctx: 4096`,任务停在 WORKING 且无工具调用。重新 `lms unload --all` + `lms load ... -c 65536` 后 `lms ps` 确认 65536,omp `-p` 冒烟返回 `OMP_OK`,同套件随即 17/17。**结论:此前 Q1/Q2 失败是模型上下文配置问题,不是系统缺陷。**

## 三、关键行为变化(运维需知)

1. `AW_TRUST_PROXY=1` 才采信 `X-Forwarded-For`;直连部署下限流/锁定按 socket 地址。
2. `AW_BENCH_MODE=1` 不再单独解防,**必须同时** `AW_BENCH_ACK=1`;bench 脚本/文档已同步。
3. 数采基础设施凭据改为本机生成(`<数据目录>/daq-infra-credentials.json` + `.env` 形态),`config.yml` 中留空;存量部署首启从运行中容器自省,不断连。
4. 设置面口令类键一律 `***`;前端回传 `***` 不会覆盖真实值。
5. 登录:连错 5 次后**错误密码**返回 429,但**正确密码仍可登录**(攻击者无法锁死他人账号)。
6. 密码最短 8 位;每用户 token 上限 20(超出淘汰最老)。
7. 内网出站默认拒绝;确需访问内网设 `AW_ALLOW_PRIVATE_OUTBOUND=1`。

## 四、显式延期(4 项,附原因)

| 项 | 原因 | 后续 |
|---|---|---|
| **P2-4** WS token 走 URL 查询参数 / 无 Origin 校验 | 需同时改前端连接方式(首帧认证 / Sec-WebSocket-Protocol)+ 真机 e2e 复核,单改服务端会打断 3D 小镇与终端 WS;当前已有 token+成员+产线三重鉴权,URL 泄漏面取决于反代日志策略 | 单独立项(含前端) |
| **P2-9** scryptSync / inflateSync 阻塞事件循环 | `hashPassword/verifyPassword` 被 5 处同步调用(`create`/`update`/`seed`/登录/改密),异步化会外溢到 18+ 调用点与大量单测;内存放大已有 `maxOutputLength`+`MAX_PIXELS` 兜底,剩余是单次 ~50-100ms 的 CPU 阻塞 | 与 P2-10 同批(异步基础设施) |
| **P2-10** JSON 仓储"先改内存后落盘" | 18 个同构 repo 的机械改造,需全量回归;计划本就把 B5 标为"单独排期" | 代表 repo 先行 |
| **P3-4** steer 失败重投无上限 | 需给 messages 加 attempts 列(库结构变更 + 迁移) | 与下次 schema 变更合并 |

另:P3-3(retention 第二 SQLite 连接)、P3-9(h3 RC)、P3-12(ACP 适配器补测)、P3-14(超时集中治理)维持 v2 判定为低优先,未在本轮动;P3-5/P3-6/P3-10/P3-11 已在 v2 核实为推翻/已有实现。

### 5.1 物理生效套件:A1/W0 未收敛(如实记录)

- **通过(19 项)**:真实 Modbus 设备直读、开线配方直达寄存器、采样活性、**平台样本 = 设备直读(≤1.5℃)**、Agent 工具面复抓与 SP 方向一致、HITL 批准链、越界/步限拒绝等。
- **未通过(2 项)**:`A1`(Agent 自主抓数任务须 COMPLETED/CANCELED)与 `W0`(Agent 自主试验落到寄存器)。失败详情均为 `state=WORKING`,而 A1 的轨迹里**模型确实调用了两次 `daq_query` 并拿到结果**;即模型在推进,只是未在窗口内收敛。
- **归因**:本轮为 64k 上下文推理模型(qwen3.5-9b reasoning-distilled),单轮时延显著高于脚本原先调优的 32k flash;窗口已放宽到 15 分钟仍不足。已把窗口改为 `AW_PHYS_AGENT_WINDOW_MS` 可调,并在报告里记录该环境事实。
- **同类能力的替代证据**:①同一模型在 `e2e-mes-mirror-real.mjs` 的 Q1/Q2 中自主 `daq_query` 抓镜像数采并给出可读结论(17/17);②`e2e-binding-modes-real.mjs` 以 Agent 令牌 + HITL 完成设备级下发,设备寄存器读数 200/170(19/19);③`test:e2e-line` L12 完成 DCW 写入/回读/单步/60s/量程五类断言(44/44)。
- **未覆盖声明**:因此"模型自主发起试验并在窗口内完成闭环"这一条**本轮未取得通过证据**;需要更快的执行模型或更长窗口重跑,不以此宣称该能力已验证。

## 五、如实声明

- 本轮 6 批全部实施完成,4 项显式延期并说明原因;不宣称"系统完全安全"(Mimosa 扫描 coverage=inconclusive)。
- 全量单测 841/841;安全批新增 57 条单测 + 3 套真机 e2e 共 52 条断言全绿。
- `npm run lint` 仓库级基线为红(与本次改动无关,集中在 Agent 生成脚本与论文工具目录);本次改动文件经定向 eslint 检查 0 error、typecheck 通过。
- 物理生效套件结果为真实 Modbus 寄存器独立读取 + Agent 下发对照(见证据目录)。
- 共享工作树存在并行会话在途改动(paper/、manual-approval 等),本轮提交按 pathspec 限定,不卷入他人文件。

## 六、PIPELINE 设计评审 + 两轮复现验证(2026-10-30 补记)

**设计评审结论**:v2 写面迁移后的 PIPELINE 设计可稳定落实。骨架已具备:种子确定性(mulberry32)+ harness 指纹 + git 指纹;空跑/全 skip 防假绿门;60s 写联锁的调度纪律(exploreWrite 等待重试、P4c 前置 sleep、P4b→P4c 换线);P8b 双重清场(open 记录 + 待审批卡)+ 兜底判定按 nodeId 反查内层记录。

**本轮加固(3 处,均不改判定类语义)**:
1. P8b 冻结值由硬编码 150 改为按 setpoint 构造(setpoint.hi+20% 量程,对任意窗口必然窗外),防未来预设变化造成"冻结值落窗内→兜底永不触发→假通过"。
2. HARNESS_FILES 指纹补入 `lib/platform.mjs`/`lib/line-profile.mjs`(自举与画像采集也是 harness,改动此前不留指纹痕迹)。
3. P0 证据与 run.json.env 记录 AW_HOME/AW_MODE 隔离契约,复现审计可追溯。

**回归**:compare.mjs --selftest PASS(阴性对照被门槛正确拒绝);node --check 全过。

**两轮复现(全新隔离配置根,3007/4018,seed 42,--cl-seeds 3)**:
- run K `bench/results/20261029174841-25u4`(冷启新库,含首注册 admin 路径):✅ PASS(72/5/0)
- run L `bench/results/20261029180436-1lo0`(同实例复跑):✅ PASS(72/5/0)
- `bench/tools/compare-pipeline.mjs` K vs L → **REPRODUCIBLE(判定类失败 0 · 环境类 10 项)**,产物 `bench/results/compare-pipeline-20261030-KL.md`。逐位一致项:verdict、77 检查 id 集合与逐项 status、F5 池化 24/24 拦截 0 误拦、J*=89.894、portability 五协议构成、兜底 fired+restored、biax 9 设备/30SP/达标。环境类浮动:闭环 J0/Jend 采样值、biax 终值 24.84/24.80μm、兜底时延 120.2/120.1s。
- warn 5 项两轮完全同集(P0 数采冷启滞后、P4 两条不可回读激励线、P4c HITL、P10 语义卡),与上一轮 I/J 的 warn 集合同构。

**环境坑(记录)**:Git Bash 多层转义会把 `D:\codes\...` 形态的 AW_HOME 双层求值成无反斜杠的 drive-relative 路径(本轮隔离根因此落在仓库内 `codesABOaw-bench-home-20261030/`,功能上仍是全新隔离库;验证完毕已停实例并删除)。后续以正斜杠 `D:/...` 形态传 Windows 路径。
