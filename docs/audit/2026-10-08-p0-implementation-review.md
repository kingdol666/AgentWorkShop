# 优化 Plan 多专家审批 + P0 全量落地实证

- 日期:2026-10-08
- 方法:4 专家并行审批(控制链/存储层/OOM 运维/顺序与 P1 快评,只读探查 file:line 取证)→ 按审定方案实施 → build + 生产重启 + 全项 API/DB/文件级实证
- 前序:[2026-10-07 架构评审与优化 Plan](2026-10-07-architecture-review-plan.md)(3b24891)

## 1 审批轮:4 专家对 plan 的修正(全部采纳)

| Plan 原案 | 专家裁决 | 修正后终案 |
| --- | --- | --- |
| P0-1 纪元指纹+confirmedValue | **需修正**:纪元指纹有崩溃恢复漏洞(重启后指纹丢失,`dcws.json` 持久化 value 会让停机期换绑残留值在重启后恢复心跳直写,复现 10-07 事故);mark-good/回退/cadence 消费面核实均不读 value | **变更点清值**替代纪元(覆盖重启场景、零新状态):失败写不占位 + driver/driverConfig/lineId/deviceIds 变更即清 value + 心跳加产线活动门 |
| P0-2 按前缀删天目录 | 可行,补 3 处:①删前 DB 交叉校验(daq_frames 该天窗口有行即跳过,兜住保留期改大/时钟回拨/迟到帧);②首轮只对 disk 后端启用;③sha256 写入时算、存量 10285 文件不回填 | 天目录 UTC 严格四段形状 + DB 交叉校验 + 单轮 50 目录限额 |
| P0-3 chunk=retention/10 + 压缩 | 可行但有**前置闸门**:列存压缩是 TSL 特性,社区镜像默认 apache license 下 ALTER 直接报错;且 init 失败会被工厂降级 SQLite(=扔掉生产库) | compose 加 `timescaledb.license=timescale`;chunk 钉 1 天(优于 retention/10,与对象 GC 天界对齐);6 条物理 SQL 逐条守护只告警不阻断 init |
| P0-4 pm2/docker restart | **方案需换**:start.mjs 是同进程直载 nitro(无子进程树,pm2/docker 均无现状);Windows SIGTERM 不可达,但系统本就 crash-safe(启动对账链齐全,`aw stop` 即 taskkill /F) | start.mjs 改 **spawn+respawn 监管**(退避 2s→60s、1h 窗口上限 10 次、健康失联 3 连判死、堆水位 ≥94%×3 拍主动重启);父退先杀子 + 子进程 parent-watch 插件双保险防孤儿占端口;压测推 P1 |
| P0-5 mock 兜底封堵 | 可行,补 2 个 plan 漏点:resolve 兜底(`?? mockDcwDriver`,插件卸载路径)与 fromRow 迁移(磁盘遗留坏 kind) | dcw/daq 双侧 registry 严格解析(require)+ 缺失驱动占位器(写/读/采样显式失败)+ 启动迁移打标 |
| 顺序 | P0-5 → P0-1 → P0-3 → P0-2 → P0-4;P1-6/P1-5 为快赢 | 已按此序执行 |

另修一处存量缺陷:`daq-export.ts` manifest.nodes 类型收窄(typecheck 此前在 main 上已红)。

## 2 落地清单(35 文件,全部 typecheck ✔ / docs:check 91✔)

### P0-1 保写心跳生命周期根治(10-07 事故根因四连修)
- `dcw-node.ts` `applyWriteResult`:失败写不再占位 value(value 只承载设备确认值)——心跳不再把幻影指令值周期直发,步长基准/回退账本 prevValue 不再被污染
- `dcw-controller/crud.ts` patch + `bindings.ts` 五函数:driver/driverConfig/lineId/deviceIds 变更即 `value=null`+rearm(换绑残留节点心跳停驻,新写成功才复驻)
- `dcw-runtime.ts` tick + `state.ts` host:`lineActive(lineId)` 产线门——绑线节点仅产线活动批次在跑时保写,停线即挂起开线自恢复;`lineId=''` 独立通道不受门控
- `actuation.ts`:写历史/broadcast 的 eng 改记「本次尝试值」(失败审计保真)

### P0-5 mock 静默兜底封堵(dcw+daq 双侧)
- 严格解析 `requireDcwDriverKind`/`requireDriverKind` 进 create/patch/testDriver 入口(镜像 daq 2026-10-04 先例)
- `resolveDcwDriver`/`resolveDaqDriver` 去掉 `?? mock` 兜底 → 缺失驱动占位器(写/读/采样**显式失败**,插件卸载不再假成功)
- 两仓 repo load() 启动迁移:别名归一(modbus→modbus-tcp),未知 kind 降级 mock+lastError 打标+告警(不砖启动)

