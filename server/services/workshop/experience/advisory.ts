/**
 * 学习性护栏提示（WP-C2）—— advisory 层。
 *
 * 来源：**被拒的治理动作**（write_intent 审批驳回 / HITL 拒绝 / 设备 ACK 未证实）。
 * 这些是"系统明确说过不行"的事实，归纳成 ≤3 条提示注入 prompt，降低重复踩坑。
 *
 * 纪律（与 Harness²/DBR 对齐）：
 *  - **advisory only**：执行闸门（write_intent/HITL/回读/限界）一行不改，本层只影响提示；
 *  - 硬预算：≤3 条、≤200 tok（estimateTokens 口径），且不同时挤占记忆注入预算；
 *  - sanitizer：剥掉工具调用语法/代码块/引号内命令，防提示注入把"提示"变成"指令"；
 *  - 30 天保鲜：过期的教训不再注入（工况会变，旧教条有害）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { estimateTokens } from '../runtime/memory/helpers'

/** advisory 硬预算（代码常量；改动走评审） */
export const ADVISORY = {
  maxItems: 3,
  maxTokens: 200,
  freshDays: 30,
} as const

export interface AdvisoryItem {
  /** 来源：审批驳回 / HITL 拒绝 / ACK 未证实 */
  source: 'approval' | 'hitl' | 'ack'
  /** 归纳后的提示行（已 sanitize） */
  text: string
}

/** 危险模式：工具调用语法 / 代码块 / 指令性前缀 —— 一律剥离 */
const DANGER_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g,
  /\b[a-z][a-z0-9_]{2,}\s*\([^)]*\)/gi, // fn(...)
  /\btool\s*[:=]\s*\S*/gi,
  /\{\s*"[^"]+"\s*:/g, // JSON 片段
  /<\s*\/?\s*[a-z][^>]*>/gi, // 伪标签
]

/** 指令性语气降级：把命令句改写成经验陈述（保留信息，不保留祈使） */
const IMPERATIVE: Array<[RegExp, string]> = [
  [/^\s*(请|必须|务必|立即|不要|禁止|切勿)\s*/g, ''],
  [/\s*(请|必须|务必|立即)\s*(调用|执行|下发|写入)/g, ' 避免 $2'],
]

/** sanitize 单条提示：剥危险语法 + 归一空白 + 截断 */
export function sanitizeAdvisory(raw: string, maxChars = 120): string {
  let text = String(raw ?? '')
  for (const re of DANGER_PATTERNS) text = text.replace(re, ' ')
  for (const [re, rep] of IMPERATIVE) text = text.replace(re, rep)
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`
  return text
}

/**
 * 采集本频道的被拒事实（只读，30 天窗口）。
 *  - project_approvals(kind='write_intent', status='rejected') → decision_reason
 *  - hitl_requests(status='rejected') → title/detail
 *  - intervention_events(ack IN ('unverified','transport-ack')) → 节点名 + 原因
 */
export function collectAdvisories(db: DatabaseSync, channelId: string, now = new Date()): AdvisoryItem[] {
  const since = new Date(now.getTime() - ADVISORY.freshDays * 86_400_000).toISOString()
  const items: AdvisoryItem[] = []
  try {
    // project_approvals 无 channel 列 → 经 projects.office_channel_id 收窄(防跨频道串味)
    const approvals = db.prepare(
      `SELECT a.decision_reason AS reason
         FROM project_approvals a JOIN projects p ON p.id = a.project_id
        WHERE a.kind = 'write_intent' AND a.status = 'rejected' AND a.created_at >= ?
          AND p.office_channel_id = ?
        ORDER BY a.decided_at DESC LIMIT 10`,
    ).all(since, channelId) as Array<{ reason: string }>
    for (const a of approvals) {
      const text = sanitizeAdvisory(a.reason || '写入意图被驳回（未附原因）')
      if (text) items.push({ source: 'approval', text: `写入审批被驳回：${text}` })
    }
  }
  catch { /* 表/列缺失或旧库：跳过 */ }
  try {
    const hitl = db.prepare(
      `SELECT title, detail FROM hitl_requests
        WHERE channel_id = ? AND status = 'rejected' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 10`,
    ).all(channelId, since) as Array<{ title: string, detail: string }>
    for (const h of hitl) {
      const text = sanitizeAdvisory(h.detail || h.title || '人工拒绝了本次操作')
      if (text) items.push({ source: 'hitl', text: `人工拒绝：${text}` })
    }
  }
  catch { /* 同上 */ }
  try {
    const acks = db.prepare(
      `SELECT node_name AS nodeName, ack FROM intervention_events
        WHERE channel_id = ? AND ack IN ('unverified', 'transport-ack') AND ts >= ?
        ORDER BY ts DESC LIMIT 10`,
    ).all(channelId, since) as Array<{ nodeName: string, ack: string }>
    for (const a of acks) {
      const text = sanitizeAdvisory(`节点「${a.nodeName || '?'}」写入仅链路受理/未证实（ACK=${a.ack}），复测后再判读`)
      if (text) items.push({ source: 'ack', text })
    }
  }
  catch { /* 同上 */ }
  return items
}

/**
 * 生成注入块（≤3 条 / ≤200 tok）。
 * 去重（同文案只留一条）+ 按来源优先级（审批/HITL 的事实强于 ACK）+ 预算截断。
 * 空集返回 ''（prompt 零改动）。
 */
export function advisoryBlock(db: DatabaseSync, channelId: string, opts: { now?: Date } = {}): string {
  const items = collectAdvisories(db, channelId, opts.now)
  if (items.length === 0) return ''
  const seen = new Set<string>()
  const picked: string[] = []
  for (const item of items) {
    if (seen.has(item.text)) continue
    seen.add(item.text)
    picked.push(item.text)
    if (picked.length >= ADVISORY.maxItems) break
  }
  if (picked.length === 0) return ''
  const head = '## 操作提示（advisory：来自被驳回/未证实的操作，执行闸门不变）'
  const lines: string[] = []
  let used = estimateTokens(head)
  for (const text of picked) {
    const line = `- ${text}`
    const cost = estimateTokens(line)
    if (used + cost > ADVISORY.maxTokens) break
    used += cost
    lines.push(line)
  }
  if (lines.length === 0) return ''
  return [head, ...lines].join('\n')
}
