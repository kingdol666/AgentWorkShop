# AgentWorkShop 系统全功能测试 SKILL

> **用途**:读取本文件即可对 AgentWorkShop 执行一套完整的、生产环境真实作业级的功能测试。
> 适用版本:v0.7.57+(含 2026-10-05 加固批次)。测试脚本资产:`scripts/testing/`(常驻)与 `tmp-e2e/`(实验迭代)。
> **增补**:docs/testing/SKILL-GAP-ADDENDUM.md(L9 加固特性回归 / L10 前后端交互核查 / 全表面矩阵)—— 与本文件同读。
> 铁律:**测试零系统代码改动**;只允许新增测试脚本与测试数据(频道/任务/绑定用后可留痕)。

---

## 0. 环境准备(全部就绪才可开测)

```bash
# ① 生产服务(repo 根,生产模式,勿用 dev 长跑)
AW_RATE_LIMIT_OFF=1 PORT=3001 nohup node scripts/start.mjs > .e2e-matrix/prod-3001.out.log 2>&1 &
# ② PLC 多协议模拟器(五协议 + castfilm 物理引擎)
node scripts/_plc-sim-detached.cjs          # :4010,Modbus :16040/:15041,OPC UA :5840,MQTT :18830
# ③ MES REST 模拟器
nohup node scripts/dev-mes-simulator.mjs --port 15060 > .e2e-matrix/mes-r2.out.log 2>&1 &
```

健康基线(三绿才继续):
- `GET :3001/api/health` → `status:ok`(version 与 package.json 一致)
- `GET :4010/api/plant/state` → 200(running:true)
- `GET :15060/health` → ok
- `GET :3001/api/workshop/daq` → controller.running=true,nodesOnline=12/12

管理员登录:`POST /api/users/login {email:'visual@awshop.local',password:'Visual2026'}` → token 存 `tmp-e2e/admin.tok`。
**已知陷阱**:本机回环需 `NO_PROXY=127.0.0.1,localhost`;开测前 `powershell` 查杀 `dev-guard.mjs`/`aw.mjs dev` **孤儿 dev 进程**(与 prod 共写数据目录,会抹数据——单实例锁心跳已防,仍需清场);git bash 内联 JSON 会有引号吞噬 → 一律写成 .mjs 脚本文件执行。

---

## 1. 分层测试流程(每层全绿才进下一层)

### L1 · API 全表面循环(`node scripts/testing/api-full-loop.mjs`)
44 断言:auth 正负向 / users 生命周期 / channels CRUD / tasks **非终态判重** / messages / **权限隔离负向**(无 grant 用户 0 绑线频道可见、禁用户管理、禁建节点)/ dcw(线态、**运行门 409**、写历史、批次台账)/ daq(真实时序、告警、infra、**404 语义**)/ agent-tools(my_industrial_nodes 正向、**dcw_control 禁用负向**、未知工具)/ hitl / ops / audit / memory(**agent 作用域读取 + 语义检索命中**)/ plugins / teams / notifications / 测试数据清理。
**验收:44/44。任何 ❌ 先判"测试脚本形状"vs"系统缺陷",系统缺陷必须修复后重跑。**

### L2 · SDK 行为级(`node scripts/testing/sdk-live.mjs`)
HookBus(异步串行/错误隔离/\*/once+退订)+ createPlatformClient(登录→setToken→health/lines/daq/recipes)+ createClientContext。**验收:12/12。**
辅助:`node scripts/test-sdk-surface.mjs`(出口面)与 `node bin/aw.mjs doctor`(15 指令;3001"被占用"= 本服务在跑,语义正确)。

### L3 · 插件开发闭环
1. 官方:`node scripts/test-plugin-lifecycle.mjs` → **22/22**。
2. 动手:写一个四件套测试插件(driver+processor+template+omp 工具,参考 `.AgentWorkShop/plugins/daq-sink-verify/index.mjs` 的真实契约:`{name,version,description,setup(ctx)}`;`ctx.daq.registerDriver/registerProcessor(frameKind,id,fn)/registerTemplate`,`ctx.omp.registerTool({name,label,description,parameters,handler})`)到 `.AgentWorkShop/plugins/<name>/` → 重启 → 断言:①/plugins 清单含它;②omp 工具经 `/api/workshop/agent-tools/invoke` 回显;③插件驱动建节点(须挂**运行中产线**,门控如此)→ 帧入库且带 line/product/recipe/run 四标注;④目录(`/api/workshop/daq` drivers)含插件驱动;⑤移除后恢复。
   **验收:五断言全过。覆盖内置驱动须 meta.replaces 显式声明,未声明注册必须被拒。**

