/* eslint-disable */
/* eslint-disable @stylistic/max-statements-per-line */
/**
 * Channel 实时输出捕获 —— 连 AEP WS hub,把 Agent 执行过程渲染成可读时间线。
 * 用法: AW_TOKEN=... AW_CHANNEL=... AW_OUT=<file> node aep-live.mjs [监听毫秒]
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const wsPath = join(here, '..', 'node_modules', '.pnpm', 'ws@8.21.3', 'node_modules', 'ws', 'index.js')
const { default: WebSocket } = await import(pathToFileURL(wsPath).href)

const token = process.env.AW_TOKEN ?? ''
const channelId = process.env.AW_CHANNEL ?? ''
const out = process.env.AW_OUT ?? 'aep-live.log'
const listenMs = Number(process.argv[2] ?? 600000)
const stamp = () => new Date().toISOString().slice(11, 23)

const ws = new WebSocket(`ws://127.0.0.1:3001/api/workshop/ws?channelId=${channelId}&token=${encodeURIComponent(token)}`)
const render = (line) => {
  appendFileSync(out, line + '\n')
}

ws.on('open', () => render(`[${stamp()}] === AEP 已连接 channel=${channelId.slice(0, 8)} ===`))
ws.on('message', (d) => {
  let f
  try { f = JSON.parse(d.toString()) }
  catch { return }
  const t = f.type
  const p = f.payload ?? {}
  if (t === 'agent.delta') {
    // 流式打字增量:不换行追加太碎,按帧落一行 60 字内摘要由聚合器合并;这里原样落盘
    render(`[delta] ${p.delta ?? ''}`)
  }
  else if (t === 'agent.message') {
    const parts = p.parts ?? []
    for (const part of parts) {
      if (part.text) render(`\n[${stamp()}] 💬 ${part.text.slice(0, 2000)}`)
    }
  }
  else if (t === 'agent.status.message') render(`[${stamp()}] ℹ️  ${p.text ?? ''}`)
  else if (t === 'agent.status') render(`[${stamp()}] ⚙️  agent=${String(p.agentId ?? '').slice(0, 8)} status=${p.status ?? ''}`)
  else if (t === 'task.status') render(`\n[${stamp()}] 📋 task=${String(p.taskId ?? p.id ?? '').slice(0, 8)} → ${p.state ?? ''}${p.progress != null ? ` (${p.progress}%)` : ''}`)
  else if (t === 'task.progress') render(`[${stamp()}] 📊 task=${String(p.taskId ?? '').slice(0, 8)} ${p.progress ?? ''}%`)
  else if (t === 'a2a.artifact') render(`\n[${stamp()}] 📦 artifact: ${JSON.stringify(p.artifact ?? p).slice(0, 800)}`)
  else if (t === 'hitl.request' || t === 'hitl.pending') render(`\n[${stamp()}] 🙋 HITL 待办: ${JSON.stringify(p).slice(0, 300)}`)
  else if (t === 'hitl.resolved') render(`\n[${stamp()}] ✅ HITL 已裁决: ${JSON.stringify(p).slice(0, 300)}`)
  else if (t === 'channel.snapshot') render(`[${stamp()}] === 快照对齐(忽略) ===`)
  else if (t === 'error') render(`[${stamp()}] ❌ ${p.code}: ${p.message}`)
  // 其余类型静默
})
ws.on('close', () => render(`[${stamp()}] === AEP 断开 ===`))
ws.on('error', e => render(`[${stamp()}] === WS 错误: ${e.message} ===`))

setTimeout(() => {
  render(`[${stamp()}] === 捕获结束 ===`)
  process.exit(0)
}, listenMs)
