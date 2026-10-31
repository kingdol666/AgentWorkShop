# 产线接入 skill 全流程实测开发文档(onboarding-e2e-20261028)

> 日期:2026-10-28 · 执行:AgentWorkShop v0.8.6 · 结论:**两轮全绿(一键 7 阶段全过,EXIT=0)**
> 覆盖 skill:`aw-line-onboarding`(主流程)+ `aw-plc-sim-twin`(模拟 PLC 接口)· 平台实机:隔离实例 :3105

---

## 1. 目的

验证从**用户上传的接口协议文档 + 工况说明**出发,系统能否自动完成:

1. 模拟 PLC 接口创建(仿真孪生设备,SV 可写/PV 带因果动力学);
2. 节点创建与连接(写控 DCW + 数采 DAQ,量程/步限/采样节拍落库);
3. Channel 创建并绑定对应节点(配方 manual + 数采 auto,插件/种子任务齐备);
4. 测试模拟环境全流程跑通(连通预检 → 供给 → 锻造 → V1-V6 验收 → 冒烟闭环自动 HITL)。

达标即具备「新产线文档 → 可作业频道」的快速上线能力;真机割接只需按 §8 替换端点。

## 2. 结论速览

| 轮次 | 阶段1 预检 | 阶段2 供给 | 阶段3 锻造 | 阶段4 V1-V6 | 阶段5 冒烟 | 退出码 |
| --- | --- | --- | --- | --- | --- | --- |
| 首轮 | 6/6 | 11/11 | 7/7 | 17/17 | 设备证实 `rr-5b48c142` | 0 |
| 回归轮(优化后,幂等复用) | 6/6 | 17/17 | 7/7 | 17/17 | 设备证实 `rr-e34a383b` | 0 |

落袋 id(首轮):线 `ln-f1870b2c` · 配方 `rc-c4ccb815` · 频道 `43aa5433-c75e-4fc1-bd88-f2369bd56ca9`
节点:涂布间隙SP `dw-92df8392` · 烘干温度SP `dw-3c4ef389` · 走带速度SP `dw-da78b15b` ·
涂布厚度PV `dn-82c72aeb` · 烘干温度PV `dn-07d3c97e` · 张力PV `dn-3ad0e65a` · 首批次 `rr-0cb6dc97`

**物理实证**:两轮冒烟+验收写入后(间隙 180→190 μm、温度 110→118℃、速度 20→22 m/min),
厚度 PV 按文档因果(间隙增益 0.9/温度 0.2)从 ~95 μm 跟随升至 ~103 μm —— 模拟 PLC 接口的
「写入生效→物理跟随→数采落库→治理链」四层全部真实闭环,非 mock。

## 3. 环境与隔离铁律(本轮最大坑)

```bash
# 隔离实例启动(repo 检出目录内必须 AW_MODE=home,否则 AW_HOME 被静默忽略、挂到共享 .AgentWorkShop 库)
AW_MODE=home AW_HOME='D:\codes\ABO\aw-onboard-test-home-20261028' PORT=3105 \
  NUXT_SESSION_PASSWORD='onboard-e2e-20261028-session-pw-0123456789ab' \
  AW_MCP_ENABLED=true AW_TRIAL_INTERVAL_MS=0 \
  node .output/server/index.mjs
```

- **识别误挂共享库**:`/api/users/setup-status` 返回 `needsSetup:false`、`/api/health` 的
  `activeChannels>0` —— 正确的 fresh 实例应 `needsSetup:true`。
- fresh 实例先注册首账号(首注册即 admin;脚本缺省凭据 `admin@awshop.local`/`admin123` 依赖此步):
  `POST /api/users/register {"name":"Onboard Admin","email":"admin@awshop.local","password":"admin123"}`(只注册一次)。
- 模拟 PLC 孪生:影子树 `../plc-node-simulator-twin-4034`(sim-twin 自动拉起),设备 Modbus TCP `127.0.0.1:41501`。
- 端口纪律:3105=测试实例、4034=影子模拟器、41501=孪生设备;全程 `NO_PROXY=127.0.0.1,localhost`。

