# 代码架构与文档一致性审计报告(arch-doc-audit)

**时间**:2026-11-01 · 基线 commit da627d21 · 方法:源码走查(runtime/daq/dcw/manager 全链)+ README/文档站真值核对 + 运行时 API 对照 + 仓库卫生扫描

---

## 0. 一句话结论

**架构设计成熟且思路自洽:组合根+mixin 分层的 Channel 管理、节点级独立运行时的 DAQ/DCW、generation+lease 的任务栅栏、四类实例化对象各自独立管理且经 Manager 门面集成控制——生命周期机制是这套代码最扎实的部分。README/文档与项目真实情况基本一致(核心数字全部对得上),发现 1 处双语不一致(en changelog 缺 v0.8.7/v0.8.8)与 1 处口径需加注(设置项 138 vs 运行时 144)。**

## 1. 代码架构与设计思路(A1)

### 1.1 分层总图(源码实证)

```
app(Nuxt4 前端) / server(API+服务) / shared(前后端契约) —— 三层配置驱动
server/services/workshop/
├── runtime/                    ← 作业面(Who 执行)
│   ├── manager/               AgentChannelManager:14 层 mixin 组合链
│   │   facade.ts = class AgentChannelManager extends ManagerInternal {}
│   │   Internal→Schedules→HostTools→A2A→Tasks→ChannelTemplates→Teams
│   │   →LeadTeam→RuntimeWiring→Bus→State→Contracts→RuntimeObserve
│   │   →Workspace→Access→Chat→ChatReply→Notifications→AdminChannel
│   │   →AdminAgents(组合根;每层一个职责文件,公开 API 拆分前原样保留)
│   ├── scheduler-loop/        调度循环(tick/execute/rules/state;预算+HITL 分流+D1)
│   ├── task-engine/           任务状态机(create/transition/lease/policy/lifecycle)
│   ├── agent-runtime/         Agent 生命周期(lifecycle.stop 审批收敛为拒/宽限竞态/dispose)
│   └── channel-runtime.ts     频道运行时(addAgent/removeAgent/map 管理)
├── daq/ + dcw/                 ← 数据面(What 读写)
│   ├── daq-controller/        节点级独立运行时注册表(id→独立运行时;网关统一管理生命周期)
│   │   state.ts「网关统一调度:250ms 扫描,到期判定与互斥由各运行时私有节拍」
│   │   crud.ts remove() 四步级联:repo 删→运行时注销→对象存储像素 GC→告警态清理→绑定级联
│   ├── dcw-controller/        同构(actuation/write-verify/lines/recipes;级联清理同款)
├── agents/ / aml/ / ontology/ / optimization/ / process-model/  ← 智能面
├── ops/ / analysis/ / eda/ / mes/ / exp/                        ← 业务面
```

### 1.2 生命周期管理机制(逐对象,源码锚点)

| 实例化对象 | 创建 | 运行 | 重配 | 卸载 | 评级 |
| --- | --- | --- | --- | --- | --- |
| **AgentRuntime**(omp 子进程) | Harness 重建(SERVER_RESTART/PROCESS_EXIT 各有 lease) | reconcileProcess 存活校准 | llm/执行模式变更→运行时回收重组 | stop():挂起审批**收敛为拒**→10s 宽限竞态→dispose 容错 | A−(R-1:dispose 阻塞事件循环) |
| **TaskEngine 状态机** | create | generation+lease 双栅栏(旧 worker 迟到事件一律丢弃;lease.ts 设计文档 §5 逐条对应) | reassign 撤旧 lease+task-local abort | timeoutTree 整树收口 | A |
| **DAQ 节点运行时** | provision 注册 | 250ms 网关统一扫描+私有节拍(防表尾饿死) | PATCH→rearm 即刻生效 | remove() **四步级联**(存储 GC/告警态/绑定) | A−(R-2 推送退避) |
| **DCW 节点运行时** | 同构 | 保写心跳+四层限界 | 元数据即生效 | 级联清理+挂起审批失效收敛 | A |
| **Channel/Workspace** | 模板 instantiate | 3 活跃频道共证 | owner-only PATCH+乐观锁 | 移除解绑 | B+(workspace 挂载解耦) |
| **插件宿主** | 装载(11 个 builtin+project) | 15s 轮询器热重载 | plugins-state 触碰即重载 | 卸载容错 | A(装载竞态已治) |

