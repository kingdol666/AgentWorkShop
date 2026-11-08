# 生产就绪审计底稿 · 独立评审报告

**评审对象**：`docs/audit/2026-11-08-production-readiness/AUDIT-BASE.md`
**生产场景定义**（沿用任务给定）：单实例/小团队内网部署、局域网产线接入、有真实设备写控
**抽查范围**：底稿 8 项指控中复核 5 项 + 全局扫描 2 项 + 盲区 6 个角度，均带代码证据

---

## 一、关键定级复核（抽查结果）

| 底稿声称 | 抽查结论 | 复核证据 |
|---|---|---|
| P0：6/14 引擎构造崩溃 | **成立，维持 P0** | `base-agent.ts:83` 构造器调 `refreshIdentity()` → :100 读 `this.harnessId`；`one-shot-cli-agent.ts:138` 的 `this.spec` 赋值在 `super()` 返回之后，:141-143 getter 此时必抛 TypeError。`registry.ts` 实测 14 个引擎块、恰好 6 处 `continuityMode: 'per_turn'`（:194/204/214/224/234/254）——底稿计数精确 |
| P1：mock 默认 | **成立，且低估了同类面** | `projects/service.ts:609/628/2490` 三处确认。**底稿遗漏**：`daq-node.ts:97`、`dcw-node.ts:108` 的设备驱动同样 `?? 'mock'`——在"真实设备写控"场景，采控节点静默落到 mock 驱动比 mock leader 更危险（数据造假/写控空转） |
| P1：watcher 错位 | **成立** | `system-config/snapshot.ts:29-30` 两个 watch 均非递归；生效配置在嵌套的 `<root>/.AgentWorkShop/runtime-settings.json`，外部写入确实永不触发 |
| P1：成果提交缺口 | **成立** | `projects/service.ts:1389-1402`：`releaseTaskInstance` 关会话 + `UPDATE channels SET enabled=0`（先 manager 路径，失败兜底直写），实例 lead 的提交面随 root 终态关闭属实 |
| P1：Codex copy 在 mkdir 前 | **成立** | `codex-agent/client.ts:123` `copyFileSync` 先于 :129 `mkdirSync`；:125 的 catch 注释写"单文件缺失忽略"，实际吞的是目标目录不存在——静默丢种子确认 |
| P1：备份冻结 | **部分过时，建议降级 P2** | 库文件拷贝**已改异步**：`backup.ts:104` `copyFileAsync`，:100-102 注释明确记载既往事故与修复理由；checkpoint 已 PASSIVE（:96）。残留风险仅两处：`dirBytes`（:21-41）同步全树 stat 无上限；对象面 `cpSync`（:68）同步但受 200MB 上限截停。「实例启动须 BACKUP_DISABLED=1」的既往实测不再适用于库路径 |

定级总体判断：底稿定级方法论扎实（证据带行号 + 活体实测 + 自我纠错记录），仅备份一项需按当前代码重估。

## 二、按真实生产场景重排 P0/P1/P2

### P0（上线阻断）
| # | 项 | 理由 |
|---|---|---|
| P0-1 | 6/14 引擎构造崩溃 + restore() 无逐 channel 兜底 | 43% 引擎选即崩；restore 路径可致启动崩溃循环；8 天无拦截说明无任何回归闸门。修复本身很小（1-2 人日），不修无理由上线 |
| P0-2 | **（新增，底稿漏项）设备驱动 `?? 'mock'` 静默默认** | 有真实设备写控的产线，采控节点漏配 driver 即静默 mock：数据是假的、写控 ACK 是假的。这是安全级隐患，且修复成本极低（产线绑定节点强制显式 driver） |

### P1（上线后 30 天内必须收敛，有临时绕行的可带病上线）
| 项 | 相对底稿的调整 | 理由 |
|---|---|---|
| activate 长阻塞无超时（43.4s） | **升入 P1 主项**（底稿放全局扫描） | 它是 P0 的放大器：调用方 30s 超时误判失败而服务端继续 → 资源悬挂 + 队列残留（底稿实测已见 idle lead 残留）。限流的真实危害主要来自它 |
| 成果提交缺口 | 维持 P1 | 自主模式下项目卡交付；小团队 owner 在场时 owner REST 可绕过 |
| watcher 错位 + CLI 虚假确认 | 维持 P1 | 运维误导性配置变更不生效且 UI 声称生效——比功能缺失更危险的是"假成功" |
| 事件协议无结构化 Block | 维持 P1（审计面优先） | 产线写控场景下工具动作审计是合规刚需；前端正则退化部分降 P2 |
| mock leaderHarness 默认 | 维持 P1 | 造成无效而非危险；与 P0-2 一并修（同一 PR 改默认策略） |

