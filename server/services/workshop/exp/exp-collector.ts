/**
 * exp-collector —— 经验采集器(产线 Co-Pilot P1;确定性,无 LLM)。
 *
 * collectEpisodes(lineId) 每轮两路(计划 §5.1):
 *  1. 平台动作(必有证据):锚账本增量(listAnchorsSince:at 水位 + seenAnchorIds 双保险)
 *     → episode 聚合(同 recipeRunId 归一个;无 runId 按 nodeId+±60s 时间簇)
 *     → audit_log 交叉归因(targetId+时间窗;写审计新值字段是 `eng`,旧值 prevValue)
 *     → approval_history 按 nodeId+时间窗拼人类意见 → status=pending 落 exp-state(哈希去重)。
 *  2. 推断动作·主路:逐 dcw 节点 readNow 取当前 SET,与 exp-state 上轮快照 diff ——
 *     SET 变化 且 ±60s 内该节点无锚记录 → 入待确认队列(铁律 9:人工确认后才转 episode)。
 *     首轮无快照只建快照不推断。
 *
 * SP 序列增强路(计划 §5.1 增强项):本期留 TODO 结构 —— sp 语义位节点若存在同 key
 * daq 节点则跳过快照 diff(将来由 tsdb raw 序列阶跃检测覆盖,避免双路重复归因)。
 *
 * 时间源统一 Date.now();单节点读取失败(离线等)跳过不阻塞整轮。
 */
import type { DcwJournalAnchor } from '../../../../shared/dcw-protocol'
import type { ExpConfirmation, ExpEpisode, ExpNodeSnapshot, ExpWatermark } from './exp-state.repo'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { getDcwController } from '../dcw/dcw-controller'
import { getDcwNodeRepo } from '../dcw/dcw-node.repo'
import { getRecipeRollBackRepo } from '../dcw/recipe-rollback.repo'
import { getOps } from '../ops/ops'
import { getExpStateRepo } from './exp-state.repo'

/** 无 runId 锚的时间簇窗口(±60s;计划 §5.1) */
export const CLUSTER_MS = 60_000
/** 推断判定的"平台无写入"回看窗(±60s) */
export const ANCHOR_WINDOW_MS = 60_000
/** 审计/审批意见交叉窗的外扩缓冲 */
const AUDIT_SLACK_MS = 60_000
/** SET 变化判定阈值(节点值已按 decimals 取整,浮点噪声用 epsilon 吸收) */
const SET_EPSILON = 1e-9

/** episode 草稿(recordEpisodes 前的中间形态;untilAt 仅归因窗计算用,不入库) */
export type ExpEpisodeDraft = Omit<ExpEpisode, 'id' | 'lineId' | 'status' | 'hash'> & { untilAt?: string }

/** 锚写来源 → episode 来源归因(rollback 恢复归入配方/系统路径) */
function srcOf(source: string): 'manual' | 'agent' | 'recipe' {
  return source === 'manual' ? 'manual' : source === 'agent' ? 'agent' : 'recipe'
}

function actorKindOf(source: string): 'user' | 'agent' | 'system' {
  return source === 'manual' ? 'user' : source === 'agent' ? 'agent' : 'system'
}

/**
 * 水位过滤(纯):at 水位粗筛 + 已见锚 id 精剔。
 * 锚 id 是 UUID 非单调、cap 头部淘汰会使 index 型水位漂移,故必须双字段(计划 §2.1)。
 */
export function unseenAnchorsSince(anchors: DcwJournalAnchor[], wm: ExpWatermark): DcwJournalAnchor[] {
  const seen = new Set(wm.seenAnchorIds)
  return anchors.filter((a) => {
    if (seen.has(a.id)) return false
    return Date.parse(a.at) >= wm.lastAnchorAt
  })
}

/** 单组锚 → episode 草稿(组内已按时间正序;来源取簇内主导写来源) */
function draftOf(lineId: string, group: DcwJournalAnchor[]): ExpEpisodeDraft {
  const hasManual = group.some(a => a.source === 'manual')
  const hasAgent = group.some(a => a.source === 'agent')
  const source = hasManual ? 'manual' : hasAgent ? 'agent' : 'recipe'
  const anchorForActor = group.find(a => srcOf(a.source) === source) ?? group[0]!
  return {
    nodeIds: [...new Set(group.map(a => a.nodeId))],
    kind: 'platform',
    source: srcOf(source),
    actor: anchorForActor.actor,
    actorKind: actorKindOf(source),
    params: group.map(a => ({ nodeId: a.nodeId, from: a.prevValue, to: a.newValue })),
    at: group[0]!.at,
    untilAt: group[group.length - 1]!.at,
    anchors: group.map(a => a.id),
    auditIds: [],
    comments: [],
  }
}