### P0-2 对象存储 GC
- 新 `objectstore/gc.ts`:90s 首轮 + 24h 周期;天目录(UTC 严格形状)早于 `frameRetentionH` 且 **daq_frames 该天无行(交叉校验)** 才整目录删;单轮 50 目录限额
- 端口扩展 `listDayDirs/removePrefix`(disk 实现含空父目录收尾;minio 首轮未启用)
- 删 daq 节点级联删 `daq/<nodeId>/**`(fire-and-forget,GC 兜底)
- 图像 sha256+size 写入时算,经 queue envelope → `daq_frames.meta` 持久化

### P0-3 Timescale 物理参数
- compose:`timescaledb.license=timescale`(TSL,自托管免费)
- init 内 6 条幂等 SQL 逐条守护:chunk 钉 1 天(两表)+ 压缩(segmentby node_id/orderby ts DESC,PK 全覆盖)+ 压缩策略(compress_after 1 天);失败仅告警不阻断 init
- 保留期维持代码内 drop_chunks(跟随运行时配置);schema.json 保留期描述纠正(原描述与实现相反)

### P0-4 OOM 治理
- 新 `server/plugins/memory-watch.ts`:30s 采样,75% warn 带增量/90% error,环形序列落 `.runtime/last-mem.json`(重启自愈后的泄漏差分可直接读)
- health `memory` 字段(heapUsed/limit/rss/ratio)+ metrics 三项堆指标
- `scripts/start.mjs` respawn 监管 + 新 `server/plugins/parent-watch.ts`;堆限额固化(父进程未带 NODE_OPTIONS 时子进程补 4096MB)

### 快赢 P1-5 + P1-6
- P1-5 新 `dcw-controller/gate-persist.ts`:writeLocks + trialLastAt 落盘 `dcw-gate-persist.json`(对齐 op-anchor 模式;重启窗口延续,堵"重启即绕频控")
- P1-6 `grant-guard.ts`:**频道绑线并入复核集**——line_start/line_stop 的目标产线来自 `ch.lineId` 而非调用参数,修复前 agent 无节点绑定时守卫直接放行(撤权即失活缺口)

## 3 实证结果

| # | 验证 | 结果 |
| --- | --- | --- |
| 1 | P0-5 未知驱动 create/testDriver 显式拒绝(dcw+daq 三入口) | ✅ 3/3 拒绝,显式 mock 合法 |
| 2 | P0-1 成功写占位 value=30(锚 anc-68a1570c 入册,回退账本联动正常) | ✅ |
| 3 | P0-1 driverConfig 变更清值(30→null,修复前保持 30 被心跳周期直发) | ✅ |
| 4 | P0-1 失败写(modbus 不可达)ok=false 且 value=null(修复前=42 幻影值) | ✅ |
| 5 | P0-2 GC:2025-09 夹具目录删除、2026-10 目录保留、日志留痕 | ✅ |
| 6 | P0-2 删节点级联删对象目录 | ✅ |
| 7 | P0-3 license=timescale、两表压缩策略注册(compress_after 1d)、init 0 条告警 | ✅ |
| 8 | P0-4 health.memory(heapRatio 0.0182/limit 4288MB)+ last-mem.json 30s 序列 | ✅ |
| 9 | P0-4 respawn:taskkill 子进程 #1 → "2s 后自动重启" → #2 拉起 → 20s 恢复服务 | ✅ |
| 10 | P1-5 dcw-gate-persist.json 落盘(writeLocks 实条目) | ✅ |
| 11 | P1-6 正向:admin/有权属主 daq_query 不误伤 | ✅ |
| 12 | P1-6 反向:demo-op 授权→建绑线频道→line_stop/daq_query 走通;**撤权后两者均被 v3 拒绝** | ✅ |
| 13 | 回归:docs:check 91/91;typecheck 全绿;既有治理链(60s 间隔 429 拦截实测)正常 | ✅ |

## 4 行为变更通告(运维须知)

1. **换绑/改配/换线后保写静默失效一拍**:须重新写成功才复驻(设计意图,防陈旧值直发)
2. **停线后保写心跳停止**,开线下一拍自动恢复
3. **失败写不再被心跳自动重试**:瞬断后需人工重发(安全性更优)
4. **声明真实协议但驱动缺失的节点**:写/读/采样显式失败并打标,需重新配置驱动
5. **Timescale 容器需以新 compose 重建一次**(license 参数;named volume 数据保留)
6. **生产启动建议仍带 `NODE_OPTIONS=--max-old-space-size=4096`**:不带时父进程自动补 4096MB
7. demo-op@test.local 测试口令已在验证中重置(DemoOp2026!),grant 已撤

## 5 遗留与后续

- **P1 剩余**:P1-1 统一 data_query(4-8h,完全体等 P1-2 logicalRef)、P1-2 名义信号点(1-2 天)、P1-3 批次事务 resumeRun(0.5-1 天)、P1-4 daq 大窗异步数据集(1-2 天,等存储 P0 稳定)
- **P2**:writeFrames 批插、真实图像解码、MQTT 首帧等待、插件工具纳入守卫口径等
- **观察项**:图像 sha256 管线待下次产线图像采集窗口实证(代码链路已通);压缩策略 12h 调度首次压缩存量 7 天 chunk 时留意负载;5h 级慢泄漏根因待 P1 压测 + last-mem.json 差分定位