### P2（可排期，不阻断）
- 插件热重载 6s 空窗：单实例内网、管理员在维护窗操作，有"重启代替 toggle"绕行 → 底稿 P1 **降 P2**（宿主级快照回滚缺失仍在 90 天计划）
- 备份冻结（已部分修复，残留 dirBytes/cpSync）→ P2
- 无全局限流：内网小团队 + 反向代理可兜 → P2（但 activate 超时修复后其危害大减）
- Timescale 缺省口令 `awshop`：内网 + 单实例 → P2，但上线清单必须含改口令一步
- UI 三处硬编码引擎清单 → P2（底稿已定 P2，同意）

## 三、盲区抽查（底稿遗漏项）

1. **【P0 级遗漏】daq/dcw 驱动 mock 默认**（见上）。底稿扫了 leader mock 却没扫同模式的设备节点，这是本次评审最有价值的增量。
2. **停机链路：比预期好，有一个隐患**。SIGTERM 语义正确（`01-instance-guard.ts:107-117` 交还 nitro graceful shutdown + 10s 兜底强退）；close 钩子完整（`workshop.ts:351-359`：停编排器/sweeper/reconciler/kernel → manager.shutdown 停调度器逐 agent stop → db.close）；chat 投递有崩溃补偿器（`open.ts:54-57` attempts 补列注释佐证）。**隐患**：10s 兜底 vs agent 冷启动 30~90s（`workshop.ts:344` 自述）——停机杀在飞回合，任务级检查点未验证。定 P2 验证项，非阻断。
3. **升级路径：有一个真实缺口**。迁移全部加列式幂等（好），但 `migrateLegacySchema`（`migrations.ts:375-387`）多语句 `db.exec` 的建表-插选-删-改名序列**无事务包裹**，半途断电可留孤儿表/缺表；且迁移发生在启动最早期，**早于**首备（+30s），迁移炸库时无前置快照可回。老库升级场景 P1，全新安装 P2。低成本解法：schema 变更时启动先做 pre-upgrade 文件快照。
4. **鉴权面：结论正面**。agent token 有轮换宽限列（v31 `prev_token/prev_token_until`，60s 双接受窗）；token 仅经 `x-aw-agent-token` 头消费，REST 响应不透出（抽查 agent-tools 两端点确认）；设置快照出口全掩码（`snapshot.ts:41-49`）。用户 token 过期策略未深查，P2 补查项。
5. **可观测性：/api/metrics 存在且实用**（DAQ 链路 9 计数 + 内存水位 + HITL 待办 + 备份时间戳，`metrics.ts`）。**缺口**：无引擎级失败/延迟指标——6/14 回归潜伏 8 天，一半原因是"崩了没有任何信号可见"。加 2 个计数器（engine_activate_failures_total / engine_turn_failures_total）即可闭环，成本低收益大，归入上线前。
6. **配置注入：优先级链明确但有脚枪**。`settings.ts:8` 文档化：描述符默认 < config.yml < runtime-settings.json < **环境变量**；设置页写的是 runtime-settings.json → **env 静默压过 UI 改动**。快照带 sources 可救，但 UI 未标"env 锁定"。P2：设置页加 env-locked 徽标 + 部署文档列 env pin 清单。

## 四、底稿「四、待专家评审问题」逐条立场

**Q1（P0 是否阻断 + 修复窗口）**
是，硬阻断。修复是构造顺序问题（把 `refreshIdentity` 移出构造器 / 工厂内先赋 spec），1-2 人日含测试。**窗口建议 2 个工作日封顶**，且必须同 PR 带上：restore() 逐 channel try/catch + CI 契约测试（headless 构造全部 14 引擎断言不抛）。真正要堵的是"8 天零拦截"——契约测试比修复本身重要。

**Q2（提交窗口：拓宽 vs owner REST + 自动 integrator）**
两个极端都不选。拓宽 release/宽限期会复活僵尸 channel（idle lead 残留已被实测观察到）；纯 owner REST 则自主模式名存实亡。**推荐**：按项目策略走（execution_mode 列 v33 已存在，基建现成）——`auto` 策略项目在 release 前由 system actor 自动走 draft→integrator 提交（留审计溯源）；`manual`（默认，受监管产线）保持 owner REST 并把"待提交"显式呈现在 UI 待办而非静默卡死。关键改动点：releaseTaskInstance 从"root 终态即关"改为"交付物门关闭后才关"。M 工作量。

**Q3（结构化工具块最小增量）**
不动 A2A Part schema。加一个可选 `data` Part，`kind:'tool_event'`，载荷版本化 `{tool, phase:'start'|'end', status, duration_ms, args_digest, text}`，由 omp event-mapping 与现有 `🔧` 文本 Part **并行**发射（不替换）；前端 `classify.ts` 结构块优先、正则退兼容。300 字符截断只留在 text 面。先做 omp 一个 emitter（它覆盖默认 terminal 面），其余 harness 后续迁移。同时把 `AW_GOV_HARNESS_EVENT_LOG` 生产 profile 下默认开——一行改动，审计闭环。S-M。

