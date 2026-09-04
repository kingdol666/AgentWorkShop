# AgentWorkShop TUI —— 终端工作台

与 AgentTeam 交互作业的终端客户端(pi-tui 组件化渲染,与 WebUI 平级的瘦客户端):
创建/切换 Channel、放置 Agent、发送任务、实时查看执行过程,以及 **HITL 待办
(omp ask 对话框 / dcw 下发审批)的统一提醒与作答**。

## 启动

```bash
aw tui                          # 或:pnpm tui / node tui/aw-tui.mjs
aw tui --url http://127.0.0.1:3000 --token ut-xxxx --channel <名>
```

- 首次使用交互式登录(邮箱+密码);凭据落 `<配置根>/tui-auth.json`(0600,
  已 gitignore)。也可用环境变量 `AW_TUI_EMAIL` / `AW_TUI_PASSWORD` 免交互。
- 需要服务端已运行(`pnpm dev` 或 `aw start`)。

## 界面

```
┌ 会话时间线(左)                          ┌ 监控面板(右,/monitor 开启)
│ ◆ 你 消息 · ◆ Agent 回复 · 任务状态行    │ ┌─ 监控 <agent> · 流式中
├ HITL 作答卡(/hitl <n> 进入作答时出现)
├ 状态条:频道 · 成员(忙 n) · HITL 待处理 n · 连接态
└ 输入框(/ 命令补全 · ↑↓ 历史)
```

## 命令

| 命令 | 说明 |
|------|------|
| `/help` | 命令列表 |
| `/channels` | 列出我的频道 |
| `/channel new <名> [--desc …] [--lead <名>]` | 创建频道(可选内联建 lead) |
| `/channel use <名\|序号>` | 切换频道(WS 断点续传) |
| `/channel add <模板\|名> [--role lead\|worker] [--harness omp] [--config JSON]` | 放置 Agent 实例 |
| `/agents` | 当前频道成员与实时状态 |
| `/send <agent\|序号> <文本…>` | 向指定 Agent 直发(忙碌时 steer 注入) |
| `/task <标题…> [--mode goal\|loop\|pipeline] [--assignee <agent>]` | 提交正式任务 |
| `/tasks` | 任务列表与七态/进度 |
| `/monitor <agent\|序号\|off>` | 开/关右侧终端镜像(实时执行过程) |
| `/hitl [序号\|off]` | 待人工处理列表/进入作答/放弃作答 |
| `/quit` | 退出 |

普通文本 = 向当前频道 lead 发送任务(`priority=task`)。

## HITL 流程(与 WebUI 同一套服务端)

1. Agent 需要人类确认/ask 时,服务端 hitl-registry 登记待办,所有已连接
   客户端(WebUI 徽标 / TUI 状态条)收到 `hitl.request` 帧 → 提醒亮起。
2. TUI:`/hitl` 看列表 → `/hitl <序号>` 进入作答卡(自动可配合 `/monitor`
   观察现场);confirm 输 `y/n`,select 输序号,input/editor 直接输入。
3. 回车提交 → `POST /api/workshop/hitl/respond` → extension_ui_response
   直写 omp stdin(或 dcw 审批落定)→ `hitl.resolved` 帧 → 双端提醒消隐。
4. 无人观看时对话框 park `security.hitl_timeout_ms`(默认 180s,仅零订阅
   期间倒计时,有人接入终端即暂停;配 0 恢复旧的立即取消行为)。

## 测试

```bash
node scripts/test-hitl-registry.ts     # 服务端 registry + park 语义(需 tsx)
node scripts/test-tui-reducers.mjs     # AEP 帧归约
node scripts/test-tui-commands.mjs     # 命令解析/分发
node scripts/tui-smoke.mjs             # 无头 e2e(需 dev server 运行)
```
