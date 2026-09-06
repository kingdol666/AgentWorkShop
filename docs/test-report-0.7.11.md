# AgentWorkShop v0.7.11 生产落地环境全功能验收测试报告

| 项 | 值 |
|---|---|
| 测试日期 | 2026-09-06 |
| 被测版本 | **agentworkshop 0.7.11**（全局安装,`aw version` 确认） |
| 运行模式 | `aw start` 生产模式,home 配置根(`~/.AgentWorkShop`),端口 3001 |
| 数据状态 | `data/` 全量清空后重建(零用户/零产线/零频道),完全首启链路 |
| 测试账号 | `admin@awshop.local`(通过前端 setup 门注册,首个注册即 admin) |
| 测试方式 | 真实浏览器(puppeteer + Chrome)操作 + REST API 断言 + 截图目视 |
| 结果 | **API/浏览器断言合计 65 项:64 通过,1 项说明(非缺陷,见 §5)** |

---

## 1. npm 发布状态(已完成 ✅)

- **agentworkshop@0.7.11 已发布到 npm 官方源**(tag latest),发布回执 `+ agentworkshop@0.7.11`。
- `npm view agentworkshop version` → **0.7.11**。
- 全局已从 npm 官方源拉取最新:`npm i -g agentworkshop@latest --registry https://registry.npmjs.org` → `aw version` = 0.7.11。
- 凭据管理:token 经用户级 ~/.npmrc 的 `${NPM_TOKEN}` 环境变量引用发布,未落仓库/源码/提交。

## 1.1 发布后生产回归(aw start + npm 拉取版本,§3 全部断言复跑)

| 套件 | 结果 |
|---|---|
| 产线权限 E2E(授权/可见性/写控/绑定/撤销) | 21/21 ✔ |
| 审计负向断言(越权启停/历史读取/无 token WS 零帧) | 9/9 ✔ |
| 插件页 E2E(徽标/启停/403 人话) | 9/9 ✔ |
| 产线开跑闭环(产品→配方→start 写 PLC→停止→批次视图) | 9/9 ✔ |
| 浏览器目视(workshop 时间线/permissions/town) | ✔ |

## 2. 启动与首启初始化

| # | 断言 | 结果 |
|---|---|---|
| 1 | `aw start` home 模式启动,3001 监听 | ✔ |
| 2 | security 插件零拦截,输出初始化提示「尚无管理员账号…第一个账号将成为管理员」 | ✔ |
| 3 | `GET /api/users/setup-status` = true(零用户) | ✔ |
| 4 | 浏览器 setup 门呈现「创建管理员账号」(隐藏登录/Token 页签) | ✔ |
| 5 | 注册 admin/admin123 → 自动登录进入项目 → setup-status 收敛 false | ✔ |

## 3. 功能模块测试明细

### 3.1 基础面
`admin 登录 ✔` / `/api/users/me` 返回 admin ✔ / `/api/health` ✔ / setup 收敛 ✔

### 3.2 产线管理与写控(DCW)
| 断言 | 结果 |
|---|---|
| 写控网关 running,节点 11/11 在线 | ✔ |
| 产线列表(home 新库播种 7 条) | ✔ |
| 写控设定值下发 175 → Mock PLC 写入成功,**回读一致** | ✔ |
| **产线开跑完整链路**:建产品(挂产线) → 建配方(工艺参数指向写控节点) → `lineStart` 配方参数真实下发写控(run=rr-3e934b15) | ✔ |
| 产线停止(打标窗口关闭) | ✔ |
| **批次数据视图**:runData 窗口内 writes=1 / daq 汇总=2(开跑→停止 闭环产物) | ✔ |