**Q4（被忽略的生产阻断项）**
有，一个：**daq/dcw 驱动 mock 默认**（本报告 P0-2，底稿完全未提）。另有三个次级遗漏值得进计划：迁移无事务包裹且无 pre-upgrade 快照（升级场景 P1）、metrics 无引擎失败信号（8 天盲窗的直接原因）、10s 停机兜底 vs 长回合的检查点未验证。备份冻结一项底稿夸大了（库路径已修）。

## 五、优化 Plan 骨架

### 阶段 0：上线前阻断（约 1 周）
| 改什么 | 为什么 | 验收标准 | 量 |
|---|---|---|---|
| 修 one-shot 构造顺序 + restore 逐 channel 兜底 + CI 全引擎构造契约测试 | P0-1；8 天盲窗必须用闸门堵死 | CI 矩阵 14/14 构造通过；gemini lead activate <5s 返回 200 | S-M |
| 产线绑定 daq/dcw 节点强制显式 driver（禁 mock 落地），启动校验 fail-loud | P0-2；真实设备写控不容静默替身 | 绑定产线的 mock 节点拒绝启动并列出清单；UI 无法保存缺 driver 的产线节点 | S |
| leaderHarness 去默认（缺省 400）+ schema 约束 | 与 P0-2 同族，同批修 | POST /projects 缺 leaderHarness → 400 带提示 | S |
| activate 服务端 deadline（~30s）+ 引擎失败计数器入 /api/metrics | 斩断长阻塞放大器；补 8 天盲窗的信号面 | 挂起 activate 有界返回并清理；计数器在注入故障时递增 | S-M |
| 升级保护：schema 变更时启动先快照三库+配置到 backups/pre-upgrade-*；legacy rebuild 包 BEGIN IMMEDIATE | 迁移炸库无可回是目前升级路径的真实缺口 | 升级中途 kill -9 → 用 pre-upgrade 快照回滚启动成功（演练一次） | S |
| 部署 runbook：env pin 清单、Timescale 改口令、token 轮换流程、恢复演练步骤 | P2 项的运营化收口，上线清单载体 | 按手册完成一次从备份的全量恢复演练 | M |

### 阶段 1：上线后 30 天
| 改什么 | 为什么 | 验收标准 | 量 |
|---|---|---|---|
| watcher 修（递归 watch 或直监听 settings 文件）+ CLI 文案诚实化 | "假成功"比不生效更危险 | 外部写 runtime-settings.json <1s 触发 reload；restart 键不再宣称实时生效 | S |
| 结构化工具块 v1（omp emitter + 前端结构优先）+ 生产 profile 事件日志默认开 | Q3 方案落地，产线写控审计合规 | omp 工具事件前端渲染为结构块；正则退路径保留 | M |
| 交付物门：按 Q2 立场实现（auto 策略自动 integrator / manual 策略 UI 待办显式化），release 改为门关闭后释放 channel | 自主模式闭环，消除静默卡死 | auto 项目全自主走完交付门；manual 项目卡住时 UI 有待办而非无声 | M-L |
| 停机加固：兜底窗可配置（默认上调）、在飞回合检查点验证、kill -9 恢复演练 | 10s 兜底 vs 30-90s 冷启动的缺口 | 负载下 SIGTERM：在飞回合落痕、子进程收干净、<30s 退出 | S-M |
| 观测补齐：engine 失败/延迟指标 + daq_dropped/heap 告警阈值接入现有 ops-log | 让下一场 P0 在分钟级而非 8 天被发现 | 注入模拟故障 → 指标+告警触发 | S-M |
| 限流：deploy/ 附反向代理限流配置 + activate/dispatch 端点级上限 | 内网纵深防御，成本极低 | 洪泛测试 CPU 有界；代理配置入库 | S |

### 阶段 2：90 天
| 改什么 | 为什么 | 验收标准 | 量 |
|---|---|---|---|
| 宿主级版本快照回滚（插件+配置启动快照 + 回滚命令） | 底稿指控1 指出的"半装载回滚不覆盖宿主" | 一次真实坏升级用快照回滚成功 | M-L |
| SQLite 容量/保留声明：tsdb 保留任务 + 容量文档（行数/GB、10/50/100M 行延迟实测） | 容量上限目前零声明，产线数据只增不减 | 保留策略生效；文档含实测数字 | M |
| 事件协议全 harness 对齐（claude/opencode/cursor 等 emitter 迁移） | 审计面全覆盖 | 各 harness 工具事件结构块渲染一致 | M-L |
| 设置页 env-locked 徽标 + sources 呈现 | env 静默压过 UI 改动的脚枪 | UI 改被 env 压制的键时有显式警告 | S |
| 备份对象面异步化 + dirBytes 深度/总量护栏 | 收尾 P2 残留 | 大对象目录下备份期间事件循环停顿 <500ms | S |

---

**总体判断**：`CONDITIONAL-GO — 满足阶段 0 六项（引擎构造修复+契约测试闸门、产线节点禁 mock 驱动、leaderHarness 强制显式、activate 超时+引擎失败指标、升级前置快照、部署 runbook 含恢复演练）后可上线；其余 P1 在上线后 30 天内收敛。`
