# 游戏后端事件驱动框架设计(Agent 驱动人物)

日期: 2026-08-12(实现于 2026-08-13)
状态: 已实现并验证(逻辑测试 6/6、会话集成测试 4/4、E2E 15/15)

## 背景

现有 2D RPG demo(`/game`,Phaser 4)游戏逻辑全部在前端场景内:输入采样、物理、碰撞、对话均本地执行,后端零参与。目标是将控制流重构为**后端事件驱动、前端渲染**:后端持有会话与 Agent,Agent 的每个动作(移动/说话/对话)作为指令经 WebSocket 下发,前端 Phaser 纯渲染执行;玩家输入上行到后端供 Agent 感知。后续 Agent 决策层将替换为 Agent harness SDK(如 Claude Code SDK)实现。

## 架构

```
[键盘] → RpgScene(本地即时移动 + 节流上报)
             │ WS 上行: session.join / input.move / input.interact
             │          player.pos / agent.pos(渲染位置事实上报)
             ▼
        /api/game/ws (Nitro defineWebSocketHandler)
             │
             ▼
   GameSession(单例,单房间;brain 由 GAME_BRAIN 注入)
      ├─ playerState: 输入方向 / 位置快照(供 Agent 感知)
      ├─ agentState: 位置(client 事实上报)/ 朝向 / 行为模式 / 对话状态
      └─ tick(20Hz): AgentBrain.think(ctx) → AgentAction[] → 指令队列
             │         同步 brain 即时应用;异步 brain(Promise)由 thinking 守卫串行
             │ WS 下行: session.ready / agent.state / agent.move / agent.face
             │          agent.say / dialog.open / dialog.advance / dialog.close
             ▼
   RpgScene.handleCommand() → 精灵驱动 + bus → Vue HUD(打字机对话框/Agent 状态徽标)
```

## 事件协议

完整定义见 `server/types/game.ts`(前后端共享,单一事实来源)。

上行(client → server):
- `session.join {agentId?}` — 连接注册
- `input.move {dx, dy}` — 玩家移动方向(-1/0/1),状态变化时发送
- `input.interact {}` — 空格/回车(对话推进/请求)
- `player.pos {x, y, tileX, tileY}` — 玩家位置快照,250ms 节流
- `agent.pos {x, y}` — Agent 渲染位置事实上报,250ms 节流
  (客户端物理是移动执行的真相:碰撞/边界在客户端,服务端大脑据此计算真实距离)

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
  readonly name: string
  think(ctx: AgentContext): AgentAction[] | Promise<AgentAction[]>
  onEvent?(e: BrainEvent): void
}
interface AgentContext {
  tick: number
  now: number
  agent: { x, y, dir, mode } // 位置由 client agent.pos 事实上报
  player: { x, y, lastSeenAt: number | null, distance: number }
  rng: () => number
}
type AgentAction =
  | { kind: 'move', dir, durationMs } | { kind: 'face', dir }
  | { kind: 'say', text, ttlMs } | { kind: 'dialog', lines }
  | { kind: 'dialog.close' } | { kind: 'state', mode, speed } | { kind: 'wait', ms }
```

### 大脑实现与接入点

- `ScriptBrain`(默认):确定性有限状态机 idle → wander → approach → talk → wait,行为隔离单文件
- `MockSdkBrain`(`GAME_BRAIN=sdk-mock`):走与真实 SDK 一致的异步路径——每个 think 模拟推理延迟后经 Promise 决议,验证会话层异步守卫
- `createBrain(kind)`:单一工厂注入点;接入 Claude Code SDK 等真实 Agent 时仅需新增实现 + 在此注册,会话层与协议零改动

### session.ts — GameSession

- 单例,单房间(单用户 demo);连接即加入,断连清理
- 构造注入 brain(`GameSession(brain?)`,默认 `createBrain()`);`stop()` 停止主循环
- `handleInput(msg)`:玩家输入/位置、Agent 渲染位置(agent.pos)事实上报
- `tick(20Hz)`:装配 AgentContext → brain.think;同步决议即时应用,异步决议(Promise)由 `thinking` 守卫串行、决议到达后统一应用
- 对话状态机:玩家 interact → advance;末句或大脑 `dialog.close` 动作 → close + `dialog.closed` 事件回传大脑
- 广播:当前唯一 peer(多房间扩展点: roomId → peer 集合)

### ws.ts — server/api/game/ws.ts

`defineWebSocketHandler`:open → session.connect(回 session.ready);message → JSON 解析 → session.handleInput;close → 注销。

## 前端改造

### app/game/protocol.ts

从 `server/types/game` re-export 类型(同仓直接引用)。

### app/game/client.ts

`GameClient`:连接 `/api/game/ws`、3s 退避自动重连、`send()`、消息分发到 `scene.handleCommand(cmd)`。

### app/game/rpg-scene.ts

- 新增 `handleCommand(cmd)`:放置/驱动 Agent 精灵(复用 `fluttaflap-sheet`),气泡渲染(Phaser 文本 tween),dialog 事件转发 bus
- 玩家输入:本地即时移动(保留手感)+ 键盘状态变化时上报 `input.move`;空格 → 上报 `input.interact`;位置 250ms 节流上报 `player.pos`
- Agent 渲染位置 250ms 节流上报 `agent.pos`(物理碰撞在客户端,位置真相在渲染层)
- 移除本地 NPC 对话触发(静态装饰 NPC 保留待机动画);对话框推进改由后端 `dialog.advance` 驱动
- 暴露调试钩子 `getDebugState()` / `setDebugMove()` / `setDebugPos()`(E2E 断言与导航用)

### app/pages/game.vue

- boot:场景创建后实例化 GameClient,消息路由到场景与 HUD
- HUD:Agent 状态徽标(模式/连接状态)、断线提示;对话框打字机保留,内容与推进由后端事件驱动
- 调试钩子 `window.__game`(E2E 用)

## 测试

1. **ScriptBrain 纯逻辑单测**(`scripts/test-agent-brain.ts`,tsx 直跑):构造 AgentContext 序列,断言状态机迁移与动作输出(6/6)
2. **GameSession 会话集成测试**(`scripts/test-game-session.ts`):假 peer + 模拟 Agent 全链路——同步/异步 brain 决议、对话推进关闭、大脑主动关对话、stop()(4/4)
3. **E2E**(`scripts/verify-game.mjs`,puppeteer-core + Edge):WS 建立 → agent.state → Agent 指令驱动移动 → agent.say 气泡 → 玩家靠近 → dialog.open → 空格推进/关闭 → 大脑转入等待(15/15)

运行:`pnpm game:test`(1+2)、`pnpm game:verify`(3,需 dev server 与 Edge)。

## 边界

- 后端本轮不控制玩家(仅感知),Agent 控制自身 NPC;玩家接管模式为后续扩展
- 断线重连后重新 session.join,状态以服务端为准
- 无新增依赖(h3 2.x 内置 WebSocket,已验证)