## 4. 输入工件(本目录)

| 文件 | 角色 | 说明 |
| --- | --- | --- |
| `01-接口协议文档-涂布线Modbus寄存器表.md` | **用户上传物①** | 6 点位寄存器表(3 SP 写控 + 3 PV 数采)、量程/步限/报警线/工艺因果/安全红线 |
| `02-工况说明文档.md` | **用户上传物②** | 工序背景、目标窗(厚度 100±4 μm)、作业目标(闭环优化)、治理要求(HITL/插件) |
| `03-blueprint.json` | 提炼产物(助手生成) | 阶段 1 点位提取结果:信号 id/量程/SP-PV 判定/因果动力学(增益取自文档 §4) |
| `04-onboard-config.json` | 生成物 | 统一配置:driverConfig 全部取模拟器 export(永不手抄),语义面取两份文档 |
| `sim-export.json` | 模拟器导出 | 每信号 driver+driverConfig(寄存器/字节序/类型),onboard 配置的唯一协议来源 |
| `onboard-run.log` / `onboard-rerun.log` | **实测证据** | 首轮/回归轮全量断言输出 |
| `05-复现手册.md` | 操作手册 | 逐步命令,可整段复制执行 |

分工铁律(skill 原文):助手负责读文档、生成 driverConfig、选场景;逐点操作走工业工具/脚本,
批量供给与验收走 `scripts/onboarding/` 脚本 —— **脚本只认配置 JSON,永不理解文档**。

## 5. 实测断言明细(首轮)

**阶段 1 连通性预检 6/6**:6 点位逐点真实 Modbus 读通(厚度 40007=95.1、温度 40009=108.1、张力 40011=37.4,延迟 11~14 ms)。

**阶段 2 产线供给 11/11**:建线(指纹标签幂等)→ 3 DCW 写控(带量程/stepLimit/holdIntervalMs/templateRef)→ 3 DAQ 数采(templateRef 必填;间隔 2 s)→ 产品+配方(3 参数带窗口)→ 开跑批次。摘要 `{lineId,dcw,daq,recipeId}` 落袋。

**阶段 3 频道锻造 7/7**:模板 `chtpl-generic-optimize-default` 实例化(4 Agent:主管+分析师+知识调优+工艺工程师)→ 插件开关(idd-closedloop-bridge + rag-bridge 启用,未配置项显式停用)→ 绑定矩阵:

| Agent | 绑定 | 模式 |
| --- | --- | --- |
| worker:2 工艺工程师 | recipe `rc-c4ccb815`(整配方) | **manual**(首绑铁律) |
| worker:0 数据分析师 | daq ×3(厚度/温度/张力) | auto(只读) |

→ 种子任务派发(sentinel_baseline → optimizer_campaign → 循环逼近,预算 60 min)。

**阶段 4 V1-V6 验收 17/17**:V1 三节点 2 min 窗内真实样本;V2 三节点越界写全部 400 拒(量程联锁);V3 三节点合法写回读一致(写探针实时取值,自动避 60 s 写间隔);V4 配方参数逐项一致;V5 绑线/成员/插件生效+未配置插件隔离;V6 受保护演示线 `ln-d7e0a2a2` 零扰动。

**阶段 5 冒烟闭环**:持配方 Agent `recipe_propose` → HITL 卡自动裁决(测试语义)→ 整批下发 → **设备证实 1/1**(温度 112→114℃)。治理链四层限界全程在线。

## 6. 本轮实测发现与已合入优化