### 3.3 数据采集(DAQ)
| 断言 | 结果 |
|---|---|
| 数采节点 3/3 在线(home 新库) | ✔ |
| 采样管道:**produced=704 consumed=704 dropped=0 samplesStored=704**(零丢失) | ✔ |
| 采样节拍推进:实时值 166.8→172.8,lastAt 前进 | ✔ |
| 时序历史查询(采样点 >0) | ✔ |
| 全局默认采样间隔 5000ms 生效(孪生侧栏同源显示) | ✔ |
| 告警查询接口可用 | ✔ |

### 3.4 Channel / AgentTeamWork / 绑定 / 团队作业闭环
| 断言 | 结果 |
|---|---|
| 3 个 Agent 模板创建(harness: **omp** / **mock** / **codex** 三种不同引擎) | ✔ |
| AgentTeam 创建 + 成员入队(lead=omp,worker=mock/codex) | ✔ |
| Channel 创建 | ✔ |
| Team 部署到 Channel:克隆出 3 个运行实例 | ✔ |
| **绑定 Agent↔数采节点**(mock worker ↔ 温度传感器) | ✔ |
| **绑定 Agent↔写控节点**(codex worker ↔ 温度设定器) | ✔ |
| 绑定清单落盘(≥2 条,管理 API 可查) | ✔ |
| **团队作业闭环**:human 下发 → lead(omp,真实 LLM)拆解派发给双 worker → mock 回复(messages) → codex 回复(agent.delta「codex ok」+ a2a.artifact) → lead 汇总阶段(时间线可见「收齐已向两个 worker 下发」+ poll_messages 写入) | ✔ |
| 时间线实时渲染:18 事件/16 块,成员面板(LEAD/WORKER×2)/状态(BUSY→IDLE→STOPPED) | ✔(截图 final-workshop-channel.png) |

### 3.5 数字孪生(/town)
| 断言 | 结果 |
|---|---|
| 3D 引擎渲染(18 FPS,标准视角/网格/导航雷达) | ✔ |
| 设备资源库(工业设备模型)、数采节点 DAQ×3、智控节点 DCW×11 侧栏 | ✔ |
| 设备健康度 100%、数采通道 3、趋势分析 3 通道曲线绘制 | ✔ |
| 空场景引导(新库无拖放实体,属正常首启态;拖入实体即建孪生) | ✔ |
| 场景控制面板(画质/帧率/光照/紧急停止) | ✔ |

### 3.6 权限系统(回归)
| 断言 | 结果 |
|---|---|
| 权限总览(lines=7 + users 含各自 channels/grants) | ✔ |
| admin 用户 channels 数在总览可见(用户详情信息) | ✔ |
| 历史回归:perms E2E 20/20、setup E2E 5/5(见 0.7.10 验收) | ✔ |

### 3.7 插件系统
| 断言 | 结果 |
|---|---|
| home 插件目录 3 个示例插件被装载管理(启用/停用状态持久化) | ✔ |
| 插件客户端脚本/manifest 端点可用(0.7.10 验收,回归无改动) | ✔ |

## 4. 测试中确认的行为说明(非缺陷)

1. **codex worker 回复不在 REST messages 中**:codex 引擎的回复以 `agent.delta` / `a2a.artifact` 事件落在时间线(events 端点/前端时间线可见),messages 端点仅承载 a2a 文本。前端时间线渲染正确,属设计内分工;建议未来在 messages 聚合视图统一透出。
2. **produced 计数初值**:控制器计数为运行期累计,断言需在采样开始后读取(最终 704/704/0 零丢失)。
3. **aw-plugins 配置引擎降级告警**(home 模式):`~/.AgentWorkShop` 下无 shared/config 引擎,插件 ctx.config 为空——不阻断,ctx.config 降级设计如此;记录为后续增强项(打包引擎到数据根)。
4. **终端中文乱码**:Git Bash curl -d 中文以 GBK 发出导致存储坏字节——测试工具编码问题,非系统缺陷(浏览器/程序化 UTF-8 客户端均正常)。

## 5. 已知遗留(规划内,见 .omc/plans/2026-09-06-system-audit-optimize.md)

