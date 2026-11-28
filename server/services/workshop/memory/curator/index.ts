/**
 * Curator —— 后台汇整代理（批次 E，2026-11-27）。
 *
 * 三职分离：
 *  - Store（各写入路径）只追加碎片；
 *  - Curate（本模块）把碎片汇成连续、结构化、可读的 `kind='curated'` 文档；
 *  - Inject（recall L0.5）只取摘要，不把整份文档塞进 prompt。
 *
 * 纪律：
 *  - 来源准入：session/对话/未部署经验/curated 自身不进可注入手册；
 *  - 增量幂等：来源 hash 不变 → skipped_noop（revision 不变）；
 *  - 人工权威：人工编辑过的文档跳过自动再生（force 才产新 revision）；
 *  - LLM 可选：未配置/超时/非法 JSON → 模板回退，并在 run 行记录 fallback_reason；
 *  - LLM 端点来自运维配置，必须过 SSRF 护栏（复用 net/ssrf.safeFetch）；
 *  - 不收 session 行进频道手册；跨频道沿用既有开关（v1 按频道生成）。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { createMemoryRepo } from '../../db/memory.repo'
import { segmentCJK, unsegmentCJK } from '../../runtime/memory/helpers'
import { allowPrivateOutbound, safeFetch } from '../../net/ssrf'
import { addMemoryLink } from '../links'

export interface CuratorSourceRow {
  id: string
  kind: string
  title: string
  content: string
  status: string
  scopeKind: string
  scopeKey: string
  updatedAt: string
  outcome: string
  deployment: string
}

export interface CuratorResult {
  status: 'ok' | 'skipped_noop' | 'blocked_human' | 'insufficient_sources' | 'failed'
  curatedId?: string
  revision?: number
  sourceCount: number
  mode: 'template' | 'llm'
  fallbackReason: string
  runId: string
  markdown?: string
}

const MIN_SOURCES = 3
const MAX_SOURCES = 200
const CONTENT_LIMIT = 24_000

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

interface ChannelRow {
  id: string
  name: string
  lineId: string
  ownerUserId: string | null
  accessMode?: string
}

function channelOf(db: DatabaseSync, channelId: string): ChannelRow | null {
  const row = db.prepare('SELECT id, name, line_id AS lineId, owner_user_id AS ownerUserId, memory_access_mode AS accessMode FROM channels WHERE id = ?')
    .get(channelId) as ChannelRow | undefined
  return row ?? null
}

/** 来源准入：只取可公开复用的结论/过程，不取会话私有、对话摘要、curated 自身 */
export function selectCuratorSources(db: DatabaseSync, channelId: string): CuratorSourceRow[] {
  const rows = db.prepare(
    `SELECT m.id, m.kind, m.title, m.content, m.status, m.scope_kind AS scopeKind, m.scope_key AS scopeKey,
            m.updated_at AS updatedAt, m.outcome,
            COALESCE((SELECT v.deployment FROM experience_heads h JOIN experience_versions v ON v.version_id = h.version_id
                       WHERE h.experience_id = m.id), 'none') AS deployment
       FROM agent_memories m
      WHERE m.channel_id = ? AND m.deleted_at IS NULL
        AND m.kind IN ('semantic', 'episodic-task', 'episodic-peer', 'episodic-team-task', 'experience')
        AND m.status NOT IN ('retired')
        AND (
          (m.kind = 'semantic' AND m.agent_id = '__team__')
          OR (m.kind IN ('episodic-task', 'episodic-peer', 'episodic-team-task') AND m.session_id = '')
          OR m.kind = 'experience'
        )
        AND (m.kind != 'experience' OR (m.status = 'validated' AND COALESCE(
              (SELECT v.deployment FROM experience_heads h JOIN experience_versions v ON v.version_id = h.version_id
                WHERE h.experience_id = m.id), 'none') IN ('active', 'canary')))
      ORDER BY m.updated_at DESC LIMIT ?`,
  ).all(channelId, MAX_SOURCES) as unknown as CuratorSourceRow[]
  return rows
}

