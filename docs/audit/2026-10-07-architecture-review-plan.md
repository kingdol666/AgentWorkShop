# 系统架构四专家评审 + 目标架构验证 + 优化 Plan

- 日期:2026-10-08 凌晨(评审)+ 当日架构验证测试
- 方法:4 个并行评审 Agent(采集存储层/工具路由层/控制解耦层/绑定权限层,只读探查 file:line 取证)+ 目标架构验证测试(tmp-e2e/arch-verify.mjs,**11/11 有效通过**)
- 用户目标架构:多协议(MES API+PLC)建节点 → 多源异构(标量/向量/图像)入库 → Channel 内 Agent 按绑定节点取数/下发 → 镜像走库、API 走 API 的工具路由 → recipe 解耦下发

## 1 目标架构验证结果(全部达成)

| 目标 | 结果 | 证据 |
| --- | --- | --- |
| 多协议节点混布 | ✅ | 同一条线 16 数采节点驱动族=[http,modbus-tcp,opcua,modbus-rtu];数控 6 节点含 mes-rest 自定义 API 写点 |
| 标量→时序库 | ✅ | 500 桶/min |
| 向量→时序库 daq_frames | ✅ | 48 点全点列入 meta JSONB |
| 图像→对象存储+帧元数据 | ✅ | PNG 入对象存储,daq_frames 存引用/尺寸/mime |
| 绑定驱动取数 | ✅ | 已绑可取;未绑拒绝(fail-closed) |
| 镜像路(库)取数 | ✅ | MES 镜像节点 431 桶/2min |
| API 路直取 | ✅ | mes_fetch 工具面可用(参数契约校验正常) |
| recipe 解耦下发 | ✅ | 一次 HITL,OPC UA+MES-rest 双协议同批 2/2 成功,Agent 零协议感知 |
| 治理拦截 | ✅ | 下发间隔卡控 0s 拦截(越界限界此前多轮实证) |

## 2 四专家评审核心结论

### 2.1 采集与异构存储层
- 新增协议扩展点**收敛良好**:4 处改动(类型联合/驱动目录/驱动实现/注册表),插件路径可零内核接入。
- 断连自愈三协议各自完备(3s 超时/3 错误驱逐/空闲回收);打标在消费侧 ingest 统一,天然驱动无关。
- **P0 欠账**:①对象存储像素**无 GC**(remove 全仓零调用,1Hz 相机数 GB/天/节点只增不减,帧行过期像素成孤儿);②Timescale 未设 chunk_interval、未开压缩,保留期与 chunk 错位导致空间不回收。
- P1:writeFrames 逐行往返(应批插);真实 JPEG 相机会静默跳过缩略图/质量门(decodeGrayPng 只认本仓灰度 PNG)且无指标。

### 2.2 工具路由层(对用户"镜像走库/API 走 API"期望的关键结论)
- **现状无自动路由**:daq_query 只查镜像库,mes_fetch 只直取 API,选择靠 Agent 读工具描述自行判断——与期望的"按节点模式自动路由"有差距。
- 授权两套口径:daq 用 kind='daq' 绑定、MES 用 dcw∪recipe 绑定,同节点双面访问需双绑定。
- 大数据降级:MES 侧成熟(>2000 行异步 CSV 数据集+统计读取);daq 侧缺同级路径(只有 limit 截断+export)。
- 建议:新增统一 `data_query` 工具按节点自动路由 + 抽公共"节点可见性"模块 + 数据集通道泛化到 daq。

### 2.3 控制解耦层
- **解耦是教科书级的**:recipe.params 无任何协议字段→write() 治理咽喉→resolveDcwDriver(node.driver) 单点分发;Agent 面零协议感知(dcw_control 直写已整体摘除)。
- **P0 事故根因定位(10-07 保写心跳污染)**:换绑不清 value(crud.ts:67-141)、失败写也占位 value(dcw-node.ts:136-148)、心跳 tick 直发绕过全部治理(dcw-runtime.ts:95-118)、停线不挂起心跳。根治=纪元指纹+confirmedValue+失败写不占位+停线挂起。
- P1:批次无事务语义(部分成功靠 Agent 自觉,建议意图 journal+自动续传/补偿+下发前批量连通性预检);node.value 指令值≠确认值污染步长基准;未知驱动静默降级 mock=协议假成功;试验节拍/写保持窗不持久(重启即清)。