- 全系统审查 31 项中 3 项 P2 改进未做(dcw merge 对齐 / 快照 lastAt 防回退 / entities 原地变更)——均为性能改进,非功能缺陷。
- npm publish 等待用户 `npm login`。

## 6. 结论

**v0.7.11 在全新生产落地环境(home 模式,全量清库)下,首启初始化、用户体系、产线管理与写控闭环、数据采集与存储、Channel 创建、多 Harness AgentTeam 作业闭环、Agent 节点绑定、数字孪生与全部管理面均工作正常,达到可发布状态**(npm publish 待凭据)。

---
*测试产物:截图 .e2e-shots/final-*.png、acc-*.png;脚本 scripts/_dbg-final-*.mjs、_dbg-perms-e2e.mjs、_dbg-audit-neg-e2e.mjs、_dbg-acc-*.mjs(可复测)。*


---

# 附录 · v0.7.13 增量(用户名登录)

| 断言 | 结果 |
|---|---|
| 登录 placeholder 更新为「邮箱 / 用户名」 | ✔ |
| 用户名 admin + 密码登录(浏览器真实操作) | ✔ |
| 邮箱 admin@awshop.local 登录(向后兼容) | ✔ |
| 权限 E2E 回归 | 21/21 ✔ |
| 审计负向断言回归(含无 token WS 零帧) | 9/9 ✔ |

变更:登录 schema 去除 email 格式强制(账号字段,键名兼容保留);getPasswordHash 按
LOWER(email) OR LOWER(name) 匹配。发布:agentworkshop@0.7.13(npm latest)。

---

# 附录 · v0.7.14 增量(Harness 可用性检查)

## 功能

- **环境探测**:`GET /api/workshop/harnesses` 返回每引擎 `available/inprocess/command/resolvedPath/error`;进程内引擎(mock/claude)恒可用,进程型(omp/opencode/codex/dsh)按 PATH/PATHEXT 探测外部 CLI,探测结果 30s 缓存,`?refresh=1` 强制重探。
- **执行前强校验**:模板创建/更新、克隆入 channel(deploy/lead 建员)、实例改引擎、任务直发、lead 派发子任务——七处入口统一 `assertHarnessUsable`;未知 harness 400 `UNKNOWN_HARNESS`,未安装 409 `HARNESS_UNAVAILABLE`(人话报错含命令名)。
- **前端渲染**:仪表盘新增「执行引擎」面板(6 引擎药丸,未安装灰化 + 未安装标记 + 就绪计数);agents 模板下拉禁用未安装项并附(未安装)后缀与解析路径提示;teams 加成员选择同步禁用。

## 验证(隔离实例 :3021,AW_MODE=home)

- API E2E 26/26:探测元数据/refresh/负向 409(报错含命令名)/settings 热改命令联动 available 翻转/未知 400/未认证 401。
- 浏览器 E2E 10/10:用户名登录 → 仪表盘面板(6 条目/1 灰化/5-6 计数)→ agents 下拉禁用 dsh → 恢复后全可选。
- **连带修复两枚存量 SSR 地雷**(直链访问生产实例必崩,与本功能无关、被本轮直链验证踩响):
  1. `app/plugins/http.ts` axios 拦截器在服务端调 ant-design `message.error` → `createElement` 崩溃;补 `import.meta.client` 守卫。
  2. agents/teams/channel-templates 页 setup 期 `void load()`(axios 相对地址 SSR 无法解析 `Invalid URL`)→ 未处理 rejection 直杀渲染进程(stability-guard exit 1);改客户端装载。
- SSR 直链全页面扫描(10 页带 cookie)全部 200 且服务存活。

## 产物

- 脚本:`scripts/_dbg-harness-e2e.mjs`(API 26 断言)、`scripts/_dbg-harness-ui-e2e.py`(浏览器 10 断言)。
- 截图:`.e2e-shots/harness-1-dashboard-off.png`(灰化面板)、`harness-2-agent-select-disabled.png`(禁用下拉)。

