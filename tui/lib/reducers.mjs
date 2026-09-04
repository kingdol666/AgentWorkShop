// ============================================================
// AEP 帧归约(纯函数式:输入 state+信封 → 原地更新 state 与 log 行)。
// 与 WebUI 的 events.store 同一套语义:agent.delta 聚合进流式块,落定
// agent.message 携带全文定稿(去重);hitl 增删幂等(kind+id)。
// 可被 tsx/单测与 scripts/tui-smoke.mjs 无头驱动。
// ============================================================
import { pushLog } from './state.mjs'

const STREAM_TAIL = 4000

/** 从信封/消息提取展示名 */
function agentNameOf(state, agentId, fallback = '') {
  if (!agentId) return fallback
  const a = state.agents.find(x => x.id === agentId)
  return a?.name ?? fallback ?? agentId.slice(0, 8)
}

/** 消息 parts → 纯文本 */
function partsText(message) {
  const parts = message?.parts ?? []
  return parts.map((p) => {
    if (typeof p === 'string') return p
    if (p && typeof p === 'object' && typeof p.text === 'string') return p.text
    return ''
  }).join('').trim()
}

/**
 * 归约一帧 AEP 信封。返回 'handled' | 'ignored'(测试断言用)。
 * 流式块键 = agentId+taskId(agent.message 到达即定稿替换全文)。
 */
export function reduceEnvelope(state, e) {
  switch (e.type) {
    case 'agent.status': {
      const p = e.payload
      state.agentStates[p.agentId] = {
        state: p.state,
        currentTaskId: p.currentTaskId ?? null,
        queued: p.queued ?? 0,
        completed: p.completed ?? 0,
      }
      return 'handled'
    }
    case 'agent.delta': {
      const text = e.payload?.delta ?? ''
      if (!text) return 'ignored'
      const row = findStreamRow(state, e.agentId, e.taskId)
      if (row) {
        row.text = (row.text + text).slice(-STREAM_TAIL)
      }
      else {
        pushLog(state, 'stream', text, { agentName: agentNameOf(state, e.agentId), agentId: e.agentId, taskId: e.taskId ?? null })
      }
      return 'handled'
    }
    case 'agent.message': {
      const msg = e.payload ?? {}
      const text = partsText(msg)
      if (!text) return 'ignored'
      const agentId = e.agentId ?? msg.metadata?.['x-aw-from-agent'] ?? ''
      const name = agentNameOf(state, agentId, msg.metadata?.['x-aw-from-label'] ?? '')
      const row = findStreamRow(state, agentId, e.taskId)
      if (row) {
        // 定稿:流式增量替换为全文,并升级为正式 agent 行(渲染带名高亮)
        row.text = text
        row.kind = 'agent'
        row.agentName = name
      }
      else {
        pushLog(state, 'agent', text, { agentName: name, agentId, taskId: e.taskId ?? null })
      }
      return 'handled'
    }
    case 'a2a.message': {
      const msg = e.payload ?? {}
      const meta = msg.metadata ?? {}
      const fromLabel = meta['x-aw-from-label'] ?? ''
      const fromAgent = meta['x-aw-from-agent'] ?? e.agentId ?? ''
      const text = partsText(msg)
      if (!text) return 'ignored'
      const cross = meta['x-aw-cross-channel'] === 'true'
      const prefix = cross ? '[跨频道] ' : ''
      if (fromAgent) {
        pushLog(state, 'agent', prefix + text, { agentName: agentNameOf(state, fromAgent, fromLabel), agentId: fromAgent, taskId: msg.taskId ?? null })
      }
      else {
        // 人类消息(服务端盖章 from-label;本端发出的回显也走这里)
        pushLog(state, 'user', prefix + text, { agentName: fromLabel || '用户' })
      }
      return 'handled'
    }
    case 'agent.status.message': {
      const text = (e.payload?.text ?? '').trim()
      if (text) pushLog(state, 'notice', text, { agentName: agentNameOf(state, e.agentId) })
      return 'handled'
    }
    case 'task.status': {
      const p = e.payload ?? {}
      upsertTask(state, p)
      const title = p.title ?? state.tasks.find(t2 => t2.taskId === p.taskId)?.title ?? ''
      pushLog(state, 'task', `任务 ${p.taskId?.slice(0, 8)}${title ? `「${title}」` : ''} → ${p.state}${p.progress != null ? ` ${p.progress}%` : ''}`)
      return 'handled'
    }
    case 'task.progress': {
      const p = e.payload ?? {}
      upsertTask(state, p)
      return 'handled'
    }
    case 'a2a.artifact': {
      const art = e.payload?.artifact
      const name = art?.name ?? art?.kind ?? 'artifact'
      pushLog(state, 'notice', `交付物:${name}`, { agentName: agentNameOf(state, e.agentId) })
      return 'handled'
    }
    case 'error': {
      pushLog(state, 'error', e.payload?.message ?? '未知错误', { agentName: agentNameOf(state, e.agentId) })
      return 'handled'
    }
    case 'hitl.request': {
      upsertHitl(state, e.payload)
      const it = e.payload
      pushLog(state, 'hitl', `⏸ 需要人工处理:${it.title}(${it.agentName})—— /hitl 查看并作答`)
      return 'handled'
    }
    case 'hitl.resolved': {
      const r = e.payload
      state.hitl = state.hitl.filter(i => !(i.kind === r.kind && i.id === r.id))
      if (state.hitlAnswering && state.hitlAnswering.kind === r.kind && state.hitlAnswering.id === r.id) state.hitlAnswering = null
      pushLog(state, 'hitl-resolved', `✔ 待办已落定:${r.id}(outcome=${r.outcome}${r.by ? `, by ${r.by}` : ''})`)
      return 'handled'
    }
    default:
      return 'ignored'
  }
}