function numbersOf(text: string): number[] {
  return (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite)
}

function conflictOf(a: CuratorSourceRow, b: CuratorSourceRow): boolean {
  const ta = new Set(segmentCJK(a.title).split(/\s+/).filter(Boolean))
  const tb = new Set(segmentCJK(b.title).split(/\s+/).filter(Boolean))
  const inter = [...ta].filter(x => tb.has(x)).length
  const jaccard = inter / Math.max(1, ta.size + tb.size - inter)
  if (jaccard < 0.6) return false
  const na = numbersOf(unsegmentCJK(a.content))
  const nb = numbersOf(unsegmentCJK(b.content))
  if (na.length === 0 || nb.length === 0) return false
  return na.some(x => nb.every(y => Math.abs(x - y) > Math.max(1e-6, Math.abs(x) * 0.01)))
}

function clip(text: string, max: number): string {
  const plain = unsegmentCJK(text).replace(/\s+/g, ' ').trim()
  return plain.length > max ? `${plain.slice(0, max)}…` : plain
}

/** 确定性模板：五段结构 + 每条结论带来源 id；冲突并列不平均 */
export function synthesizeTemplate(channel: ChannelRow, sources: CuratorSourceRow[]): string {
  const semantic = sources.filter(s => s.kind === 'semantic')
  const episodic = sources.filter(s => s.kind === 'episodic-task' || s.kind === 'episodic-peer')
  const experiences = sources.filter(s => s.kind === 'experience')
  const conflicts: Array<[CuratorSourceRow, CuratorSourceRow]> = []
  for (let i = 0; i < semantic.length; i++) {
    for (let j = i + 1; j < semantic.length; j++) {
      if (conflictOf(semantic[i]!, semantic[j]!)) conflicts.push([semantic[i]!, semantic[j]!])
    }
  }
  const lines: string[] = [
    `# 频道知识手册 · ${channel.name || channel.id}`,
    '',
    `> 汇整 ${sources.length} 条来源；频道 ${channel.id}${channel.lineId ? `；产线 ${channel.lineId}` : ''}；生成时间 ${new Date().toISOString()}`,
    '',
    '## 1. 当前结论',
  ]
  if (semantic.length === 0) lines.push('- 暂无可汇整的语义结论。')
  for (const s of semantic.slice(0, 40)) lines.push(`- ${clip(s.title, 80)}：${clip(s.content, 220)}（来源 ${s.id}）`)
  lines.push('', '## 2. 流程与约定')
  if (episodic.length === 0) lines.push('- 暂无已沉淀的流程/协作记录。')
  for (const s of episodic.slice(0, 30)) lines.push(`- ${clip(s.title, 80)}：${clip(s.content, 200)}（来源 ${s.id}）`)
  lines.push('', '## 3. 已验证经验与有效条件')
  if (experiences.length === 0) lines.push('- 暂无已验证且已部署的经验。')
  for (const s of experiences.slice(0, 30)) {
    lines.push(`- [${s.scopeKind}${s.scopeKey ? `:${s.scopeKey}` : ''}] ${clip(s.title, 80)}：${clip(s.content, 240)}（部署 ${s.deployment}；来源 ${s.id}）`)
  }
  lines.push('', '## 4. 争议与未决')
  if (conflicts.length === 0) lines.push('- 未发现同主题数值冲突。')
  for (const [a, b] of conflicts.slice(0, 10)) {
    lines.push(`- 争议：${clip(a.title, 60)}（${clip(a.content, 140)}；来源 ${a.id}） vs ${clip(b.title, 60)}（${clip(b.content, 140)}；来源 ${b.id}）`)
  }
  lines.push('', '## 5. 来源')
  for (const s of sources.slice(0, 80)) lines.push(`- ${s.id} · ${s.kind} · ${s.status} · ${s.updatedAt}`)
  return lines.join('\n')
}