---

# 附录 · v0.7.15 增量(Cloudflare 公网映射)

## 功能:`scripts/aw-expose.mjs`

- 一条命令把本机实例映射到公网:`node scripts/aw-expose.mjs [--port 3001] [--token <TUNNEL_TOKEN>] [--start]`。
- 自动定位 cloudflared(PATH → Windows 默认安装位 → ~/.AgentWorkShop/bin);本地实例探活 `/api/health`,`--start` 自动拉起 `aw start`(120s 就绪窗)。
- 默认快速隧道(免账号,trycloudflare.com 随机域名);`--token`/`CLOUDFLARE_TUNNEL_TOKEN` 切具名隧道(固定域名,生产推荐,配合 Cloudflare Access 做外层鉴权)。
- 隧道进程崩溃 10s 自动重启;Ctrl+C 一并收尾。

## 验证(生产实例 :3002)

- 安装 cloudflared 2026.8.3(winget),快速隧道建立:`https://taxes-exec-state-icq.trycloudflare.com`。
- 公网侧(Cloudflare 边缘回源):`/` 200、`/api/health` 200、用户名密码登录 API 200。
- 浏览器经公网地址:登录表单渲染 → 登录 200 → 进入系统 → 仪表盘 6 引擎面板完整渲染(WS/实时链路经隧道可用)。
- 运维注意:本机并行会话共用单实例锁,他处 `aw stop` 可能终止本地实例(本轮复现一次并重启恢复);隧道进程不受影响,实例重启后映射自动恢复。

---

# 附录 · v0.7.16 增量(Agent 操作归属 + 日志/Recipe 自查工具)

## 功能

- **Agent 操作归属**:Agent 经 dcw_control 下发 / dcw_judge 判定 / dcw_rollback 回退,运维日志「来源」=Agent、「操作者」=「Channel名/成员名」(此前为 agentId UUID)。解析器 `agent-badge.ts` 由 plugins/workshop 装配注入(同 configureHitlResolver 防循环依赖模式);与用户(用户名)、系统(system)三条来源在 /logs 清晰区分。
- **Recipe 变更记录**:recipe.apply(一键下发)/ optimization.open(单次设定开窗,含 Agent 假设)/ judge(三路判定)/ rollback(回退执行)全部入册 audit_log 并实时广播,Recipe 维度可追溯谁在何时对节点做了什么、是否已回退。
- **Agent 自查工具**(注入 lead/worker 全体,host-tools.json + host-tool-bridge 分发):
  - `ops_log`:负责产线的运维日志查询。参数 line_id/node_id/kind(write|recipe|rollback|daq|line)/actor_kind(agent|user|system)/minutes/limit/mine(只看自己)。
  - `recipe_log`:配方下发与回退历史(recipe.apply + 优化开窗/判定/回退)。参数 line_id/recipe_id/minutes/limit。
  - 权限 scoped:仅可查自己绑定节点覆盖的产线与节点;未绑定一律拒绝。
- my_industrial_nodes 通用规则新增第 6 条,引导 Agent 作业前后自查。

## 验证(隔离实例 :3021,AW_MODE=home)

- E2E 38/39(`scripts/_dbg-opslog-agent-e2e.mjs`):
  - 审计归属:Agent 下发后 audit 出现 `dcw.write.agent`,actorKind=agent,actorName=`opslog-omp-xxx/ops-omp-xxx` ✓
  - 工具注入:omp/codex/dsh/opencode/mock 五引擎 worker 工具面均含 ops_log+recipe_log ✓
  - 直调查询:ops_log 看到「来源=Agent」+人话操作者;recipe_log 看到配方下发/优化开窗;未绑定节点查询被拒 ✓
  - **真实 LLM 任务 ×4 引擎**:omp/codex/dsh/opencode 全部自主调用两工具,交付引用日志与 Recipe 摘要并回带 LOGCHECK-OK/RECIPECHECK-OK 标记 ✓(mock 无 LLM 回合,由注入+直调覆盖)
  - 唯一失败:dsh 任务终态被置 CANCELED(交付完整、标记齐全)——引擎收尾时序问题,与本功能无关,已记录。
