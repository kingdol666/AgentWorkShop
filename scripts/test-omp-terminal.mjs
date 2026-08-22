// -*- coding: utf-8 -*-
// 真实 omp 终端 E2E(node scripts/test-omp-terminal.mjs)
//
// 验证 Web 终端原生控制的完整闭环(真 LLM / 真子进程 / 真 WS 双向通道):
//  T1 任务直发 omp worker → 子进程 lazy spawn → GET terminals 出现会话
//  T2 终端 WS 连接(agentId 寻址)→ term.init + 实时帧(tool 执行/流式输出)
//  T3 Web 输入控制:input 帧(follow_up/steer)注入真实会话 → 会话响应新回合
//  T4 abort 控制:中止运行中回合
//  T5 任务终态(完成或失败均如实报告;LLM 后端不可用时降级为链路验证)
import { env } from 'node:process'

const BASE = env.AW_BASE ?? 'http://127.0.0.1:3002'
const TOKEN = env.AW_TOKEN ?? 'ut-636e563104b844b591de8aadf6071aea'
const WS_BASE = BASE.replace(/^http/, 'ws')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const d = await res.json().catch(() => ({}))
  if (d?.code !== undefined && d.code !== 0 && d.code !== 'ok') {
    throw new Error(`${method} ${path} -> ${JSON.stringify(d).slice(0, 200)}`)
  }
  return d?.data ?? d
}
async function pollUntil(fn, timeoutMs, stepMs = 500) {
  const t0 = Date.now()
  for (;;) {
    const v = await Promise.resolve(fn()).catch(() => null)
    if (v) return v
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(stepMs)
  }
}

