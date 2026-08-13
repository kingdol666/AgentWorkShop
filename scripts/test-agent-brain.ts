/**
 * ScriptBrain 模拟 Agent — 纯逻辑单测(node + tsx 直跑,无浏览器依赖)
 *
 * 验证状态机迁移与动作输出:
 *  1. 初始 tick → 进入 wander + move 动作
 *  2. 玩家进入 6 tiles → approach + 朝玩家方向移动
 *  3. 玩家贴脸(≤3 tiles)→ talk + dialog 发起 + face
 *  4. dialog.closed 事件 → wait,冷却后恢复 wander
 *  5. 地图边缘 → 不朝边界外走
 *  6. 对话中 → 不产出 move
 */
import { ScriptBrain } from '../server/services/game/agent'
import type { AgentContext, Dir } from '../server/types/game'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok)
    failures += 1
}

const AGENT_START = { x: 720, y: 656 }
const rngSeq = (() => {
  let i = 0
  const seq = [0.9, 0.1, 0.5, 0.7, 0.3, 0.6, 0.2, 0.8, 0.4, 0.95]
  return () => seq[i++ % seq.length]
})()

function mkCtx(over: Partial<AgentContext> = {}): AgentContext {
  return {
    tick: 1,
    now: 1000,
    agent: { ...AGENT_START, dir: 'down', mode: 'idle' },
    player: { x: 0, y: 0, lastSeenAt: null, distance: Infinity },
    rng: rngSeq,
    ...over,
  }
}

// 1. 初始:进入 wander 并产出 move
{
  const brain = new ScriptBrain()
  const acts = brain.think(mkCtx())
  const state = acts.find(a => a.kind === 'state')
  const move = acts.find(a => a.kind === 'move')
  check('初始 tick 进入 wander', state?.kind === 'state' && state.mode === 'wander')
  check('初始 tick 产出移动动作', move?.kind === 'move' && (move as { durationMs: number }).durationMs > 0,
    `dir=${(move as { dir: Dir }).dir} dur=${(move as { durationMs: number }).durationMs}ms`)
}

// 2. 玩家 5 tiles:approach + 朝玩家方向
{
  const brain = new ScriptBrain()
  brain.think(mkCtx()) // 进入 wander
  const ctx = mkCtx({
    now: 2000,
    player: { x: AGENT_START.x + 160, y: AGENT_START.y, lastSeenAt: 1999, distance: 160 },
  })
  const acts = brain.think(ctx)
  const state = acts.find(a => a.kind === 'state')
  const move = acts.find(a => a.kind === 'move')
  check('玩家 5 tiles → approach', state?.kind === 'state' && state.mode === 'approach')
  check('approach 朝玩家方向(right)', move?.kind === 'move' && (move as { dir: Dir }).dir === 'right')
}

// 3. 玩家贴脸:talk + dialog
{
  const brain = new ScriptBrain()
  brain.think(mkCtx())
  const ctx = mkCtx({
    now: 3000,
    player: { x: AGENT_START.x + 64, y: AGENT_START.y, lastSeenAt: 2999, distance: 64 },
  })
  const acts = brain.think(ctx)
  const dialog = acts.find(a => a.kind === 'dialog')
  const move = acts.find(a => a.kind === 'move')
  check('贴脸发起对话', dialog?.kind === 'dialog' && (dialog as { lines: string[] }).lines.length >= 1)
  check('对话中不产出移动', move === undefined)
  // 继续 tick:仍 talk,无新 dialog
  const acts2 = brain.think(mkCtx({ now: 3100, player: { x: AGENT_START.x + 64, y: AGENT_START.y, lastSeenAt: 3099, distance: 64 } }))
  check('对话期间不重复发起', !acts2.some(a => a.kind === 'dialog'))
}

// 4. 对话关闭 → wait → 冷却后 wander
{
  const brain = new ScriptBrain()
  brain.think(mkCtx())
  brain.think(mkCtx({ now: 3000, player: { x: AGENT_START.x + 64, y: AGENT_START.y, lastSeenAt: 2999, distance: 64 } }))
  brain.onEvent?.({ kind: 'dialog.closed' })
  const during = brain.think(mkCtx({ now: 3500, player: { x: AGENT_START.x + 64, y: AGENT_START.y, lastSeenAt: 3499, distance: 64 } }))
  check('dialog.closed → 无动作(wait 冷却)', during.length === 0 || !during.some(a => a.kind === 'move'))
  const after = brain.think(mkCtx({ now: 9000, player: { x: AGENT_START.x + 64, y: AGENT_START.y, lastSeenAt: 8999, distance: 64 } }))
  const state = after.find(a => a.kind === 'state')
  check('冷却后恢复 wander', state?.kind === 'state' && state.mode === 'wander')
}

// 5. 地图边缘:不向界外走
{
  const brain = new ScriptBrain()
  const ctx = mkCtx({
    now: 5000,
    agent: { x: 40, y: 656, dir: 'down', mode: 'wander' }, // 左边缘 40px(<2 tiles=64)
  })
  // 固定 rng 序列首个 0.9 → 可能选 left;边缘保护应避免向界外
  for (let i = 0; i < 20; i++) {
    const acts = brain.think(ctx)
    const move = acts.find(a => a.kind === 'move')
    if (move?.kind === 'move' && move.dir === 'left') {
      check('地图边缘不向左走', false, `tick ${i} 仍向左`)
      break
    }
    if (i === 19)
      check('地图边缘不向左走', true)
  }
}

// 6. 玩家远离(>11 tiles) → 放弃追逐回 wander
{
  const brain = new ScriptBrain()
  brain.think(mkCtx()) // wander
  brain.think(mkCtx({
    now: 2000,
    player: { x: AGENT_START.x + 160, y: AGENT_START.y, lastSeenAt: 1999, distance: 160 },
  })) // approach
  const far = mkCtx({
    now: 3000,
    player: { x: AGENT_START.x + 400, y: AGENT_START.y + 400, lastSeenAt: 2999, distance: 566 },
  })
  const acts = brain.think(far)
  const state = acts.find(a => a.kind === 'state')
  check('玩家远离 → 回 wander', state?.kind === 'state' && state.mode === 'wander')
}

console.log(`\n===== ${6 - failures}/6 passed =====`)
process.exit(failures ? 1 : 0)