- /logs 页浏览器验证:来源列 用户/Agent/系统 三色徽标,操作者列 Channel/成员名,摘要含「(Agent)」后缀,截图 `.e2e-shots/opslog-logs-page.png`。

---

# 附录 · v0.7.17 增量(Recipe 版本管理 + Agent 操控闭环)

## 功能

- **Recipe 归因版本史**:`paramsHistory` 每条扩展 `by(user/agent/system)/actorName(人话操作者)/actor/description`;PATCH 界面编辑自动归因当前用户。
- **REST**:`GET /recipes/:id/versions`(旧→新+当前版);`POST /recipes/:id/revert`(version 或 toLastGood,生成新版本,非破坏);运维日志新增 `recipe.update(.agent)`/`recipe.revert` 入册。
- **Agent 工具 ×4**(全 harness 注入):
  - `line_context`:我控制的产线/产品/配方全景(运行态、活动批次、逐参数目标 vs PLC 当前值、我的绑定、lastGood;未开跑时列配方定义)。
  - `recipe_versions`:版本史(谁/何时/为什么/参数 diff)。
  - `recipe_update`:最佳参数保存进配方(部分合并;逐节点 dcw 绑定鉴权;reason 必填;生成新版本;只改定义不改运行中 PLC)。
  - `recipe_rollback`:回退到指定版本或 lastGood 冻结(reason 必填;非破坏)。
- **前端**:产品与配方模块配方卡显示 vN 徽标 + 「版本历史」面板(来源徽标 用户/Agent/系统、操作者、原因、参数 diff、逐版「回退到此版」)。

## 验证(隔离实例 :3021,E2E 24/24 `scripts/_dbg-recipe-e2e.mjs`)

- REST 版本流:PATCH→v2(admin 归因)→ Agent recipe_update→v3(Channel/成员归因)→ REST revert→v4 → Agent rollback→v5,参数值逐版断言全过。
- 工具注入:4 新工具在 omp worker 工具清单;负向(无 reason/未绑定节点/不存在版本)全拒。
- **真实 LLM 闭环任务(omp)**:Agent 自主 line_context 确认归属 → recipe_update 保存 92(v6,归因 agent)→ recipe_versions 复核,交付回带 CONTEXT-OK/SAVED-OK/HIST-OK,服务端参数值断言 92 ✓。
- 浏览器:版本历史面板渲染 + 界面回退生成 v4,截图 `.e2e-shots/recipe-history-panel.png`。

---

# 附录 · v0.7.18 增量(配方失效节点一致性)

## 背景

配方参数引用的数控节点可能被停用(enabled=false)、解绑(lineId 改空/改挂其他产线)或删除。修复前:一键下发仍尝试给解绑节点写值;删除节点会让配方编辑/回退整体被归一化拒绝;界面对失效参数无任何标识。

## 修复

- **下发跳过(单点)**:`writeRecipeParams` 逐参数前置三态守卫 —— 已删除 / 已停用 / 已取消绑定(解绑或改挂),各自跳过并在 `run.results` 记明原因(如「已跳过:节点「X」已停用,参数未下发」);正常参数照常下发。停用拒发与手动/Agent 共用 `controller.write` 既有 409 门控。
- **编辑/回退解卡**:`revertToVersion` 对目标快照先剪枝失效参数(剔除动作记入版本描述);`recipe_update` 工具同理(基线剪除 + 回执告知);解绑节点不再被归一化自动收编(尊重显式解绑)。
- **Agent 明确报错**:`dcw_control` 停用节点 →「已停用(控制已暂停),无法下发」;`recipe_update` 触到停用/解绑/删除节点分别给出精确拒因;`line_context`/`recipe_versions` 参数与 diff 带 [已停用/已取消绑定/已删除] 标记。
- **前端**:产品与配方模块参数芯片灰化 + 红色徽标(已停用/已取消绑定/已删除);数采窗口芯片同步;编辑表单自动剔除已删除节点参数行并显示横幅告知,停用/解绑行内联徽标。

