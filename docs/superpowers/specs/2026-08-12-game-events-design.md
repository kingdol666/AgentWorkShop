# 游戏后端事件驱动框架设计(Agent 驱动人物)

日期: 2026-08-12
状态: 已批准,实现中

## 背景

现有 2D RPG demo(`/game`,Phaser 4)游戏逻辑全部在前端场景内:输入采样、物理、碰撞、对话均本地执行,后端零参与。目标是将控制流重构为**后端事件驱动、前端渲染**:后端持有会话与 Agent,Agent 的每个动作(移动/说话/对话)作为指令经 WebSocket 下发,前端 Phaser 纯渲染执行;玩家输入上行到后端供 Agent 感知。后续 Agent 决策层将替换为 Agent harness SDK(如 Claude Code SDK)实现。

## 架构

```
[键盘] → RpgScene(本地即时移动 + 节流上报)
             │ WS 上行: input.move / input.interact / player.pos / session.join
             ▼
        /api/game/ws (Nitro defineWebSocketHandler)
             │
             ▼
   GameSession(单例,单房间)
      ├─ playerState: 输入方向 / 位置快照(供 Agent 感知)
      ├─ agentState: 位置 / 朝向 / 行为模式 / 对话状态
      └─ tick(20Hz): AgentBrain.think(ctx) → AgentAction[] → 指令队列
             │ WS 下行: session.ready / agent.state / agent.move / agent.face
             │          agent.say / dialog.open / dialog.advance / dialog.close
             ▼
   RpgScene.handleCommand() → 精灵驱动 + bus → Vue HUD(打字机对话框/Agent 状态徽标)
```

## 事件协议

完整定义见 `server/types/game.ts`(前后端共享)。

上行(client → server):
- `session.join {agentId?}` — 连接注册
- `input.move {dx, dy}` — 玩家移动方向(-1/0/1),状态变化时发送
- `input.interact {}` — 空格/回车(对话推进/请求)
- `player.pos {x, y, tileX, tileY}` — 位置快照,250ms 节流

下行(server → client):
- `session.ready {agentName, spawn}` — 连接确认,前端据此放置 Agent 精灵
- `agent.state {mode: idle|wander|approach|talk|wait, speed}` — 行为模式(HUD 徽标)
- `agent.move {dir, durationMs}` — Agent 按方向移动 durationMs
- `agent.face {dir}` — 朝向
- `agent.say {text, ttlMs}` — 头顶气泡
- `dialog.open {agentName, lines}` / `dialog.advance {}` / `dialog.close {}` — 对话状态机(后端权威,打字机动画在前端)
- `error {code, message}`

## 后端组件(server/services/game/)

### agent.ts — AgentBrain 抽象
```ts
interface AgentBrain {
  think(ctx: AgentContext): AgentAction[]
}
interface AgentContext {
  tick: number; now: number
  agent: { x, y, dir, mode }
  player: { x, y, lastSeenAt: number | null, distance: number }
  rng: () => number
}
type AgentAction =
  | { kind: 'move', dir, durationMs } | { kind: 'face', dir }
  | { kind: 'say', text, ttlMs } | { kind: 'dialog', lines }
  | { kind: 'state', mode } | { kind: 'wait', ms }
```
`ScriptBrain`(模拟 Agent,占位):有限状态机 idle → wander → approach → talk → wait,行为逻辑隔离单文件,替换为 LLM/Agent SDK 时仅换 Brain 实现。

### session.ts — GameSession
- 单例,单房间(单用户 demo);连接即加入,断连清理
- `handleInput(msg)`:更新玩家输入/位置/交互请求
- `tick(20Hz)`:装配 AgentContext → brain.think → 动作入队 → 广播下行
- 对话状态机:玩家 interact → 若 Agent 在 talk 模式 → advance;talk 结束 → close
- 广播:当前唯一 peer(多房间扩展点: roomId → peer 集合)

### ws.ts — server/api/game/ws.ts
`defineWebSocketHandler`:open → session.join(回 session.ready);message → JSON 解析 → session.handleInput;close → 注销。

## 前端改造

### app/game/protocol.ts
从 `server/types/game` re-export 类型(同仓直接引用)。

### app/game/client.ts
`GameClient`:连接 `/api/game/ws`、3s 退避自动重连、`send()`、消息分发到 `scene.handleCommand(cmd)`。

### app/game/rpg-scene.ts
- 新增 `handleCommand(cmd)`:放置/驱动 Agent 精灵(复用 `fluttaflap-sheet`),气泡渲染(Phaser 文本 tween),dialog 事件转发 bus
- 玩家输入:本地即时移动(保留手感)+ 键盘状态变化时上报 `input.move`;空格 → 上报 `input.interact`;位置 250ms 节流上报 `player.pos`
- 移除本地 NPC 对话触发(静态装饰 NPC 保留待机动画);对话框推进改由后端 `dialog.advance` 驱动
- 暴露 `getDebugState()`(Agent 位置/模式、WS 状态)供 E2E 断言

### app/pages/game.vue
- boot:场景创建后实例化 GameClient,消息路由到场景与 HUD
- HUD:Agent 状态徽标(模式/连接状态)、断线提示;对话框打字机保留,内容与推进由后端事件驱动
- 调试钩子 `window.__game`(E2E 用)

## 测试

1. **ScriptBrain 纯逻辑单测**(`scripts/test-agent-brain.mjs`,node 直接跑):构造 AgentContext 序列,断言状态机迁移与动作输出(不依赖浏览器)
2. **E2E**(扩展 `verify-game.mjs`):WS 建立 → agent.state 到达 → Agent 位置变化(指令驱动)→ agent.say 气泡 → 玩家靠近 → dialog.open → 空格推进/关闭;保留原有 13 项回归

## 边界

- 后端本轮不控制玩家(仅感知),Agent 控制自身 NPC;玩家接管模式为后续扩展
- 断线重连后重新 session.join,状态以服务端为准
- 无新增依赖(h3 2.x 内置 WebSocket,已验证)