/** 可选 LLM 写作器：OpenAI 兼容端点；失败/超时/非法 JSON → null（模板回退） */
async function synthesizeLlm(channel: ChannelRow, sources: CuratorSourceRow[], template: string): Promise<string | null> {
  const url = process.env.AW_MEMORY_CURATOR_LLM_URL?.trim()
  const key = process.env.AW_MEMORY_CURATOR_LLM_KEY?.trim() ?? ''
  const model = process.env.AW_MEMORY_CURATOR_LLM_MODEL?.trim() || 'gpt-4o-mini'
  if (!url) return null
  try {
    const sourceDigest = sources.slice(0, 40).map(s => `- [${s.id}] ${s.kind} ${s.title}: ${clip(s.content, 300)}`).join('\n')
    const res = await safeFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你是产线知识汇整器。只依据给定来源写连续、结构化、可读的中文手册；每条结论必须带来源 id；冲突并列；不要编造。输出 JSON：{"markdown":"..."}。' },
          { role: 'user', content: `频道 ${channel.name}（${channel.id}）。来源：\n${sourceDigest}\n\n模板骨架（可改写，但必须保留五段结构与来源 id）：\n${template}` },
        ],
      }),
      signal: AbortSignal.timeout(Number(process.env.AW_MEMORY_CURATOR_LLM_TIMEOUT_MS ?? 20_000)),
    }, { label: 'Curator LLM 服务', allowPrivateHost: allowPrivateOutbound() ? 'true' : 'false' })
    if (!res.ok) return null
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    const raw = json.choices?.[0]?.message?.content ?? ''
    const parsed = JSON.parse(raw) as { markdown?: string }
    if (typeof parsed.markdown !== 'string' || parsed.markdown.trim().length < 80) return null
    const mentioned = sources.filter(s => parsed.markdown!.includes(s.id)).length
    if (sources.length > 0 && mentioned / sources.length < 0.5) return null
    return parsed.markdown
  }
  catch {
    return null
  }
}

