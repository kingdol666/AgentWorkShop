/**
 * GameSession 会话级集成测试 — 模拟 Agent 全链路(无浏览器,node + tsx 直跑)
 *
 * 直接构造 GameSession + 假 WS peer,驱动上行消息,断言下行指令序列:
 *  1. 同步 brain(ScriptBrain):connect → session.ready/agent.state;玩家贴脸 →
 *     dialog.open;3 次 interact → advance×2 + close + 大脑收到事件转入 wait
 *  2. 异步 brain(MockSdkBrain, 零延迟):决议经 Promise 到达,agent.move 照常下发
 *  3. 大脑主动 dialog.close 动作 → 下行 dialog.close
 *  4. stop() 停止主循环,不再产出新指令
 */
import { AGENT_SPAWN, type AgentAction, type AgentBrain, type AgentContext, type ServerToClient } from '../server/types/game'
import { MockSdkBrain, ScriptBrain } from '../server/services/game/agent'
import { GameSession } from '../server/services/game/session'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    failures += 1
  }
}

/** 假 WS peer:捕获下行指令(结构兼容 h3 peer) */
class FakePeer {
  sent: ServerToClient[] = []

  send(data: string | Uint8Array): void {
    this.sent.push(JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)))
  }

  close(): void {}
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 轮询等待某条下行指令出现 */
async function waitFor(peer: FakePeer, pred: (cmd: ServerToClient) => boolean, timeoutMs: number): Promise<ServerToClient | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = peer.sent.find(pred)
    if (found) {
      return found
    }
    await sleep(25)
  }
  return null
}

const count = (peer: FakePeer, type: ServerToClient['type']) => peer.sent.filter(c => c.type === type).length

// ---------------------------------------------------------------- 1. 同步 brain 全链路

async function testSyncBrain(): Promise<void> {
  const peer = new FakePeer()
  const session = new GameSession(new ScriptBrain())
  session.connect(peer)

  check('connect → session.ready', peer.sent.some(m => m.type === 'session.ready'))
  check('connect → agent.state(初始)', peer.sent.some(m => m.type === 'agent.state'))

  // 玩家贴脸(80px < TALK_RADIUS 96px)→ 首个 tick 应发起对话
  session.handleInput({
    type: 'player.pos',
    payload: { x: AGENT_SPAWN.x + 80, y: AGENT_SPAWN.y, tileX: 0, tileY: 0 },
  })
  const opened = await waitFor(peer, m => m.type === 'dialog.open', 2000)
  check('贴脸 → dialog.open', opened !== null, opened ? `lines=${(opened as { payload: { lines: string[] } }).payload.lines.length}` : 'timeout')

  // 空格推进:3 句 → advance×2 + close
  session.handleInput({ type: 'input.interact', payload: {} })
  await waitFor(peer, m => m.type === 'dialog.advance', 1000)
  session.handleInput({ type: 'input.interact', payload: {} })
  await waitFor(peer, () => count(peer, 'dialog.advance') >= 2, 1000)
  session.handleInput({ type: 'input.interact', payload: {} })
  const closed = await waitFor(peer, m => m.type === 'dialog.close', 1000)
  check('interact×3 → dialog.close', closed !== null)
  check('advance 恰好 2 次', count(peer, 'dialog.advance') === 2, `actual=${count(peer, 'dialog.advance')}`)

  // 大脑收到 dialog.closed 事件 → 转入 wait
  const waited = await waitFor(peer, m => m.type === 'agent.state' && m.payload.mode === 'wait', 2000)
  check('dialog.closed 事件 → 大脑转入 wait', waited !== null)
  session.stop()
}

// ---------------------------------------------------------------- 2. 异步 brain(sdk-mock)

async function testAsyncBrain(): Promise<void> {
  const peer = new FakePeer()
  const session = new GameSession(new MockSdkBrain([0, 0]))
  session.connect(peer)

  const ready = await waitFor(peer, m => m.type === 'session.ready', 1000)
  check('async connect → session.ready', ready !== null)
  // 无玩家感知 → 大脑游荡,首个 move 决议须经 Promise 应用
  const moved = await waitFor(peer, m => m.type === 'agent.move', 2000)
  check('async 决议 → agent.move 下发', moved !== null, moved ? `dir=${moved.payload.dir}` : 'timeout')
  session.stop()
}

// ---------------------------------------------------------------- 3. 大脑主动关闭对话

/** 逐 tick 演进的测试大脑:先开对话,下一 tick 主动关闭 */
class CloseBrain implements AgentBrain {
  readonly name = 'close-test'

  private phase = 0

  think(_ctx: AgentContext): AgentAction[] {
    if (this.phase === 0) {
      this.phase = 1
      return [{ kind: 'dialog', lines: ['hi'] }]
    }
    if (this.phase === 1) {
      this.phase = 2
      return [{ kind: 'dialog.close' }]
    }
    return []
  }
}

async function testBrainClose(): Promise<void> {
  const peer = new FakePeer()
  const session = new GameSession(new CloseBrain())
  session.connect(peer)

  const opened = await waitFor(peer, m => m.type === 'dialog.open', 1000)
  check('大脑发起对话 → dialog.open', opened !== null)
  const closed = await waitFor(peer, m => m.type === 'dialog.close', 1000)
  check('大脑 dialog.close 动作 → 下行 dialog.close', closed !== null)
  session.stop()
}

// ---------------------------------------------------------------- 4. stop() 停止主循环

async function testStop(): Promise<void> {
  const peer = new FakePeer()
  const session = new GameSession(new ScriptBrain())
  session.connect(peer)
  await waitFor(peer, m => m.type === 'agent.move', 1500)
  session.stop()
  const before = peer.sent.length
  await sleep(300)
  check('stop() 后无新指令', peer.sent.length === before, `before=${before} after=${peer.sent.length}`)
}

// ----------------------------------------------------------------

async function main(): Promise<void> {
  await testSyncBrain()
  await testAsyncBrain()
  await testBrainClose()
  await testStop()
  console.log(`\n===== ${4 - failures}/4 passed =====`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error('SESSION TEST CRASH:', e)
  process.exit(2)
})