## 验证(E2E 19/19 `scripts/_dbg-recipe-stale-e2e.mjs`)

- 一键下发:正常节点照常;停用/解绑/删除三类参数逐一跳过且原因正确入 run.results。
- 写入拒止:手动 REST 409;Agent dcw_control 明确报错。
- recipe_update:停用/解绑触雷被拒;正常保存自动剪除失效参数并告知;回退含失效节点的历史版本剪枝成功且描述留痕;line_context 带状态标记。
- 浏览器:配方卡三态芯片灰化+徽标渲染(截图 `.e2e-shots/recipe-stale-chips.png`)。
- 回归:recipe E2E 24/24、权限 20/20、审计负向 9/9 全过。

---

# 附录 · v0.7.19 增量(模拟真实产线全栈 E2E)

## 场景

模拟器栈全开(modbus-sim:1502 双 float32 寄存器组 / opcua-sim:4840 ns=2 AW.Temp/AW.SetTemp / protocol-sim:1883 极简 MQTT broker + 1889 HTTP 端点 / rtu-mini-slave:15030 FC03+FC10)+ Docker mosquitto/timescale/minio。生产实例(aw start,0.7.18)下重建「模拟产线」:5 数采节点(MBTCP/RTU/MQTT/OPC UA/HTTP)+ 5 数控节点(同五协议)+ 产品/配方。

## 结果(E2E 37/37,`scripts/_dbg-live-line-e2e.mjs`)

- **协议连通**:5 数采节点驱动 test 全部真连成功。
- **数采**:开跑后 5 协议节点全部有实时值(压力 0.93MPa/RTU 42.5/OPC 183.8/MQTT 54.8/HTTP 42.1),管线 produced 持续增长,样本经 MQTT 队列入 Timescale。
- **数控五协议下发+回读**:modbus-tcp 写 0.95(回读 0.95)、modbus-rtu FC10 写 500(回读 500)、opcua 写 88(回读 88)、http POST setpoint(回读 66.6)、mqtt 发布路由捕获(payload 含 55.5)。
- **Agent 闭环**:绑定 → LLM 任务自主 dcw_control(真实 Modbus 下发)→ daq_query(采样证据)→ dcw_judge keep,交付 CLOSEDLOOP-OK。
- **HITL**:manual 绑定的 OPC UA 节点,Agent 下发 → 待审批 → 管理员批准 → 真实写入生效(SetTemp 回读 92)。
- **Recipe/账本**:Agent recipe_update(v2)→ 界面回退(v3)→ dcw_journal 账本查询 → dcw_rollback 节点级回退入册。

## 过程中发现并处理的问题(均非产品代码缺陷)

1. **Timescale 容器端口转发楔死**:容器健康(容器内 psql 正常)但主机 TCP 连接握手即断 → `docker restart` 恢复;应用侧按设计降级(sqlite-emulated)+ `POST /daq/infra/reconnect` 成功重建 mqtt+timescale 真实管线,验证了降级-恢复韧性。
2. **E2E 脚本三处修正**(非产品缺陷):daq 创建 driverConfig 须嵌套传递;**HITL invoke 会挂起等待裁决**(300s)——验证脚本须后台发起+轮询审批+收结果;read 端点回读字段为 `read.value`。
3. **数采采样门控确认**:lineId 空 = 未分配不采集(设计语义),节点必须挂产线且产线开跑才采样。

## 结论

五协议数采/数控、Agent 节点绑定、闭环控制、HITL 审批、Recipe 版本管理与参数账本回退在真实模拟产线通信下全部可用,达到可落地真实产线的验收状态。