function startRun(db: DatabaseSync, channelId: string, mode: 'template' | 'llm'): string {
  const id = `cur-${randomUUID().slice(0, 12)}`
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO memory_curation_runs(id, channel_id, scope_kind, scope_key, product_id, mode, status, started_at)
     VALUES (?, ?, 'channel', '', '', ?, 'running', ?)`,
  ).run(id, channelId, mode, now)
  return id
}

function finishRun(db: DatabaseSync, runId: string, patch: {
  status: string
  scanned: number
  eligible: number
  sourceCount: number
  revision: number
  fallbackReason: string
  error: string
}): void {
  db.prepare(
    `UPDATE memory_curation_runs SET status = ?, scanned = ?, eligible = ?, source_count = ?, revision = ?,
       fallback_reason = ?, error = ?, finished_at = ? WHERE id = ?`,
  ).run(patch.status, patch.scanned, patch.eligible, patch.sourceCount, patch.revision,
    patch.fallbackReason.slice(0, 400), patch.error.slice(0, 600), new Date().toISOString(), runId)
}

/**
 * 频道级汇整（幂等）。`force=true` 时即使人工编辑也产新 revision（人工显式要求）。
 * 返回 run 结果；不抛错（失败记录在 run 行）。
 */
export async function runCuratorForChannel(
  db: DatabaseSync,
  channelId: string,
  opts: { force?: boolean, useLlm?: boolean, minSources?: number } = {},
): Promise<CuratorResult> {
  // 进程内单飞：定时 sweep 与人工 regenerate 不得并发改写同一频道手册。
  if (curatorRunning.has(channelId)) {
    return { status: 'skipped_noop', sourceCount: 0, mode: opts.useLlm ? 'llm' : 'template', fallbackReason: 'already_running', runId: '' }
  }
  curatorRunning.add(channelId)
  try {
    return await runCuratorForChannelInner(db, channelId, opts)
  }
  finally {
    curatorRunning.delete(channelId)
  }
}

const curatorRunning = new Set<string>()

async function runCuratorForChannelInner(
  db: DatabaseSync,
  channelId: string,
  opts: { force?: boolean, useLlm?: boolean, minSources?: number } = {},
): Promise<CuratorResult> {
  const channel = channelOf(db, channelId)
  const mode: 'template' | 'llm' = opts.useLlm ? 'llm' : 'template'
  const runId = startRun(db, channelId, mode)
  if (!channel) {
    finishRun(db, runId, { status: 'failed', scanned: 0, eligible: 0, sourceCount: 0, revision: 0, fallbackReason: '', error: 'channel_missing' })
    return { status: 'failed', sourceCount: 0, mode, fallbackReason: '', runId }
  }
  if (channel.accessMode && channel.accessMode !== 'inherit') {
    finishRun(db, runId, { status: 'failed', scanned: 0, eligible: 0, sourceCount: 0, revision: 0, fallbackReason: '', error: `access_mode_${channel.accessMode}` })
    return { status: 'failed', sourceCount: 0, mode, fallbackReason: '', runId }
  }
  try {
    const repo = createMemoryRepo(db)
    const all = selectCuratorSources(db, channelId)
    const minSources = Math.max(1, opts.minSources ?? MIN_SOURCES)
    if (all.length < minSources) {
      finishRun(db, runId, { status: 'insufficient_sources', scanned: all.length, eligible: all.length, sourceCount: all.length, revision: 0, fallbackReason: '', error: '' })
      return { status: 'insufficient_sources', sourceCount: all.length, mode, fallbackReason: '', runId }
    }
    const sourceHash = sha256(all.map(s => `${s.id}:${s.updatedAt}:${s.status}`).sort().join('|'))
    const dedupKey = `curated:knowledge:${channelId}`
    const existingRef = repo.findByAgentDedup(channelId, 'curator', dedupKey)
    const existing = existingRef ? repo.getById(existingRef.id) : null
    if (existing && (existing.authorKind === 'human' || existing.status === 'validated') && !opts.force) {
      finishRun(db, runId, { status: 'blocked_human', scanned: all.length, eligible: all.length, sourceCount: all.length, revision: existing.revision ?? 0, fallbackReason: 'human-edited', error: '' })
      return { status: 'blocked_human', curatedId: existing.id, revision: existing.revision, sourceCount: all.length, mode, fallbackReason: 'human-edited', runId }
    }
    const state = db.prepare('SELECT last_source_hash AS hash, revision FROM memory_curation_state WHERE curated_id = ?')
      .get(existing?.id ?? `pending:${channelId}`) as { hash?: string, revision?: number } | undefined
    if (existing && state?.hash === sourceHash && !opts.force) {
      finishRun(db, runId, { status: 'skipped_noop', scanned: all.length, eligible: all.length, sourceCount: all.length, revision: existing.revision ?? 0, fallbackReason: '', error: '' })
      return { status: 'skipped_noop', curatedId: existing.id, revision: existing.revision, sourceCount: all.length, mode, fallbackReason: '', runId }
    }

    const template = synthesizeTemplate(channel, all)
    let markdown = template
    let fallbackReason = ''
    let usedMode: 'template' | 'llm' = 'template'
    if (mode === 'llm') {
      const llm = await synthesizeLlm(channel, all, template)
      if (llm) {
        markdown = llm
        usedMode = 'llm'
      }
      else {
        fallbackReason = 'llm_unavailable_or_invalid'
      }
    }

    let revision = existing?.revision ?? 1
    if (existing) {
      repo.snapshotRevision({
        memoryId: existing.id,
        revision,
        title: existing.title,
        content: existing.content,
        evidenceJson: existing.evidenceJson ?? '',
        authorKind: existing.authorKind ?? 'agent',
        authorId: existing.authorId ?? '',
        reason: opts.force ? 'curator:force-regenerate' : 'curator:regenerate',
      })
    }
    const title = `知识手册 · ${channel.name || channel.id}`
    const titleFts = segmentCJK(`知识手册 ${channel.name || channel.id}`)
    const content = segmentCJK(markdown).slice(0, CONTENT_LIMIT)
    let write: { id: string, outcome: string }
    if (existing && existing.authorKind === 'human' && opts.force) {
      // 人工显式 force：绕过 repo 的 human 保护，但保留旧版快照（上面已 snapshotRevision）
      db.prepare(
        `UPDATE agent_memories SET title = ?, title_fts = ?, content = ?, importance = ?,
           author_kind = 'agent', author_id = 'curator', revision = revision + 1, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      ).run(title, titleFts, content, 0.8, new Date().toISOString(), existing.id)
      write = { id: existing.id, outcome: 'updated' }
    }
    else {
      write = repo.upsert({
        channelId,
        agentId: 'curator',
        kind: 'curated',
        title,
        titleFts,
        content,
        importance: 0.8,
        taskId: null,
        sessionId: '',
        dedupKey,
        ownerUserId: channel.ownerUserId ?? undefined,
        originRef: `curator:${all.length}`,
      })
    }
    if (write.outcome === 'protected') {
      finishRun(db, runId, { status: 'blocked_human', scanned: all.length, eligible: all.length, sourceCount: all.length, revision, fallbackReason: 'protected', error: '' })
      return { status: 'blocked_human', curatedId: write.id, revision, sourceCount: all.length, mode: usedMode, fallbackReason: 'protected', runId }
    }
    // 普通 upsert 不写 scope 列（默认 session）；curated 文档必须落 channel 作用域才能被 L0.5 检索。
    db.prepare(`UPDATE agent_memories SET scope_kind = 'channel', scope_key = '',
      owner_user_id = COALESCE(owner_user_id, ?) WHERE id = ?`)
      .run(channel.ownerUserId ?? null, write.id)
    revision = (repo.getById(write.id)?.revision ?? revision)
    const now = new Date().toISOString()
    db.prepare('DELETE FROM memory_curation_sources WHERE curated_id = ?').run(write.id)
    const insertSource = db.prepare(
      `INSERT INTO memory_curation_sources(id, curated_id, source_memory_id, run_id, relation, created_at)
       VALUES (?, ?, ?, ?, 'derived_from', ?) ON CONFLICT(curated_id, source_memory_id) DO NOTHING`,
    )
    for (const s of all) insertSource.run(`cs-${randomUUID().slice(0, 12)}`, write.id, s.id, runId, now)
    // 批次 K：Curator 每条结论 derived_from 来源（链接可查，不复制正文）
    for (const s of all) {
      try {
        addMemoryLink(db, { srcId: write.id, dstId: s.id, relation: 'derived_from', createdBy: 'curator' })
      }
      catch { /* 单条链接失败不影响汇整 */ }
    }
    db.prepare(
      `INSERT INTO memory_curation_state(curated_id, channel_id, scope_kind, scope_key, last_source_hash, last_source_count, last_run_id, revision, updated_at)
       VALUES (?, ?, 'channel', '', ?, ?, ?, ?, ?)
       ON CONFLICT(curated_id) DO UPDATE SET last_source_hash = excluded.last_source_hash,
         last_source_count = excluded.last_source_count, last_run_id = excluded.last_run_id,
         revision = excluded.revision, updated_at = excluded.updated_at`,
    ).run(write.id, channelId, sourceHash, all.length, runId, revision, now)
    finishRun(db, runId, { status: 'ok', scanned: all.length, eligible: all.length, sourceCount: all.length, revision, fallbackReason, error: '' })
    return { status: 'ok', curatedId: write.id, revision, sourceCount: all.length, mode: usedMode, fallbackReason, runId, markdown }
  }
  catch (err) {
    finishRun(db, runId, { status: 'failed', scanned: 0, eligible: 0, sourceCount: 0, revision: 0, fallbackReason: '', error: err instanceof Error ? err.message : String(err) })
    return { status: 'failed', sourceCount: 0, mode, fallbackReason: '', runId }
  }
}