**单独管理 vs 集成控制(用户问题核心)**——机制存在且分层清晰:
1. **单独管理**:每类对象有自己的 repo/controller/registry(daq-node.repo、dcw-node.repo、channel.repo、tool-registry.repo)+各自控制器(daq-controller、dcw-controller、AgentChannelManager 各 mixin 文件);节点级运行时私有节拍互不波及。
2. **集成控制**:Manager 门面(组合根)统一编排——runtime-wiring 装配调度循环+空闲清扫器+D1;host-tools 统一工具面治理(入库守卫/引用面/审计双源);bindings+grant/verify 统一授权;notify 统一回执(claim 认领防重);ops/audit 统一留痕。DAQ/DCW 写路径最终都经 `write()` 单点(在飞互斥+限界+台账)。
3. **跨域一致性设计**:同一改动三点同步(channel 绑定 kind 三处/插件声明面双副本/场景事件广播),配有 docs:check 校验文档与代码基线一致。

### 1.3 设计思路亮点
- **组合优于继承的工程化落地**:14 层 mixin 链每层职责单一、可独立测试(unit 913 覆盖)
- **以实测缺陷为养料**:注释带日期事故来历(排队根饿死 2026-10-05/悬空审批单/暂停期 MQTT 漏采),lease 设计文档 §5 与代码一一对应
- **配置驱动**:三协议同构(controller/template/driver 注册表),新增协议=注册表登记
- **双语与契约**:i18n parity 校验、shared/ 前后端契约、schema.json 基线

## 2. README/文档 vs 真实情况(A2)

| 声明 | 文档值 | 实测值 | 判定 |
| --- | --- | --- | --- |
| 版本 | v0.8.8(package.json/README/changelog 一致) | 运行时 0.8.8 | ✅ |
| 宿主工具 | 105(host)+21(plugin) | **builtin=105, plugin=21, total=126** | ✅ 完全一致 |
| 执行引擎 | 14 | registry.ts 恰 **14** 个 id(mock/omp/opencode/codex/dsh/claude/gemini/copilot/cursor/crush/goose/qwen/pi/hermes) | ✅ |
| 运行时设置 | 138 项/19 组(docs:check schema.json 基准,EN 亦已改 138) | 运行时 descriptors **144 项/27 组** | ⚠️ 口径差:schema 基准 138=核心内置;运行时多出 6 项=插件 ctx.config.defineField 动态注册(如 diag-bridge auto_rules)。**建议 README 加注"(不含插件动态注册项)"** |
| 双语 parity | i18n 3173/3173 | docs:check/i18n:check 全绿 | ✅ |
| 五层验收/冻结基线叙述 | changelog v0.8.8 | 本 session 复测吻合(913 单测/44 e2e-line/105 optimizer) | ✅ |
| **en changelog 缺 v0.8.7/v0.8.8** | zh 有 0.8.5→0.8.8 全链;en 只到 **v0.8.6** | — | ❌ **双语不一致,需补译两条** |
| 历史数字(104 tools 等) | docs 站内多为带日期历史陈述 | — | ✅ 按惯例不改 |

## 3. 仓库完整性与卫生(A3)

- **结构**:app/server/shared/skills/plugins-builtin/bench/docs/scripts/paper 分层清晰;139 个测试文件、625 个证据文件入库、审计证据目录 86 个(81 已跟踪)
- **门禁现状**:lint 0 / typecheck ✓ / docs:check 89-0 / readme:lint / i18n parity 全绿(上轮 fresh;本轮工作树含并行会话在途改动未复跑全量)
- **卫生**:
  - `.AgentWorkShop/` 混合状态:113 个历史验收工件被跟踪(有意)+ data/*.sqlite 被正确 ignore + 影子插件副本 2 文件有修改(本 session 的同步编辑,合规但**建议让影子副本整体 ignore 或与 builtin 建立构建期同步**,消除双副本漂移风险)
  - 证据 JSON 抽查无真实 token 泄漏(铸币链描述只写"idd_ 前缀/sk- 前缀")
  - `aw_task.json`(根目录未跟踪)= 并行会话临时文件,建议清走
  - 并行会话在途改动(bench/PIPELINE 批准消融+paper tii)仍在工作树,未纳入本审计
- **发现汇总**:①en changelog 补 v0.8.7/v0.8.8(P2 文档)②README 设置项口径加注(P3)③影子插件副本同步机制(P3 工程)④aw_task.json 清理(P4)

## 4. 总评

**代码架构:设计思路清晰、生命周期机制完备、单独管理与集成控制双层结构真实存在且运转良好——这套代码的工程纪律(注释带事故来历/fail-closed 缺省/组合根分层/契约校验)在同类项目中属上乘。** 文档与真实情况一致性高(核心数字全对上),仅一处双语滞后与一处口径需加注。仓库卫生良好,证据链完整可追溯。**综合:设计架构 A−,文档一致性 A−,仓库卫生 A。**