| # | 发现 | 处置 | 改动文件 |
| --- | --- | --- | --- |
| 1 | **fresh 实例不开采集总控则 DAQ 不采样**(全局 running 门),V1 必空转 120 s×N 后全红;onboard 原流程无此步 | `provision-line.mjs` 末步自动 `POST /api/workshop/daq/controller {"action":"start"}`(幂等;S10 基础设施降级如实报红);回归轮供给断言 11→17 含新步 | `scripts/onboarding/provision-line.mjs` |
| 2 | **repo 检出目录内启动实例,缺 `AW_MODE=home` 时 `AW_HOME` 被静默忽略**(repo 模式优先,挂到共享 `.AgentWorkShop` 库;`shared/config/home.mjs:77` 判定) | 三份 SKILL.md 写入正确启动命令与识别特征(needsSetup/activeChannels) | `skills/` 与 `.agents/skills/` 双副本:`aw-line-onboarding`(前置条件+验收清单)、`aw-system-acceptance`(环境纪律) |
| 3 | **模拟器寄存器映射与文档寄存器址不同**(孪生按信号序自动分配 `40001+i×2` 保持寄存器,SP/PV 同区;文档 4xxxx/3xxxx 分区不进孪生) | 属预期边界,非缺陷;`aw-plc-sim-twin` SKILL.md 写明:driverConfig 一律取 export,割接时以真实寄存器表逐点 PATCH | 同上(双副本已同步) |
| 4 | fresh 实例首账号须先注册,脚本缺省凭据才能登录 | 开发文档 §3 固化命令;skill 已注明「测试实例可注册测试 admin,生产实例引导用户 /setup」 | 文档层 |

回归证据:优化合入后重跑一键全流程,**幂等复用**同线/同配方/同频道(指纹命中,配置权威对齐零漂移),V1-V6 与冒烟再全绿(`onboard-rerun.log`);skill 规范校验 `node scripts/test-aw-skills.mjs` 124 PASS / 0 FAIL。

## 7. 坑速查(本轮实战验证)

- **DAQ 总控**:fresh 实例必须 start(现在供给脚本已自动);若报 `DAQ_INFRA_DEGRADED` 是 S10 启动屏障,先修后端再开采,不要绕。
- **AW_MODE=home**:见 §3;`needsSetup:false` + `activeChannels>0` = 误挂共享库,立即停。
- **DAQ 节点 templateRef 必填**(信号模板是单位/语义唯一来源):SP 用 `dcw-temp-sp/pressure-sp/speed-sp/tension-sp`,PV 用 `daq-temp-tc/tension-cell` 等;模板只定语义显示,量程以节点配置为准。
- **driverConfig 永不手抄**:一律 `GET :4034/api/nodes/:id/export` 取 `items[].driverConfig`。
- **冒烟/验收的写会撞 60 s 写间隔与配方窗**:脚本已内置在飞单识别、窗口钳位、间隔重试;手工复现时别在同一分钟连续写同一 SP。
- **HITL 测试语义**:冒烟步自动裁决仅限测试;投用必须产线负责人界面 judge & taste。

## 8. 快速上线指引(测试环境 → 真实产线)

模拟环境跑通后,**割接只换 driverConfig 端点,治理面零改动**(skill 阶段 7 六步,禁止跳步):

1. 真实 driverConfig 重跑连通预检(`04-onboard-config.json` 的 `connectivity.tests` 替换为真实 host/port/寄存器);
2. 只读浸泡 ≥30 min(只接 PV,核对量程/噪声/漂移);
3. 单点最小步写入首验(「写控|设备|镜像回读」三方一致 —— 寄存器映射/字节序错误只在真机暴露);
4. 其余节点 PATCH driverConfig(secretRef 打码坑:显式给真值或不动该字段);
5. `verify-line` V1-V6 重跑全绿;
6. 交付割接清单;**投用由产线负责人在界面批准首批真实提案**。

本目录工件直接复用:换线名+新文档 → 重做 03/04(蓝图/统一配置)→ 同一套命令。

## 9. 未覆盖面声明(如实)

- 驱动面本轮覆盖 **modbus-tcp**(本轮线协议);mqtt/opcua/modbus-rtu/mes-rest 由 skill 同一脚本族支持,历史套件已验(mqtt 全链 2026-10-28、退火线 mes 2026-10-10),本轮未重复。
- 种子任务已派发但未等待 Agent 真实跑完 optimizer_campaign(闭环优化轮次属 aw-opt-channel 深潜面);冒烟已证明「提案→审批→下发→设备证实」治理链真实可用。
- 割接六步未执行(无真实设备),§8 为手册性指引。