/**
 * 锚 → episode 草稿聚合(纯):
 *  - 同 recipeRunId 的锚(跨节点/跨时刻)归一个 episode(一次配方下发是一笔动作);
 *  - 无 runId 的锚按 nodeId 分组后 ±clusterMs 时间簇归并(一次手动连调是同一动作)。
 */
export function aggregateAnchorsToEpisodes(lineId: string, anchors: DcwJournalAnchor[], opts: { clusterMs?: number } = {}): ExpEpisodeDraft[] {
  const clusterMs = opts.clusterMs ?? CLUSTER_MS
  const sorted = [...anchors].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  const drafts: ExpEpisodeDraft[] = []
  const byRun = new Map<string, DcwJournalAnchor[]>()
  const byNode = new Map<string, DcwJournalAnchor[]>()
  for (const a of sorted) {
    if (a.recipeRunId) {
      const arr = byRun.get(a.recipeRunId)
      if (arr) arr.push(a)
      else byRun.set(a.recipeRunId, [a])
    }
    else {
      const arr = byNode.get(a.nodeId)
      if (arr) arr.push(a)
      else byNode.set(a.nodeId, [a])
    }
  }
  for (const group of byRun.values()) drafts.push(draftOf(lineId, group))
  for (const group of byNode.values()) {
    let cur: DcwJournalAnchor[] = []
    for (const a of group) {
      if (cur.length > 0 && Date.parse(a.at) - Date.parse(cur[0]!.at) > clusterMs) {
        drafts.push(draftOf(lineId, cur))
        cur = []
      }
      cur.push(a)
    }
    if (cur.length > 0) drafts.push(draftOf(lineId, cur))
  }
  return drafts
}

/** SP 语义位冷启动推断:模板 key 含 '-sp'(如 `reactor-temp-sp`)视为设定值语义,其余 PV */
export function inferSemantic(templateKey: string): 'sp' | 'pv' {
  return templateKey.toLowerCase().includes('-sp') ? 'sp' : 'pv'
}

/**
 * 快照 diff(纯):上轮 vs 本轮都读到的节点里,SET 变化(|Δ|>epsilon)且 ±窗内无锚
 * → 推断"本地调整"候选(入待确认队列,由人工裁决)。
 */
export function diffSnapshot(
  prev: Record<string, ExpNodeSnapshot>,
  current: Record<string, ExpNodeSnapshot>,
  anchoredNodeIds: Set<string>,
  opts: { epsilon?: number } = {},
): Array<{ nodeId: string, from: number, to: number }> {
  const epsilon = opts.epsilon ?? SET_EPSILON
  const out: Array<{ nodeId: string, from: number, to: number }> = []
  for (const nodeId of Object.keys(prev).sort()) {
    const p = prev[nodeId]
    const c = current[nodeId]
    if (!p || !c) continue
    if (Math.abs(c.set - p.set) <= epsilon) continue
    if (anchoredNodeIds.has(nodeId)) continue
    out.push({ nodeId, from: p.set, to: c.set })
  }
  return out
}

/**
 * 平台动作归因增强(就地改写草稿):
 *  - audit_log 按 targetId+时间窗交叉:取写审计行 id(证据链)与 actor 归因
 *    (写审计 detail_json 新值字段为 `eng`、旧值 prevValue —— 本处仅用行级
 *    actor/actorKind,值以锚账本为准,锚有 prev/new 全量);
 *  - approval_history 按 nodeId+时间窗拼人类裁决意见(为什么这样调的语境)。
 * 审计/审批仓储未装配(getOps()=null,单测/降级)或查询异常时不阻塞采集。
 */
function enrichDraft(draft: ExpEpisodeDraft): void {
  const ops = getOps()
  if (!ops) return
  const fromMs = Date.parse(draft.at)
  const toMs = Date.parse(draft.untilAt ?? draft.at)
  const auditFrom = new Date(fromMs - AUDIT_SLACK_MS).toISOString()
  const auditTo = new Date(toMs + AUDIT_SLACK_MS).toISOString()
  const auditIds: string[] = []
  for (const nodeId of draft.nodeIds) {
    try {
      for (const r of ops.audit.query({ targetId: nodeId, from: auditFrom, to: auditTo, limit: 50 })) {
        if (!String(r.action).startsWith('dcw.write.')) continue
        auditIds.push(String(r.id))
        // 归因以审计为准(携带 actorName 人话名;锚账本只有 actor id)
        draft.actor = String(r.actor) || draft.actor
        draft.actorKind = r.actorKind === 'agent' ? 'agent' : r.actorKind === 'system' ? 'system' : 'user'
      }
    }
    catch { /* 单节点审计查询失败不阻塞 */ }
  }
  draft.auditIds = auditIds
  try {
    for (const h of ops.approvalHistory.list(200)) {
      if (!draft.nodeIds.includes(h.nodeId)) continue
      const t = Date.parse(h.createdAt)
      if (!Number.isFinite(t) || t < fromMs - AUDIT_SLACK_MS || t > toMs + AUDIT_SLACK_MS) continue
      if (h.comment) draft.comments.push(`${h.decidedName || h.decidedBy || '系统'}(${h.status}): ${h.comment}`)
    }
  }
  catch { /* 审批史不可用不阻塞采集 */ }
}

