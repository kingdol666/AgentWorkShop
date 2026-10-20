# 产线上线预验收报告(Production Readiness)

- 日期:2026-10-20
- 版本:AgentWorkShop **0.7.67**(全局 npm 安装实例,3001)
- PRD:`.omc/prd.json`(US-001 ~ US-008)
- 结论:**软件侧产线作业链路已通过预验收**(真实协议 + 真实平台进程);
  **不是物理 PLC/真实车间的现场验收**——现场还需 IP/端口/寄存器/安全许可联调。

## 0. 验收范围与边界

本次“真实”指:
- 真实运行的 PLC 节点模拟器(`plc-node-simulator`,5 协议:Modbus TCP/RTU、OPC UA、MQTT、HTTP);
- 真实平台进程(全局 npm 0.7.67)、真实数据库、真实 Agent 子进程(omp/copilot)、真实 HITL。
- 不包含:物理 PLC、真实车间网络、安全 PLC 联锁、现场急停/安全回路。
- 12 个 harness 未取得真实作业证据:11 个受未登录/配额/上游配置阻塞,mock 是确定性
  测试替身(不调用 LLM);本轮产线作业由 **omp + copilot** 完成。MCP 工具注册对
  **可运行的 Agent**(omp/copilot)已验证;不能宣称“全部引擎已真实作业”。
  详见 `2026-10-20-harness-native-vs-mcp.md`。

## 1. PRD 验收结果

| 故事 | 验收项 | 结果 | 证据 |
|---|---|---|---|
| US-001 | 五协议节点连通/读值 | **PASS** | `us001-connectivity.json`;test-driver 12/12,7/7 DAQ state ok(5 标量有值) |
| US-002 | 产线管理与配方生命周期 | **PASS** | `us002-line-lifecycle*.json`;5 DCW+7 DAQ,stop→false/start→true(new run) |
| US-003 | 团队派发/mailbox/数采/下发 | **PASS** | `us003-team-global.json`;15/0,子任务 parent_id/assignee 核验,v5,PLC 回读 44 |
| US-004 | manual HITL 批准+拒绝 | **PASS** | 批准见 US-003(2 卡);拒绝 `us004-hitl-reject.json` 9/0(含 pending 窗口快照) |
| US-005 | 原生 ask HITL + 群聊 UI | **PASS** | `us005-ask-hitl.json` 6/0;`hitl-live-final.txt` U2c-f PASS |
| US-006 | 工具注册/注入/按 Agent 描述 | **PASS** | `us006-mcp-tools.json` 64 tools;描述含 5 节点;omp 原生/copilot MCP |
| US-007 | 构建/单测/打包/全局启动 | **PASS** | typecheck ✔;268/268;build 0.7.67;`us007-global-build.json` |
| US-008 | 提交推送 | **PASS** | `95358665` + `bab0618b` + `e26956e6`,已推送 origin/tii-revision-20261017(见第 5 节) |

## 2. 关键实测

### 2.1 节点连通(US-001)

- 5 协议端口监听:37570(Modbus TCP)、37571(Modbus RTU)、4855(OPC UA)、55830(MQTT)、4047(HTTP)。
- 平台 `test-driver`:**12/12** 通过(含 vector 8 点、image PNG 68B)。
- 7 个 DAQ 节点状态 `ok`;5 个标量节点有实时值(35/60.1/5/40.1/34.952)。
- 向量帧 8 点、图像帧 PNG 对象均在 `daq_frames` 中可查。
- 注:vector/image 两个节点在本次快照中各带一条瞬时 `PLC 响应超时`(value=0),随后恢复
  并有帧落库;现场需按此设置采集超时/重连与告警。

### 2.2 产线管理(US-002)

- 产线 `ln-dd6c9135`:5 DCW + 7 DAQ,全部归属正确。
- 配方 `rc-2be5c50c` 在生命周期测试时为 v3,后续团队写入到 v5;参数节点全部属于该产线。
- 生命周期:active `true(rr-7ff99163)` → stop → `false(null)` → start → `true(rr-f85d0de8)`。

### 2.3 团队作业与下发(US-003)

- mock lead 在独立 dispatch 频道强制走 `[mock:complex]` 派发:数据库核验子任务
  `parent_id=root`、`assignee_id=mock worker`、`state=COMPLETED`;root 交付物为
  `lead-acceptance-summary`(文本“验收 1/1｜…”),不是 `lead-direct-answer`。
