/**
 * 小镇事件语义映射(AEP → 可渲染指令)。
 *
 * 纯函数,零 Phaser 依赖:把 workshop 的 AEP 信封翻译成小镇场景能消费的
 * 渲染意图(spawn/update agent、头顶气泡、进度更新、错误警示)。让
 * TownScene 保持"只渲染"的单一职责,映射逻辑可独立单测。
 */
import type { AepEnvelope } from './workshop-protocol'
import type { A2AArtifact } from '../server/services/workshop/types/a2a'

/** 气泡种类:决定气泡外观(信息/交付/错误/系统) */
export type TownBubbleKind = 'info' | 'artifact' | 'error' | 'system'

/** 可直接渲染的头顶气泡意图 */
export interface TownBubble {
  channelId: string
  /** 气泡归属 agent(空 = 广播/系统气泡,挂在街区入口) */
  agentId?: string
  kind: TownBubbleKind
  text: string
  /** 气泡存活时长 ms */
  ttlMs: number
}

/** 一帧 AEP 的事件意图(命中才返回;未命中返回 null) */
export interface TownEventIntent {
  channelId: string
  /** 需要刷新进度/状态的目标 agent(可能为 'system' 或空) */
  agentId?: string
  bubble?: TownBubble
}

/** Part → 纯文本(与 useEventBlocks.textOf 同口径,供气泡/交付物预览) */
function partsToText(parts: Array<{ text?: string } | { data?: unknown }>): string {
  return parts
    .map(p => 'text' in p ? (p.text ?? '') : 'data' in p ? JSON.stringify(p.data) : '')
    .join('\n')
    .trim()
}

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 交付物名(缺省用任务短 id) */
function artifactName(a: A2AArtifact): string {
  return a.name?.trim() ? a.name : (a.artifactId ?? '').slice(0, 6)
}

/** 事件 → 气泡意图(命中 TODO 展示类事件才产生气泡) */
export function eventToBubble(e: AepEnvelope): TownBubble | null {
  switch (e.type) {
    case 'agent.message': {
      const msg = e.payload as { parts?: Array<{ text?: string }> }
      const t = partsToText(msg.parts ?? [])
      return t ? { channelId: e.channelId, agentId: e.agentId, kind: 'info', text: truncate(t, 220), ttlMs: 3600 } : null
    }
    case 'agent.status.message': {
      const text = String((e.payload as { text?: string }).text ?? '')
      if (!text) return null
      return { channelId: e.channelId, agentId: e.agentId, kind: 'info', text: truncate(text, 220), ttlMs: 2600 }
    }
    case 'a2a.message': {
      const msg = e.payload as { parts?: Array<{ text?: string }> }
      const t = partsToText(msg.parts ?? [])
      return t ? { channelId: e.channelId, agentId: e.agentId, kind: 'info', text: truncate(t, 200), ttlMs: 3200 } : null
    }
    case 'a2a.artifact': {
      const p = e.payload as { artifact?: A2AArtifact }
      const a = p?.artifact
      if (!a) return null
      const body = partsToText((a.parts ?? []) as Array<{ text?: string } | { data?: unknown }>)
      return {
        channelId: e.channelId,
        agentId: e.agentId,
        kind: 'artifact',
        text: `交付「${artifactName(a)}」${body ? ` · ${truncate(body, 120)}` : ''}`,
        ttlMs: 3200,
      }
    }
    case 'error': {
      const p = e.payload as { code?: string, message?: string }
      return { channelId: e.channelId, agentId: e.agentId, kind: 'error', text: `⚠ ${p.code ?? 'ERROR'} ${truncate(p.message ?? '', 160)}`, ttlMs: 4200 }
    }
    default:
      return null
  }
}

/**
 * 主入口:一帧 AEP → 事件意图。
 * 负责:更新类事件标记 agentId;展示类事件生成气泡;task.progress 单独由
 * 场景从 entities 读进度(此处只回传 agentId 让场景刷新进度环)。
 */
export function mapEnvelopeToIntent(e: AepEnvelope): TownEventIntent | null {
  const bubble = eventToBubble(e)
  switch (e.type) {
    case 'agent.status':
    case 'agent.member':
    case 'task.status':
    case 'task.progress':
      return { channelId: e.channelId, agentId: e.agentId, bubble: bubble ?? undefined }
    case 'agent.message':
    case 'agent.status.message':
    case 'a2a.message':
    case 'a2a.artifact':
    case 'error':
      return { channelId: e.channelId, agentId: e.agentId, bubble: bubble ?? undefined }
    default:
      return null
  }
}
