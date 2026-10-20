# HITL 集成演示:omp ask + dsh 权限(群聊界面)

- 日期:2026-10-20
- 版本:**AgentWorkShop 0.7.70**(全局 npm 实例 3001)
- 结论:omp 的原生 **ask 提问** 与 dsh 的原生 **权限请求** 都能在项目群聊界面
  (`/workshop/w/<workspaceId>` → 选中 Channel)弹出 HITL 卡片、渲染选项并由人工点击回复。
  **dsh 的 `ask_user_question` 不能通过 ACP 暴露**——dsh ACP 只桥接
  `session/request_permission`,所以 dsh 侧演示的是权限批准(Allow once/Reject),不是提问型 ask。

## 1. omp ask(提问型)

触发:omp lead 任务要求调用原生 `ask` 工具提问 `Proceed?`(yes/no)。

实测:
- `GET /hitl/pending` 返回 `kind=omp-dialog, requestType=question, method=select,
  options=["yes","no","Other (type your own)"]`。
- 群聊页 `hitl-ui-omp.png`:Channel `ui-omp-mvgo70zp` 已选中;铃标下拉显示
  `Proceed?` + yes/no/Other + “提交答案/取消请求”。
- 浏览器点击 `yes` → 提交答案;`hitl_requests.decision_json` 记录
  `answers:[{id:"__plain",answer:"yes"}]`。
- omp agent 的 `ask` 工具收到 `yes`,任务 COMPLETED,交付物为 `yes`。

## 2. dsh 权限(审批型)

触发:dsh lead(`approvalPolicy=ask`)任务要求执行 shell;dsh 发起原生
`session/request_permission`。

实测:
- `GET /hitl/pending` 返回 `kind=dsh-permission, method=confirm,
  options=["Allow once","Reject"]`。
- 群聊页 `hitl-ui-dsh.png`:Channel `ui-dsh-mvgo70zp` 已选中;铃标下拉显示
  “dsh 权限请求:操作” + 批准/拒绝/取消。
- 浏览器点击“批准”→ 待办清空,`nativeConfirmed=true`,任务从 SUBMITTED 进入 WORKING。

## 3. dsh 的 ask_user_question 为何不是提问卡

用 dsh 任务明确要求“调用 `ask_user_question` 提问 Proceed? yes/no”时,平台收到的是
`dsh-permission`(“dsh 权限请求:操作”,Allow once/Reject),不是 `requestType=question`。
原因:dsh 的 ACP app 只把 `session/request_permission` 暴露给客户端;`ask_user_question`
是 dsh 自身 UI 的 user-questions 插件,不走 ACP 客户端通道。**当前 ACP 集成无法把 dsh
的提问型 ask 渲染成 AW 的问答卡**;要支持需扩展 dsh ACP app 或改用其原生 UI 桥。

## 4. 本轮修复的两个真实缺陷

1. `resolveAnswers` 在 `questions.length===0` 时只读 `decision.value/comment`,
   完全丢弃 UI 提交的 `answers[]` → omp 界面选了 yes,服务端记录空答案。
   现在优先取结构化答案,空答案不伪造。
2. `defaultDispatch` 的 omp-dialog 分支只把 `decision.value` 写回 terminal,
   不编码 `answers[]` → omp ask 收到“dismissed”。
   现在与 harness 路径同源:`encodeHitlAnswers(resolveAnswers(...), value)`。
3. 新增回归测试 `tests/hitl-answers.test.ts`(4 项);全量单测 **273/273**。

> 页面路由提示:`/workshop/w/<channelId>` 会显示“未知 Workspace”;正确入口是
> `/workshop/w/<workspaceId>` 后在左栏选中 Channel(演示脚本已按此修正)。

## 5. 证据

- `hitl-ui-two-harness.json` / `.txt`:11/11 断言通过(workspace 创建、omp ask 全链、
  dsh 权限全链)。
- `hitl-ui-omp.png`:omp ask 的群聊页 HITL 选项(yes/no/Other)。
- `hitl-ui-dsh.png`:dsh 权限卡的群聊页选项(批准/拒绝/取消)。
- `hitl-dsh-ask-probe.json`:要求 dsh `ask_user_question` 时实际得到 `dsh-permission`
  的证据(说明 ACP 不桥接提问型 ask)。
- 提交:`feat(hitl): 修复群聊 answers 传导并完成 omp/dsh 双引擎 HITL 演示`。

## 6. 边界

- dsh 的 AW MCP profile 仍未挂载(profile patch 为空),因此 dsh 无法调用
  `complete_task` 等平台工具;本次只验证 HITL 卡片与批准链路。
- dsh 提问型 ask 不支持(见第 3 节)。
- TUI HITL 仍有 6 项失败(Web/API 链路已通过)。
- PLC 仍是协议级模拟器,不是物理产线现场。