- mailbox:lead→analyst 消息落库,`state=consuming`(真实 Agent 消费)。
- omp 分析师:`line_context` + `daq_query` 取到真实样本并完成。
- copilot 操作员:`recipe_update 44` + `recipe_apply` 两次 HITL 批准;配方 **v5**;PLC 回读 **44 m/min**。

### 2.4 HITL 两条链路(US-004/005)

- **manual 审批**:`dcw-approval` 两张卡(update/apply),批准后版本递增/下发;
  拒绝路径 **9/0**:pending 窗口快照 v5/44 未变 → 拒绝 → agent 收到 `REJECT-ACCEPTANCE`
  人工附言 → 配方 v5、PLC 44 均不变(fail-closed)。
- **ask 提问**:`omp-dialog` question/select,yes/no/Other;直接任务链 6/0;
  群聊页 `/workshop/w/<channel>` 渲染 yes/no + 提交按钮(U2c–U2f PASS),
  应答后 `hitl.resolved(answered)`,agent `ask` 返回 `yes`。
- TUI 阶段仍有 6 项失败(见 `hitl-live-final.txt`),不影响 API/浏览器群聊链路。

### 2.5 工具注册(US-006)

- MCP 桥对真实 agent token `tools/list`:**64 个工具**,含
  `send_message_to_agent`、`recipe_update`、`mes_fetch`。
- 分析师 `daq_query` 描述追加 5 个绑定节点;操作员 `recipe_update` 描述追加
  `rc-2be5c50c` v5 与 5 个参数(`us006-mcp-tools.json` 的 `recipeUpdateTail`)。
- omp 原生 `set_host_tools`、pi 原生扩展 `registerTool` 为代码路径;
  copilot 在 0.7.67 全局实例完成任务,交付物 `HARNESS-OK:copilot on 0.7.67`。

### 2.6 构建与全局发布(US-007)

- `npm run typecheck` ✔(`us007-typecheck.txt`);`npm run test:unit` **268/268**
  (`us007-unit.txt`)。
- 构建 `.output` 内嵌 **0.7.67**;`npm pack` 40.8 MB/3735 files;
  全局安装后 `/api/health` 返回 **0.7.67**。
- 全局实例 omp 任务交付物 **PROD-READINESS-OK**,另一次任务交付物 **GLOBAL-067-OK**
  (两者均在 `us007-global-build.json`)。

## 3. 不能宣称的(必须现场确认)

1. **不是物理产线验收**:本轮 PLC 是协议级模拟器;真实 PLC 的 IP/端口/寄存器/字节序/
   安全许可/网络隔离需现场逐项核对。
2. **不是 14 个 harness 全部作业通过**:omp/copilot 真实通过;其余 12 个未取得真实作业
   证据(11 个因登录/配额/上游配置不可用,mock 为测试替身)。MCP 工具面只在可运行的
   omp/copilot 上验证;生产上线若要求多引擎冗余,需先补齐各引擎凭据。
3. **TUI HITL 仍有 6 项失败**;Web 群聊/API 的 ask HITL 已通过。
4. **安全审计未完成**(Mimosa scanner_enobufs);不能宣称“已通过安全审计”。

## 4. 现场上线检查清单

- [ ] 物理 PLC/网关 IP、端口、单元号、寄存器地址、字节序与本文 `driverConfig` 对齐
- [ ] 现场网络 ACL/防火墙放行平台到设备方向
- [ ] 设备写保护/安全联锁确认(平台 HITL 不能替代硬件安全回路)
- [ ] DAQ 采样周期、超时、重连、告警阈值按现场工艺设定
- [ ] 配方窗口/步长/保持窗/60s 写间隔按工艺安全规范复核
- [ ] 现场操作员账号、Channel owner、HITL 审批策略配置
- [ ] 断链/断电/重启演练(模拟器故障注入仅覆盖软件侧)

## 5. 提交记录

- 分支:`tii-revision-20261017`(origin: `https://github.com/kingdol666/AgentWorkShop.git`)
- `95358665` test(readiness): 完成产线作业与 HITL 全链预验收
- `bab0618b` test(readiness): 修复派发假阳性并补齐拒绝窗口/typecheck 证据
- `e26956e6` docs(readiness): 补齐提交记录与复验证据引用
- 本报告随上述提交推送;评审修复后的复验证据见 `us003-team-global.json`
  (15/0,子任务 parent/assignee 核验)、`us004-hitl-reject.json`(9/0,pending 窗口)、
  `us007-typecheck.txt`、`us007-global-build.json`(含 GLOBAL-067-OK)。
