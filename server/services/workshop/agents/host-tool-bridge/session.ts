/**
 * 会话态构造与消息文本提取(原 host-tool-bridge.ts 的模块级纯函数,按行搬运)。
 */
import type { Part } from '../../types/a2a'
import type { HostToolSessionState } from './types'

export function createSessionState(): HostToolSessionState {
  return { currentTaskId: null, replyContext: null }
}

/** 从消息 parts 提取纯文本(多 harness 共用) */
export function partsToText(parts: Part[]): string {
  return parts
    .map((p) => {
      if ('text' in p) return p.text
      if ('data' in p) return JSON.stringify(p.data)
      if ('url' in p) return p.url
      if ('raw' in p) return p.raw
      return ''
    })
    .join('\n')
}
