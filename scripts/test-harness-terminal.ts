/**
 * 烟雾测试:harness 终端镜像(omp `--mode rpc-ui`)—— /monitor 终端功能的服务端回路。
 *
 * 验证链路:
 *  1. OmpRpcClient 以 rpc-ui 模式 spawn(ready 握手)
 *  2. attachTerminalTap 后全部 RPC 帧流入终端会话环形缓冲 + 订阅者广播
 *  3. prompt → 会话事件(agent_start / message_update / tool_execution_* / agent_end)镜像
 *  4. sendTerminalInput(空闲 follow_up)→ 新回合被镜像(人类注入)
 *  5. 真实 HITL:诱导 agent 调 ask 工具 → extension_ui_request 对话框进入 pendingHitl
 *     → respondTerminalUi(select 应答)→ agent 收到答案继续回合(agent_end)
 *  6. dispose → 会话标记退出(alive=false,缓冲保留)
 *
 * 运行:pnpm tsx scripts/test-harness-terminal.ts(需要 omp CLI + 已配置的模型)
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OmpRpcClient } from '../server/services/workshop/agents/adapters/omp-rpc-client'
import {
  attachTerminalTap,
  markTerminalSessionExit,
  respondTerminalUi,
  sendTerminalInput,
  subscribeTerminal,
  terminalSessionSnapshot,
} from '../server/services/workshop/agents/harness-terminal'
import type { TerminalServerMessage } from '../shared/terminal-protocol'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function waitUntil(pred: () => boolean, timeoutMs: number, _what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(200)
  }
  return pred()
}

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) failures += 1
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function frameTypeCounts(snapshot: ReturnType<typeof terminalSessionSnapshot>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const f of snapshot?.replay ?? []) {
    const t = String(f.frame.type)
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return counts
}

/** 诊断:打印指定类型帧的关键字段 */
function dumpFrames(snapshot: ReturnType<typeof terminalSessionSnapshot>, type: string): void {
  for (const f of snapshot?.replay ?? []) {
    if (f.frame.type !== type) continue
    const { id, method, command, success, title, targetId } = f.frame as Record<string, unknown>
    console.log(`    · seq=${f.seq} ${type} method=${String(method ?? '')} command=${String(command ?? '')} success=${String(success ?? '')} title=${String(title ?? '').slice(0, 50)} targetId=${String(targetId ?? '')} id=${String(id ?? '')}`)
  }
}