### L4 · Agent 工业闭环(核心层)
用真实 omp harness(**mock harness 无工具桥,不能用于工具测试**):
1. 场景搭建(参考 `tmp-e2e/scenario-setup2.mjs`):绑线频道(lead+worker,模板 7e3f5be2/00f3c815)→ admin 绑 lead(daq kind=daq + recipe kind=recipe **manual**)→ lead 委托 worker(bindings/grant)→ 开线。
2. 启动 HITL 人工代理(`node scripts/testing/hitl-expert.mjs <channelId> <A|B>`,方向/证据规则见脚本;日志 `expert-<X>.log`)与 AEP 实时捕获(`aep-live.mjs`,AW_TOKEN/AW_CHANNEL/AW_OUT)。
3. 下发 GOAL 任务(含:观察≥2 窗再提案 / 每参数必带 basis+exp_ref / manual 等批 / 4min 惯性复测 / 达标 complete 交付对照表 / 禁 dcw_judge)。
4. **断言清单**:①提案审批卡每参数带 basis(数值+时间窗)+exp_ref;②拒绝→吸收→重提(证据补齐/方向纠正/步幅规程均各验一次);③批准后 dcw.write.recipe 落账且 **PLC 读回=设定值**;④治理联锁真实拦截(300s 节拍/步幅/量程任一实证);⑤**运行门**:对未运行配方提案必须被拒且 Agent 不越权;⑥lead 独立复核后才收口;⑦达标判定引用实测数值。
5. 数据深度:daq_export(CSV 落 `.AgentWorkShop/data/daq-exports/`)→ 脚本分段统计(mean/std/n/min/max)与 Agent 结论比对。
6. 产线管理:line_status → line_stop(**恒 HITL**)→ 60s → line_start(**恒 HITL**)→ 新批次+数采窗口重激活;停线期间数采必须停止。

### L5 · 协同与游戏(人机通信)
- **猜数字**(HITL 问答流):秘密数 + `game-host.mjs`(自动答 大了/小了/正确)→ 断言二分 ≤7 猜命中、omp-dialog 往返闭环。
- **海龟汤**:是非题 ≥6 轮 + 汤底交付 COMPLETED。
- 三模式:goal(criteria 达标)/loop(intervalMs+maxIterations 跑满 N 轮)/pipeline( stages 依序,末阶段复核)。
- 群聊:普通任务(禁工业工具)交付质量抽检 —— 必须引用真实历史数据,禁止编造。

### L6 · AML 孪生寻优
hybrid_twin 频道(模板 chtpl-hybrid-twin-mpc-default 实例化)注入 16 孪生工具;路径:discover(**配方绑定控制量已展开**,controls≥1)→ compile(无 SCENE_NO_CONTROLS)→ freeze(USER_CONFIRMED_SCENE_CONTRACT+expected_hash)→ snapshot(auto_daq+服务端 controls)→ **mpc_optimize 出 recommendation** → bayes(需绑定门禁模型,无模型先 optimization_explore)。castfilm provider(castfilm-greybox-v1)可对拍 /api/plant/optimum 的 W*。

### L7 · 稳定性循环
10 轮 × 15s:health ok、DAQ produced 单调不减、异常=0。另验:重启后产线批次自动恢复(line-runs 注册表 + runs 行双侧 OPEN)、模拟器崩溃场景下 Agent 走"取证→冻结→HITL 升级"而非误动作。

### L8 · UI 实机(browser-use)
登录(cookie 注入 token)→ 仪表盘数字非零 → 产线运营统一流水(写控/配方/系统事件同屏,可截到「提案→批准→下发」三连)→ 运行时监控 HITL 面 → Agent 工作台频道时间线。截图存 artifacts。

---

## 2. 判定与报告格式
- 每层给 pass/fail 计数 + 证据(审批单 id/任务 id/批次号/曲线数据文件)。
- 缺陷三问:是否可复现?根因 file:line?是否修复+回归?
- 报告落 `docs/audit/<date>-<主题>-report.md`,附提交号。

## 3. 历史陷阱速查(测试前必读)
| 陷阱 | 处置 |
|---|---|
| GBK 乱码(U+FFFD) | 一律 .mjs 脚本文件,不内联中文 JSON |
| 孤儿 dev 进程共写数据 | 开测清场;锁心跳已防,勿并存双实例 |
| 模拟器进程周期退出(本机) | 重启即自愈;观察 Agent 走断流预案 |
| mock harness 无工具桥 | 工具测试必须 omp 真实 harness |
| 排队根预算 | 已修(未入场根不判死);验证法=重开根跨过期 deadline 存活 |
| recipe_trial/apply 整批语义 | 已修为覆盖集(overrides 只写声明节点) |
| 300s 试验节拍窗 | 被拦=正确,等放行重提 |
| MES 写点权限 | 只写无 readMap 时 mes_fetch 会被拒 —— 如实上报非缺陷 |
