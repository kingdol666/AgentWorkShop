#!/usr/bin/env node
/**
 * AgentPrefab / Skills / MCP 实机验收（隔离实例）。
 *
 * 前置：已用 clean AW_HOME + USER_HOME 启动当前构建，BASE 指向该实例。
 * 覆盖面：Skill 发现→导入→启用；Prefab 发布→Channel 绑定；工具目录/activate_skill/
 * 拒绝调用；Session 克隆与 prefab 快照；发布新 revision 不自动升级绑定；MCP 非法目标拒绝。
 * 不连接外部 MCP、不执行 Skill 脚本、不做物理操作；输出 JSON 证据。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const BASE = arg('--base', 'http://127.0.0.1:3025')
const AW_HOME = arg('--home', '')
const USER_HOME = arg('--user-home', '')
const EVIDENCE = arg('--evidence', '')
if (!AW_HOME || !USER_HOME || !EVIDENCE) {
  console.error('usage: --home <AW_HOME> --user-home <USER_HOME> --evidence <dir> [--base url]')
  process.exit(2)
}
mkdirSync(EVIDENCE, { recursive: true })

const checks = []
function check(id, ok, detail = '') {
  checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`${ok ? '✔' : '✖'} ${id}${detail ? ` — ${detail}` : ''}`)
  return ok
}

async function api(method, path, body, token) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON */ }
  return { status: res.status, json, text }
}

const adminEmail = `prefab-accept-${Date.now()}@example.test`
const adminPassword = `Aa1!${randomBytes(18).toString('hex')}`
const reg = await api('POST', '/api/users/register', { name: 'prefab-accept', email: adminEmail, password: adminPassword })
const token = reg.json?.data?.token
check('admin_register', reg.status === 200 && Boolean(token), `status=${reg.status}`)
if (!token) {
  writeFileSync(join(EVIDENCE, 'result.json'), JSON.stringify({ checks, summary: { pass: 0, fail: checks.length } }, null, 2))
  process.exit(1)
}

// 1. 全局兼容 Skill：写入隔离 USER_HOME，发现/导入/启用
const skillName = 'acceptance-analyzer'
const skillDir = join(USER_HOME, '.agent', 'skills', skillName)
mkdirSync(join(skillDir, 'references'), { recursive: true })
writeFileSync(join(skillDir, 'SKILL.md'), [
  '---',
  `name: ${skillName}`,
  'description: Acceptance analyzer for governed line diagnostics.',
  'metadata:',
  '  version: "1.0"',
  '---',
  '',
  '# Acceptance analyzer',
  '',
  '1. Read the current line context.',
  '2. Report only observed values; never invent readings.',
  '3. See [guide](references/guide.md).',
].join('\n'))
writeFileSync(join(skillDir, 'references', 'guide.md'), '# Guide\nUse device-read values as the baseline.\n')

const discovered = await api('GET', '/api/system/skills/discover', undefined, token)
const skill = discovered.json?.data?.discovered?.find(x => x.name === skillName)
check('skill_discovered_from_user_agent_root', Boolean(skill) && skill.source === 'global', `status=${discovered.status} source=${skill?.source ?? '-'}`)

const imported = skill ? await api('POST', '/api/system/skills/import', { catalogId: skill.id }, token) : { json: null }
const revisionId = imported.json?.data?.revision?.id
check('skill_imported_immutable_disabled', Boolean(revisionId) && imported.json?.data?.revision?.enabled === false, `status=${imported.status}`)
const enabled = revisionId ? await api('PATCH', `/api/system/skills/${encodeURIComponent(revisionId)}`, { enabled: true }, token) : { json: null }
check('skill_enabled', enabled.json?.data?.enabled === true, `status=${enabled.status}`)