async function main(): Promise<void> {
  console.log('== harness-terminal 烟雾测试(rpc-ui)==')
  const cwd = mkdtempSync(join(tmpdir(), 'aw-terminal-smoke-'))

  // 1. rpc-ui spawn
  const client = new OmpRpcClient({ command: 'omp', mode: 'rpc-ui', cwd })
  await client.start()
  const pid = client.pid ?? -1
  check(pid > 0, 'omp rpc-ui 子进程启动', `pid=${pid}`)

  // 2. 终端 tap
  attachTerminalTap(client, {
    pid,
    harness: 'omp',
    agentId: 'smoke-agent',
    channelId: 'smoke-channel',
    name: 'smoke-worker',
    role: 'worker',
  })
  const received: TerminalServerMessage[] = []
  const unsub = subscribeTerminal(pid, m => received.push(m)) ?? (() => {})
  check(terminalSessionSnapshot(pid) !== null, '终端会话已建立(tap 挂载)')

  // 3. prompt → 会话事件镜像
  console.log('  … 等待第 1 回合(prompt)')
  await client.send({ type: 'prompt', message: 'Reply with exactly the single word PONG and nothing else.' })
  let ok = await waitUntil(() => {
    const s = terminalSessionSnapshot(pid)
    return s !== null && s.replay.some(f => f.frame.type === 'agent_end' && f.frame.isTerminal !== false)
  }, 240_000, 'agent_end')
  check(ok, '第 1 回合事件镜像至终端(agent_end)')

  const counts1 = frameTypeCounts(terminalSessionSnapshot(pid))
  check((counts1.get('message_start') ?? 0) > 0, 'message_start 帧已镜像', `count=${counts1.get('message_start') ?? 0}`)
  check((counts1.get('message_update') ?? 0) > 0, 'message_update(流式 delta)帧已镜像', `count=${counts1.get('message_update') ?? 0}`)
  check((counts1.get('agent_start') ?? 0) > 0, 'agent_start 帧已镜像')

  // 4. 人类注入(空闲 → follow_up;先等 running 归零再注入,避免排队歧义)
  console.log('  … 等待回合彻底空闲后注入(follow_up)')
  await waitUntil(() => terminalSessionSnapshot(pid)?.running === false, 60_000, 'idle')
  await sendTerminalInput(pid, 'Reply with exactly the single word PONG2 and nothing else.')
  ok = await waitUntil(() => {
    const s = terminalSessionSnapshot(pid)
    const ends = s?.replay.filter(f => f.frame.type === 'agent_end' && f.frame.isTerminal !== false) ?? []
    return ends.length >= 2
  }, 240_000, 'second agent_end')
  check(ok, '人类注入(follow_up)驱动新回合并镜像')
  const snapshotAfterInput = terminalSessionSnapshot(pid)
  check(
    (snapshotAfterInput?.replay.some(f => f.frame.type === '__human_input')) === true,
    '__human_input 合成帧已入缓冲',
  )
  check(
    received.some(m => m.type === 'term.frames' && m.frames.length > 0),
    '订阅者收到实时帧广播(term.frames)',
  )

  // 5. 真实 HITL 回路:诱导 ask → extension_ui_request → 人工应答
  console.log('  … 等待 HITL 对话框(ask 工具)')
  await waitUntil(() => terminalSessionSnapshot(pid)?.running === false, 60_000, 'idle')
  await client.send({
    type: 'prompt',
    message: 'Use the ask tool to ask me: "Pick a color" with options Red and Blue. After I answer, reply with exactly the word I chose and nothing else.',
  })
  await waitUntil(() => terminalSessionSnapshot(pid)?.hitl != null, 240_000, 'extension_ui_request')
  const hitl = terminalSessionSnapshot(pid)?.hitl ?? null
  check(hitl !== null, 'HITL 对话框进入 pending(extension_ui_request 镜像)', hitl ? `method=${hitl.method} options=${JSON.stringify(hitl.options).slice(0, 80)}` : '')

  if (hitl) {
    respondTerminalUi(pid, { id: hitl.id, value: 'Blue' })
    console.log('  … 已应答 Blue,等待回合完成')
    ok = await waitUntil(() => {
      const s = terminalSessionSnapshot(pid)
      const ends = s?.replay.filter(f => f.frame.type === 'agent_end' && f.frame.isTerminal !== false) ?? []
      return terminalSessionSnapshot(pid)?.hitl == null && ends.length >= 3
    }, 240_000, 'post-answer agent_end')
    check(ok, 'HITL 应答后回合继续并完成(agent 收到人工答案)')
    check(terminalSessionSnapshot(pid)?.hitl == null, 'pendingHitl 已清空')
  }

  // 6. dispose → 退出标记
  await client.dispose()
  markTerminalSessionExit(pid, null)
  const dead = terminalSessionSnapshot(pid)
  check(dead !== null && dead.alive === false, '会话标记退出(alive=false)')
  check((dead?.replay.length ?? 0) > 0, '退出后缓冲保留(事后可查看)', `frames=${dead?.replay.length ?? 0}`)

  unsub()
  const counts = frameTypeCounts(dead)
  console.log('\n  帧类型分布:', JSON.stringify(Object.fromEntries([...counts.entries()].sort())))
  dumpFrames(dead, 'extension_ui_request')
  dumpFrames(dead, 'response')
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('烟雾测试异常:', err)
  process.exit(1)
})