function findStreamRow(state, agentId, taskId) {
  for (let i = state.log.length - 1; i >= 0; i--) {
    const row = state.log[i]
    if (row.kind === 'stream' && row.agentId === agentId && (row.taskId ?? null) === (taskId ?? null)) return row
  }
  return null
}

function upsertTask(state, p) {
  if (!p.taskId) return
  const idx = state.tasks.findIndex(t => t.taskId === p.taskId)
  if (idx >= 0) state.tasks[idx] = { ...state.tasks[idx], ...p }
  else state.tasks.unshift(p)
  state.tasks = state.tasks.slice(0, 100)
}

function upsertHitl(state, item) {
  if (!item?.id) return
  const idx = state.hitl.findIndex(i => i.kind === item.kind && i.id === item.id)
  if (idx >= 0) state.hitl[idx] = item
  else state.hitl.push(item)
}

// ===== 终端镜像帧 → monitor 行(纯部分;ws 接线在 aw-tui) =====

/** term 帧 → monitor 行描述;返回 { lines:[{text,tone}], streamAppend?, streamEnd?, statePatch? } */
export function reduceTermFrame(frame) {
  const out = { lines: [], streamAppend: '', streamEnd: null, statePatch: null }
  const type = frame?.type
  switch (type) {
    case 'agent_start':
      out.lines.push({ text: '── 回合开始 ──', tone: 'dim' })
      break
    case 'agent_end':
      out.lines.push({ text: '── 回合结束 ──', tone: 'dim' })
      break
    case 'message_end': {
      const text = String(frame.text ?? '').trim()
      if (text) out.lines.push({ text, tone: 'monitor' })
      break
    }
    case 'tool_execution_start':
      out.lines.push({ text: `🔧 ${frame.toolName ?? ''}${brief(frame.args, 80)}`, tone: 'info' })
      break
    case 'tool_execution_end':
      out.lines.push({ text: `${frame.isError ? '✗' : '✔'} ${frame.toolName ?? ''}${brief(frame.result, 120)}`, tone: frame.isError ? 'error' : 'dim' })
      break
    case 'host_tool_call':
      out.lines.push({ text: `🛠 host ${frame.toolName ?? ''}${brief(frame.args, 80)}`, tone: 'info' })
      break
    case 'extension_ui_request':
      if (frame.method && frame.method !== 'cancel') {
        out.lines.push({ text: `⏸ HITL ${frame.method}「${String(frame.title ?? '').slice(0, 60)}」(/hitl 作答)`, tone: 'warn' })
      }
      break
    case '__human_input':
      out.lines.push({ text: `⌨ ${String(frame.text ?? '').slice(0, 120)}`, tone: 'info' })
      break
    case '__terminal_notice':
      out.lines.push({ text: String(frame.message ?? ''), tone: frame.level === 'error' ? 'error' : frame.level === 'warning' ? 'warn' : 'dim' })
      break
    default:
      break
  }
  return out
}

function brief(value, max) {
  if (value == null) return ''
  let s = typeof value === 'string'
    ? value
    : (() => {
        try {
          return JSON.stringify(value) ?? ''
        }
        catch {
          return String(value)
        }
      })()
  s = s.replace(/\s+/g, ' ').trim()
  return s ? ` ${s.slice(0, max)}${s.length > max ? '…' : ''}` : ''
}
