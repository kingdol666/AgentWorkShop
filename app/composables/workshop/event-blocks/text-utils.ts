/**
 * 文本口径与流文本构建:事件正文提取 / 统一化空白比较 / 落定折回关系 /
 * 流块可见文本与光标可见性。
 *
 * 注:`taskIdOf` / `taskCompatible` / `foldRelation` / `textOf` 仅供本包内部模块
 * (clusterer / fold-stream)复用,不经门面 `../useEventBlocks` 导出。
 */
import type { AepEnvelope } from '#shared/workshop-protocol'
import type { EventBlock } from './types'

/** 统一化空白比较 */
export function normText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 流块当前是否处于打字机状态(尾巴是 delta 且未落定) */
export function isStreaming(block: EventBlock): boolean {
  const ev = block.events[block.events.length - 1]
  if (!ev) return false
  return ev.type === 'agent.delta' && !block.settled
}

/** 任务语义类的 taskId(信封 taskId 优先) */
export function taskIdOf(e: AepEnvelope): string | null {
  if (e.taskId) return e.taskId
  switch (e.type) {
    case 'task.status':
    case 'task.progress':
      return String((e.payload as { taskId?: string }).taskId ?? '') || null
    case 'a2a.artifact':
      return String((e.payload as { taskId?: string }).taskId ?? '') || null
    default:
      return null
  }
}

/** 合并键内 taskId 兼容:单侧缺省视为无约束 */
export function taskCompatible(a: string | null, b: string | null): boolean {
  return a == null || b == null || a === b
}

/** 落定文本与累计水路的关系 */
export function foldRelation(trail: string, short: string): 'dup' | 'extend' | 'none' {
  const t = trail.trim()
  const s = short.trim()
  if (!t || !s) return 'none'
  if (t === s || normText(t) === normText(s)) return 'dup'
  if (s.startsWith(t)) return 'extend'
  return 'none'
}

/** 事件正文(delta/status.text/message.parts/artifact.parts) */
export function textOf(e: AepEnvelope): string {
  switch (e.type) {
    case 'agent.delta':
      return String((e.payload as { delta?: string }).delta ?? '')
    case 'agent.status.message':
      return String((e.payload as { text?: string }).text ?? '')
    case 'agent.message':
    case 'a2a.message': {
      const parts = (e.payload as { parts?: Array<{ text?: string }> }).parts ?? []
      return parts.map(p => p.text ?? '').join('\n')
    }
    case 'a2a.artifact': {
      const ap = (e.payload as { artifact?: { parts?: Array<{ text?: string }> } }).artifact?.parts ?? []
      return ap.map(p => p.text ?? '').join('\n')
    }
    default:
      return ''
  }
}

/** 流块的最终可见文本(delta 累计;落定帧不重复该文) */
export function buildStreamText(block: EventBlock): string {
  if (block.overrideText) return block.overrideText
  let acc = ''
  for (const e of block.events) {
    if (e.type === 'agent.delta') {
      acc += textOf(e)
      continue
    }
    // message/status 落定帧:序列不割裂,但内容重复部分不自渲染(重复判定归聚类器)
    if (e.type === 'agent.status.message') continue
    if (e.type === 'agent.message') {
      const t = textOf(e).trim()
      if (t) acc = `${acc ? `${acc}\n` : ''}${t}`
      continue
    }
    // 任务落定 / 交付物不自成为流文本
  }
  return acc
}

/**
 * 打字光标可见性(空光标闪烁修复的权威语义):
 * 仅当"已有文本 &&(流式未落定 || 揭示未追平)"时显示;空文本块绝不显示光标。
 */
export function streamCursorVisible(fullLen: number, visibleLen: number, streaming: boolean): boolean {
  return fullLen > 0 && (streaming || visibleLen < fullLen)
}
