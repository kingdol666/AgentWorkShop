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