/** 维护任务：对近期有来源的频道做有限次汇整（单飞由调用方保证） */
export async function runCuratorSweep(db: DatabaseSync, opts: { limit?: number, force?: boolean, useLlm?: boolean } = {}): Promise<CuratorResult[]> {
  const channels = db.prepare(
    `SELECT m.channel_id AS channelId, MAX(m.updated_at) AS lastAt FROM agent_memories m
      JOIN channels c ON c.id = m.channel_id
      WHERE m.kind IN ('semantic','episodic-task','episodic-peer','episodic-team-task','experience') AND m.deleted_at IS NULL
        AND c.memory_access_mode = 'inherit'
      GROUP BY m.channel_id ORDER BY lastAt DESC LIMIT ?`,
  ).all(Math.min(Math.max(opts.limit ?? 3, 1), 10)) as Array<{ channelId: string }>
  const results: CuratorResult[] = []
  for (const c of channels) results.push(await runCuratorForChannel(db, c.channelId, opts))
  return results
}

/** 管理面：列 curated 文档 + 最近运行 */
export function listCurations(db: DatabaseSync, filter: { channelIds?: string[], limit?: number } = {}): Array<Record<string, unknown>> {
  const where: string[] = [`m.kind = 'curated'`, `m.deleted_at IS NULL`]
  const args: Array<string | number> = []
  if (filter.channelIds) {
    if (filter.channelIds.length === 0) return []
    where.push(`m.channel_id IN (${filter.channelIds.map(() => '?').join(', ')})`)
    args.push(...filter.channelIds)
  }
  const rows = db.prepare(
    `SELECT m.id, m.channel_id AS channelId, m.title, m.status, m.revision, m.author_kind AS authorKind,
            m.scope_kind AS scopeKind, m.scope_key AS scopeKey, m.pinned, m.updated_at AS updatedAt,
            s.last_source_count AS sourceCount, s.revision AS stateRevision,
            (SELECT id FROM memory_curation_runs r WHERE r.channel_id = m.channel_id ORDER BY started_at DESC LIMIT 1) AS lastRunId,
            (SELECT status FROM memory_curation_runs r WHERE r.channel_id = m.channel_id ORDER BY started_at DESC LIMIT 1) AS lastRunStatus,
            (SELECT finished_at FROM memory_curation_runs r WHERE r.channel_id = m.channel_id ORDER BY started_at DESC LIMIT 1) AS lastRunAt
       FROM agent_memories m LEFT JOIN memory_curation_state s ON s.curated_id = m.id
      WHERE ${where.join(' AND ')}
      ORDER BY m.pinned DESC, m.updated_at DESC LIMIT ?`,
  ).all(...args, Math.min(Math.max(filter.limit ?? 50, 1), 200)) as Array<Record<string, unknown>>
  return rows.map(r => ({ ...r, title: String(r.title ?? ''), sourceCount: Number(r.sourceCount ?? 0), pinned: Number(r.pinned ?? 0) === 1 }))
}

/** 管理面：文档来源 + 运行历史 */
export function curationDetail(db: DatabaseSync, curatedId: string): { sources: Array<Record<string, unknown>>, runs: Array<Record<string, unknown>> } | null {
  const row = db.prepare(`SELECT channel_id AS channelId FROM agent_memories WHERE id = ? AND kind = 'curated'`).get(curatedId) as { channelId?: string } | undefined
  if (!row?.channelId) return null
  const sources = db.prepare(
    `SELECT cs.source_memory_id AS memoryId, cs.relation, m.title, m.kind, m.status, m.updated_at AS updatedAt
       FROM memory_curation_sources cs JOIN agent_memories m ON m.id = cs.source_memory_id
      WHERE cs.curated_id = ? ORDER BY m.updated_at DESC`,
  ).all(curatedId) as Array<Record<string, unknown>>
  const runs = db.prepare(
    `SELECT id, mode, status, scanned, eligible, source_count AS sourceCount, revision, fallback_reason AS fallbackReason,
            error, started_at AS startedAt, finished_at AS finishedAt
       FROM memory_curation_runs WHERE channel_id = ? ORDER BY started_at DESC LIMIT 20`,
  ).all(row.channelId) as Array<Record<string, unknown>>
  return { sources, runs }
}