/**
 * 一轮经验采集(确定性;调用方=exp_collect 工具/学习 Channel 定时任务):
 * 平台动作入 pending episode + 推断动作入待确认队列,返回本轮增量与待确认计数。
 * 重复调用幂等:水位(at+已见 id)剔重,第二轮零新增(单测覆盖)。
 */
export async function collectEpisodes(lineId: string, opts: { nowMs?: number } = {}): Promise<{
  episodes: ExpEpisode[]
  confirmations: { added: number, pending: number }
}> {
  const state = getExpStateRepo()
  const nowMs = opts.nowMs ?? Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const wm = state.getWatermark(lineId)

  // ---- 1. 平台动作:锚账本增量 → 聚合 → 归因 → pending 落账 → 水位推进
  const fresh = unseenAnchorsSince(getRecipeRollBackRepo().listAnchorsSince(lineId, wm.lastAnchorAt), wm)
  const drafts = aggregateAnchorsToEpisodes(lineId, fresh)
  for (const d of drafts) enrichDraft(d)
  const episodes = state.recordEpisodes(lineId, drafts)
  if (fresh.length > 0) {
    const seen = new Set(wm.seenAnchorIds)
    let maxAt = wm.lastAnchorAt
    let maxAuditId = wm.lastAuditId
    for (const a of fresh) {
      seen.add(a.id)
      maxAt = Math.max(maxAt, Date.parse(a.at))
    }
    for (const e of episodes) {
      for (const id of e.auditIds) {
        const n = Number(id)
        if (Number.isFinite(n)) maxAuditId = Math.max(maxAuditId, n)
      }
    }
    state.setWatermark(lineId, { lastAnchorAt: maxAt, seenAnchorIds: [...seen], lastAuditId: maxAuditId })
  }

  // ---- 2. 推断动作·主路:dcw 读回快照 vs 上轮快照(diff;首轮只建快照)
  const rollback = getRecipeRollBackRepo()
  const anchoredNow = new Set(rollback.listAnchorsSince(lineId, nowMs - ANCHOR_WINDOW_MS).map(a => a.nodeId))
  const daqKeys = new Set(getDaqNodeRepo().all().filter(d => d.lineId === lineId).map(d => d.templateKey))
  const prev = state.getSnapshot(lineId)
  const current: Record<string, ExpNodeSnapshot> = { ...(prev ?? {}) }
  for (const node of getDcwNodeRepo().all()) {
    if (node.lineId !== lineId || !node.enabled) continue
    // 语义位冷启动(模板 key 推断;人工可后续改标)
    const meta = state.paramMetaGet(lineId, node.id)
    const semantic = meta?.semantic ?? inferSemantic(node.templateKey)
    if (!meta) state.paramMetaSet(lineId, node.id, semantic)
    // TODO(SP 序列增强路):sp 语义位且存在同 key daq 节点 → 本期跳过快照 diff,
    // 将来由 tsdb raw 序列阶跃检测覆盖(主路已注释局限:改了又改回的瞬变盲区)
    if (semantic === 'sp' && daqKeys.has(node.templateKey)) continue
    try {
      const r = await getDcwController().readNow(node.id)
      if (!r.ok || r.value == null) continue
      current[node.id] = { set: r.value, readAt: Date.parse(r.at) }
    }
    catch { /* 单节点失败(离线/驱动异常)跳过,不阻塞整轮 */ }
  }
  state.setSnapshot(lineId, current)
  let confirmAdded = 0
  if (prev) {
    for (const cand of diffSnapshot(prev, current, anchoredNow)) {
      const node = getDcwNodeRepo().byId(cand.nodeId)
      const res = state.addConfirmation({
        lineId,
        nodeId: cand.nodeId,
        nodeName: node?.name ?? cand.nodeId,
        from: cand.from,
        to: cand.to,
        at: nowIso,
        evidence: `SET 由 ${cand.from} 变为 ${cand.to}${node?.unit ? ` ${node.unit}` : ''},时间窗内平台无写入记录`,
      })
      if (res.added) confirmAdded++
    }
  }

  return {
    episodes,
    confirmations: { added: confirmAdded, pending: state.listConfirmations({ lineId, status: 'pending' }).length },
  }
}

/** 类型再导出(工具/测试面常用;避免各自深路径 import) */
export type { ExpConfirmation, ExpEpisode, ExpNodeSnapshot, ExpWatermark }