// 2. Prefab：角色/场景/插槽 + Skill 能力，发布 revision 1
const draft = {
  name: 'Acceptance Analyst',
  description: 'Governed line diagnostic expert',
  visibility: 'private',
  prompt: {
    role: 'You are an acceptance analyst. Use observed values only.',
    scenario: 'Simulated line diagnostics; no physical operation.',
    slots: [{ key: 'objective', label: 'Objective', defaultValue: 'verify-readings', required: true, allowMemberOverride: true, maxLength: 200 }],
  },
  profile: { provider: 'mock', model: 'mock', settings: { thinkingLevel: 'high' } },
  capabilities: revisionId ? [{ kind: 'skill', id: revisionId, required: true }] : [],
}
const created = await api('POST', '/api/workshop/agent-prefabs', { draft }, token)
const prefab = created.json?.data
check('prefab_draft_created', created.status === 200 && Boolean(prefab?.id), `status=${created.status}`)

const published = prefab ? await api('POST', `/api/workshop/agent-prefabs/${prefab.id}/publish`, { expectedHead: 0 }, token) : { json: null }
const revision1 = published.json?.data
check('prefab_revision_published', Boolean(revision1?.contentHash), `status=${published.status} rev=${revision1?.revision ?? '-'}`)

// 3. Channel + 成员绑定（mock lead）
const ch = await api('POST', '/api/workshop/channels', {
  name: `prefab-accept-${Date.now().toString(36)}`,
  leadAgent: { name: 'accept-lead', harness: 'mock', config: { delayMs: 0 } },
}, token)
const channelId = ch.json?.data?.channelId
const leadId = ch.json?.data?.leadAgentId
check('channel_with_mock_lead', Boolean(channelId) && Boolean(leadId), `status=${ch.status}`)

const bind = prefab && revision1 && channelId && leadId
  ? await api('PATCH', `/api/workshop/channels/${channelId}/agents/${leadId}/prefab`, {
      prefabId: prefab.id,
      revision: revision1.revision,
      slotValues: { objective: 'verify-readings' },
    }, token)
  : { json: null }
check('member_bound_to_pinned_revision', bind.json?.data?.prefabBinding?.revision === revision1?.revision, `status=${bind.status}`)

// 4. 工具目录与调用边界
const tools = await api('GET', `/api/workshop/agent-tools/list?agentId=${encodeURIComponent(leadId ?? '')}`, undefined, token)
const toolNames = (tools.json?.data?.tools ?? []).map(t => t.name)
check('catalog_exposes_activate_skill_only_for_assigned_skill', toolNames.includes('activate_skill'), `tools=${toolNames.length}`)
check('catalog_narrows_unselected_tool', !toolNames.includes('dcw_control') && toolNames.includes('send_message_to_agent'), `dcw=${toolNames.includes('dcw_control')}`)

const activated = revisionId && leadId
  ? await api('POST', '/api/workshop/agent-tools/invoke', { agentId: leadId, tool: 'activate_skill', args: { skillId: revisionId } }, token)
  : { json: null }
const activatedText = activated.json?.data?.result?.text ?? ''
check('activate_skill_returns_low_trust_body', activated.json?.data?.result?.isError !== true && activatedText.includes('Acceptance analyzer') && activatedText.includes('low-trust'), `status=${activated.status}`)

const denied = leadId
  ? await api('POST', '/api/workshop/agent-tools/invoke', { agentId: leadId, tool: 'dcw_control', args: {} }, token)
  : { json: null }
check('unselected_tool_denied_at_dispatch', denied.json?.data?.result?.isError === true && /FORBIDDEN|不开放|不可用/.test(String(denied.json?.data?.result?.text)), `status=${denied.status} text=${String(denied.json?.data?.result?.text ?? '').slice(0, 80)}`)

// 5. Session clone 复制 binding；Session 行固定 prefab 快照
const session = channelId ? await api('POST', `/api/workshop/channels/${channelId}/sessions`, { title: 'prefab-accept-session' }, token) : { json: null }
const sessionId = session.json?.data?.sessionId ?? session.json?.data?.id
check('session_created', Boolean(sessionId), `status=${session.status}`)