/** 终端 WS 会话(收集全部服务端消息) */
function termWs(agentId, channelId) {
  const state = { ws: null, msgs: [], frames: [], closed: false, closeCode: null, err: null }
  state.open = new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/api/system/monitor/terminal/ws?token=${TOKEN}&agentId=${agentId}&channelId=${channelId}`)
    state.ws = ws
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    ws.addEventListener('close', (ev) => {
      state.closed = true
      state.closeCode = ev.code
    }, { once: true })
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data)
        state.msgs.push(m)
        if (m.type === 'term.frames') state.frames.push(...m.frames)
        if (m.type === 'term.error') state.err = m
      }
      catch { /* ignore */ }
    })
  })
  state.send = o => state.ws.send(JSON.stringify(o))
  state.frameTypes = () => new Set(state.frames.map(f => f.frame?.type))
  return state
}

async function main() {
  const stamp = Date.now().toString(36)
  const created = await api('POST', '/api/workshop/channels', {
    name: `omp-term-e2e-${stamp}`,
    description: 'omp 终端控制 E2E(自动清理)',
    leadAgent: { name: 'term-lead', harness: 'mock', config: { delayMs: 60 } },
  })
  const cid = created.channelId
  try {
    const w = await api('POST', `/api/workshop/channels/${cid}/agents`, { name: 'term-worker', harness: 'omp', config: {} })
    const wid = w.id
    console.log(`channel=${cid.slice(0, 8)} omp-worker=${wid.slice(0, 8)}`)

    // ===== T1:任务触发 omp spawn → 终端会话出现 =====
    console.log('\n--- T1:任务 → omp 子进程 spawn → 终端会话 ---')
    const task = await api('POST', `/api/workshop/channels/${cid}/tasks`, {
      title: `终端联调-${stamp}`,
      description: '请直接回复一句"终端联调完成",然后用 complete_task 提交该回复作为交付物。不要做任何其他工作。',
      assigneeId: wid,
      parts: [{ text: '终端联调任务:只回复一句话并完成。' }],
    })
    const session = await pollUntil(async () => {
      const terms = await api('GET', `/api/workshop/channels/${cid}/terminals`)
      return terms.find(t => t.agentId === wid && t.alive) ?? null
    }, 60_000, 800)
    check('T1 omp 子进程 spawn,终端会话上线', !!session, session ? `pid=${session.pid}` : '60s 内未出现')

    // ===== T2:WS 连接 → init + 实时帧 =====
    console.log('\n--- T2:终端 WS 镜像流 ---')
    const t = termWs(wid, cid)
    await t.open
    // init 帧在 open 之后异步到达(等待而非同 tick 断言)
    const init = await pollUntil(() => t.msgs.find(m => m.type === 'term.init') ?? null, 8_000, 150)
    check('T2 term.init(会话元信息)', !!init && init.meta?.agentId === wid,
      init ? `pid=${init.meta.pid} running=${init.running}` : 'no init')
    await pollUntil(() => t.frames.length > 0 ? true : null, 15_000, 200)
    const types = t.frameTypes()
    check('T2 实时帧到达(omp 会话事件镜像)', t.frames.length > 0, `frames=${t.frames.length} types=${[...types].slice(0, 6).join(',')}`)

    // ===== 等任务回合结束(拿到可注入的空闲态) =====
    const taskDone = await pollUntil(async () => {
      const tasks = await api('GET', `/api/workshop/channels/${cid}/tasks`)
      const st = tasks.find(x => x.id === task.id)?.state
      return ['COMPLETED', 'FAILED', 'CANCELED'].includes(st) ? st : null
    }, 120_000, 1000)
    check('T1b 任务到达终态(真 LLM 执行)', !!taskDone, `state=${taskDone ?? 'timeout'}(LLM 不可用时为 FAILED,链路验证仍有效)`)

    // ===== T3:Web 输入控制(follow_up 注入真实会话) =====
    console.log('\n--- T3:Web 输入控制(input → omp 会话新回合) ---')
    // 待应答 HITL 对话框会阻塞后续 prompt:先以 cancelled 应答(人类控制闭环)
    const uiReq = [...t.frames].reverse().find(f => f.frame?.type === 'extension_ui_request' && f.frame.id)
    if (uiReq) {
      t.send({ type: 'ui_response', id: uiReq.frame.id, cancelled: true })
      check('T3 待应答 HITL 对话框 → ui_response 应答', true, `method=${uiReq.frame.method} id=${String(uiReq.frame.id).slice(0, 8)}`)
    }
    else {
      check('T3 无待应答 HITL 对话框(直接注入)', true)
    }
    const beforeHuman = t.frames.filter(f => f.frame?.type === '__human_input').length
    t.send({ type: 'input', text: '请只回复两个字:收到' })
    const humanEcho = await pollUntil(() =>
      t.frames.filter(f => f.frame?.type === '__human_input').length > beforeHuman ? true : null, 8_000, 200)
    check('T3 input 注入回显(__human_input 帧)', !!humanEcho)
    // omp 应答 follow_up/steer(response.success)并驱动真实回合:
    // follow_up 回合以 message_start/turn_start 起(agent_start 可能延后),取任一信号
    const beforeN = t.frames.filter(f => ['agent_start', 'turn_start', 'message_start'].includes(f.frame?.type)).length
    const newTurn = await pollUntil(() => {
      const ok = t.frames.filter(f => f.frame?.type === 'response' && (f.frame.command === 'follow_up' || f.frame.command === 'steer') && f.frame.success).length > 0
      const turnStarted = t.frames.filter(f => ['agent_start', 'turn_start', 'message_start'].includes(f.frame?.type)).length > beforeN
      return ok && turnStarted ? true : null
    }, 150_000, 800)
    check('T3 omp 会话响应输入驱动真实回合(follow_up success + 新回合帧)', !!newTurn)

    // ===== T4:abort 控制 =====
    console.log('\n--- T4:abort 回合控制 ---')
    // 若上一回合仍在流式,abort 立即生效;否则先注入再立刻 abort
    t.send({ type: 'abort' })
    // abort 接受判据:无 term.error,且回合收尾(turn_end/agent_end)或中止留痕在 30s 内出现
    const abortEffect = await pollUntil(() => {
      if (t.err) return 'error'
      return t.frames.some(f => f.frame?.type === '__terminal_notice' && String(f.frame.message ?? '').includes('中止'))
        || (() => {
          const idx = t.frames.map(f => f.frame?.type).lastIndexOf('turn_end')
          return idx >= 0 && t.frames.slice(idx).some(f => f.frame?.type === 'agent_end')
        })()
        ? 'effect'
        : null
    }, 30_000, 500)
    check('T4 abort 指令被服务端接受并产生回合收尾', abortEffect === 'effect', abortEffect === 'error' ? `err=${t.err?.code}` : 'ok')
    const noticeSeen = t.frames.some(f => f.frame?.type === '__terminal_notice' && String(f.frame.message ?? '').includes('中止'))
    check('T4 abort 人类操作留痕(__terminal_notice)', noticeSeen)
    t.ws.close()

    // ===== 汇总:任务/消息产物 =====
    const tasks = await api('GET', `/api/workshop/channels/${cid}/tasks`)
    const tRow = tasks.find(x => x.id === task.id)
    console.log(`\n(任务终态:${tRow?.state};交付物 ${(tRow?.artifacts ?? []).length} 件)`)
  }
  finally {
    try {
      await api('DELETE', `/api/workshop/channels/${cid}`)
      console.log(`\n(测试 channel ${cid.slice(0, 8)} 已删除;omp 子进程随 channel 卸载终止)`)
    }
    catch (err) {
      console.log(`\n(清理失败:${err.message})`)
    }
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E 异常:', err.message)
  process.exit(1)
})