## 10. 工件与运行态

- 本目录 8 个文件即全部输入/输出/证据(含 `evidence-*.log` 三份重放证据);skill 改动见 `skills/`(基准)与 `.agents/skills/`(发现)双副本,`scripts/onboarding/provision-line.mjs` 为脚本实体。
- 测试运行态(会话结束后自行消亡,可随时按 §3 重拉):平台 `http://127.0.0.1:3105`(频道「涂布闭环优化频道」)、模拟器 `:4034`、孪生设备 `:41501`。

## 11. 长稳事件记录(2026-10-29,如实)

夜间测试实例发生一次崩溃+恢复,全程留痕:

1. **触发链**:频道种子任务被 Agent **真实开始执行**(工艺工程师/数据分析师实例发起真实 LLM 回合)→ 测试 key 预算耗尽(100/100,`OMP_LLM_422 budget_exceeded` 持续重试)→ 其后孪生模拟器进程退出 → 平台 DCW 保写心跳打到半开 Modbus 连接,`modbus-serial` 抛 `ERR_STREAM_WRITE_AFTER_END`,stability-guard 记录(累计 1 不退出)但进程最终 exit 1。
2. **两个待加固发现(2026-10-30 已修复,见 §12)**:
   - DCW Modbus 写路径对已 end 的 socket 无容错,半开连接可致进程退出(历史坑同类:Modbus 半开拖垮事件循环);
   - LLM 预算耗尽后 harness 回合失败不落终态、持续 422 重试,种子任务长期挂运行态(与既有「失败回合不落终态」记录同源)。
3. **恢复与韧性证据**:重启实例(同一 AW_HOME)→ **全部状态持久化**:配方在册、SP 值保持崩溃前最后写入值(195/120/23)、绑定/插件/频道完好;重放 V1-V6 **17/17 全绿**(`evidence-verify-after-restart.log`)——「虚拟预演环境可销毁可重建、治理状态落库不丢」本身即割接安全性的直接证据。
4. 附带实证:种子任务派发后 Agent 确实自发开工(真实 LLM 消耗至预算墙),「优化作业」不是摆设;真机投用前须为频道配足预算或本机模型。

## 12. 两个工程缺陷修复实录(2026-10-30)

**缺陷1(DCW Modbus 半开 socket 崩溃)**
- 修复面:①连接池层 socket `error` 事件吸收 + write-after-end 拦截(已终结即丢弃写入,由 3s 超时兜底作废重连,与既有首连去重同批落地);②4 处裸 `void conn.client.close()` 改走 `closeModbusSafely`(消除残留 unhandled rejection 源)。
- 回归:`scripts/e2e-dcw-halfopen-resilience.mjs` 10/10 —— 真杀设备进程后,3 发"首次写"穿透治理闸打到驱动层,全部 `ok=false/ack=unverified` fail-closed,平台 uptime 连续增长不重启;设备重启后写回环自动恢复(readback 一致)。
- 注意:该回归对治理闸零豁免,节点 stepLimit 须放大(本脚本 200)且用"各节点首次写"避开 60s 写间隔闸,才能让写真正到达 socket 层。

**缺陷2(LLM 预算耗尽任务假活)**
- 修复面:`agent-runtime/harness-failure.ts` 纯函数(分类 budget/auth/model/network/other → 连败串同类累加/异类重置 → 终态类达 3 次且在 5min 冷却窗内即熔断);`message.ts` 回合落定处接线:熔断生效时当前 WORKING 任务按 `HARNESS_UNAVAILABLE_<CLASS>` 收口(原因入 history)+ 跳过重投;成功回合整串复位;冷却后半开放行探测,探测失败立即重新熔断。network 等可重试类别不参与熔断。
- 回归:`tests/harness-failure-breaker.test.ts` 5 条(分类映射/连败串/阈值边界/冷却半开/异类重置)。
- 门禁:单测全量 855/0、typecheck 通过、定向 eslint 0 error、V1-V6 重放 17/17。