const dbPath = join(AW_HOME, 'data', 'workshop.sqlite')
const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  const sessionRow = db.prepare('SELECT member_map_json, prefab_snapshot_json, prefab_snapshot_hash FROM channel_sessions WHERE id = ?').get(sessionId)
  const memberMap = JSON.parse(sessionRow?.member_map_json ?? '{}')
  const cloneId = memberMap[leadId]
  const cloneRow = db.prepare('SELECT prefab_binding_json FROM channel_agents WHERE id = ?').get(cloneId)
  const cloneBinding = JSON.parse(cloneRow?.prefab_binding_json || '{}')
  check('session_clone_copies_pinned_binding', cloneBinding.revision === revision1?.revision && cloneBinding.contentHash === revision1?.contentHash, `clone=${cloneId ?? '-'}`)
  check('session_snapshot_hash_matches', /^[a-f0-9]{64}$/.test(sessionRow?.prefab_snapshot_hash ?? '') && String(sessionRow?.prefab_snapshot_json ?? '').includes(bind.json?.data?.prefabBinding?.contentHash ?? '-'), `hash=${String(sessionRow?.prefab_snapshot_hash ?? '').slice(0, 12)}`)
} finally {
  db.close()
}

// 6. 发布 revision 2 不自动升级既有绑定
const current = prefab ? await api('GET', `/api/workshop/agent-prefabs/${prefab.id}`, undefined, token) : { json: null }
const rev2 = prefab ? await api('POST', `/api/workshop/agent-prefabs/${prefab.id}/publish`, { expectedHead: current.json?.data?.headRevision ?? 0 }, token) : { json: null }
check('revision2_published', rev2.json?.data?.revision === 2, `status=${rev2.status}`)
const db2 = new DatabaseSync(dbPath, { readOnly: true })
try {
  const row = db2.prepare('SELECT prefab_binding_json FROM channel_agents WHERE id = ?').get(leadId)
  check('existing_binding_not_auto_upgraded', JSON.parse(row?.prefab_binding_json || '{}').revision === 1)
} finally {
  db2.close()
}

// 7. Skill 撤销后激活立即失败（不依赖目录刷新）
if (revisionId) await api('PATCH', `/api/system/skills/${encodeURIComponent(revisionId)}`, { enabled: false }, token)
const afterRevoke = revisionId && leadId
  ? await api('POST', '/api/workshop/agent-tools/invoke', { agentId: leadId, tool: 'activate_skill', args: { skillId: revisionId } }, token)
  : { json: null }
check('revoked_skill_activation_denied', afterRevoke.json?.data?.result?.isError === true, `text=${String(afterRevoke.json?.data?.result?.text ?? '').slice(0, 80)}`)
if (revisionId) await api('PATCH', `/api/system/skills/${encodeURIComponent(revisionId)}`, { enabled: true }, token)

// 8. MCP 目标校验：明文/环回在登记阶段拒绝；不访问外部服务
const badMcp = await api('POST', '/api/system/mcp-servers', { id: 'accept-bad', label: 'Bad', endpoint: 'http://127.0.0.1:9/mcp', dataSharing: 'shared-safe' }, token)
check('mcp_rejects_non_https', badMcp.status === 400 && badMcp.json?.code === 'MCP_HTTPS_REQUIRED', `status=${badMcp.status}`)

const goodMcp = await api('POST', '/api/system/mcp-servers', { id: 'accept-mcp', label: 'Accept MCP', endpoint: 'https://example.com/mcp', dataSharing: 'shared-safe' }, token)
check('mcp_manifest_registered_without_secret', goodMcp.status === 200 && goodMcp.json?.data?.hasCredential === false && !String(goodMcp.text).includes('AW_MCP_'), `status=${goodMcp.status}`)
const mcpDiscover = await api('POST', '/api/system/mcp-servers/accept-mcp/discover', undefined, token)
check('mcp_discovery_failure_is_bounded', mcpDiscover.status >= 400 && String(mcpDiscover.json?.message ?? '').length < 400, `status=${mcpDiscover.status}`)
await api('DELETE', '/api/system/mcp-servers/accept-mcp', undefined, token)

const failed = checks.filter(c => c.status !== 'PASS').length
const summary = { total: checks.length, pass: checks.length - failed, fail: failed }
writeFileSync(join(EVIDENCE, 'result.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, checks, summary }, null, 2))
console.log(`RESULT ${JSON.stringify(summary)}`)
process.exit(failed === 0 ? 0 : 1)