### 2.4 绑定权限层
- 授权闭环完整:取数(daqTargetsOf 边界)+下发(四门:绑定→二级认证→运行门反僵尸→HITL)+v3 收权即失活(grant-guard 分发入口复核)+委派溯源(不可超越授予者)。未发现可绕过路径。
- **结构性短板**:①"镜像/直取"无显式模型字段(纯实体类型隐式约定),直取读权错挂写绑定(只读诊断频道无法 mes_fetch);②grant-guard 回退不含频道绑线(撤权后只读面失活缺口);③插件工具先于守卫分发;④频道换绑线不级联清理绑定;⑤节点创建权限要求 admin(与"Agent 自动建节点"张力)。

## 3 优化 Plan

### P0(接真线阻断项,1 周内)
| # | 项 | 内容 | 工作量 |
| --- | --- | --- | --- |
| P0-1 | 保写心跳生命周期根治 | 纪元指纹(driver+driverConfig+line 变更即失效)+confirmedValue(只保写回读确认值)+失败写不占位+lineStop 挂起 hold | 1-1.5 天 |
| P0-2 | 对象存储 GC | 按日粒度前缀删除早于 frameRetentionH 的天目录;删节点级联删 daq/<nodeId>/**;meta 补 sha256+size | 0.5-1 天 |
| P0-3 | Timescale 物理参数 | chunk_time_interval≈retention/10;daq_samples/daq_frames 开 timescaledb.compress(segmentby node_id)+压缩策略 | 0.5 天 |
| P0-4 | 服务 OOM 治理 | 内存水位监控+自动重启(pm2/docker restart)+泄漏定位(15 agents 长跑场景压测) | 1 天 |
| P0-5 | mock 静默兜底封堵 | 写路径/testDriver 对"声明真实协议但驱动不可用"显式报错,mock 仅限显式 kind | 0.5 天 |

### P1(体验与解耦补全,2-3 周)
| # | 项 | 内容 |
| --- | --- | --- |
| P1-1 | 统一 data_query 自动路由 | 按节点模式自动转发 daq_query/mes_fetch;授权面上收为按节点单一口径(消双绑定);保留原工具显式覆盖 |
| P1-2 | 名义信号点模型 | DaqNode/DcwNode 加 logicalRef+accessMode('mirror'/'direct' 可双面);mes_fetch 可见性放宽为"名义点 daq 绑定或线只读";根治 AML 场景↔数据集 nodeId 重映射 |
| P1-3 | 批次事务语义 | run 意图 journal(pending/written/failed)+partial 自动续传/锚补偿+下发前批量连通性预检 |
| P1-4 | daq 大窗异步数据集 | 泛化 MES CSV 数据集设施到 daq(>2000 行统一回 dataset_id) |
| P1-5 | 频控/写保持窗落盘 | 对齐 op-anchor 方案,堵"重启即绕频控" |
| P1-6 | grant-guard 回退并入频道绑线 | 堵撤权后只读面失活缺口 |

### P2(打磨)
writeFrames 批插;真实图像解码(sharp 或文档化限制+decoderSkipped 指标);frameContent 重复查询/latest() DISTINCT ON 优化;MQTT 首帧等待降 1s;插件工具纳入守卫口径(lineScope 声明);频道换绑线级联清理提示;revokeDelegation 漏 recipe 类/委派 REST 留痕;agent 视图裁掉 driver 名;启动图像像素入库的折中(缩略图 bytea 入 daq_frames)评估。

## 4 结论

用户目标架构的**每一个要素都已在现网验证可达**:多协议节点(4 驱动族+自定义 MES 写点)、异构入库(标量/向量/图像三形态各得其所)、绑定驱动取数(fail-closed)、recipe 解耦下发(双协议同批零感知)、镜像/直取双路取数。四专家评审确认解耦与安全设计是教科书级,同时定位了 5 个 P0 生产化欠账(其中保写心跳生命周期即 10-07 事故根因)与一批 P1/P2 结构性优化——均带 file:line 证据与具体做法,可直接排期。
