/**
 * HITL 持久化守卫(2026-11-10)。
 *
 * 现场:hitl_requests 解析后查不到行,只能在 audit_log 里看到。核实结论:
 *  - 代码里**没有**删除逻辑(retention 不含该表),设计就是"登记 pending → 决策 finalize
 *    终态,行长期保留"(repo 头注释:v17 持久化事实源);
 *  - 缺行来自两处缺口:① 登记期 channelId 解析失败被静默跳过(工具审批不带 channelId);
 *    ② agent-tools/approvals/:id/decide 直接走 tool-approvals.decide(只 resolve 内存),
 *    不经过 hitl-decision → 行停在 pending 后被幻影清账置 failed。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-hitl-persist-'))

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createHitlRequestRepo } = await import('../server/services/workshop/db/hitl-request.repo')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'hitl.sqlite'))
const repo = createHitlRequestRepo(db)

const snapshot = { policy: 'owner_only', policyVersion: 1 } as never

test('终态留行:finalize 后行仍在,状态与决策载荷可查', () => {
  repo.create({
    id: 'h-approve', kind: 'dcw-approval', requestType: 'approval', channelId: 'ch-1',
    agentId: 'ag-1', title: '配方下发', detail: 'x', options: [], questions: [], schema: {},
    policy: 'owner_only', policySnapshot: snapshot,
  })
  assert.equal(repo.findById('h-approve')?.status, 'pending')
  const ok = repo.finalize('h-approve', 'approved', {
    decision: { via: 'agent-tools/decide', approved: true },
    nativeConfirmed: true,
  })
  assert.equal(ok, true, 'finalize 应命中 pending 行')
  const row = repo.findById('h-approve')!
  assert.equal(row.status, 'approved', '解析后必须留行(不是删除)')
  assert.match(String(row.decisionJson), /agent-tools\/decide/, '决策来源必须可追溯')
  assert.ok(row.resolvedAt, 'resolved_at 必须落值')
})

test('拒绝同样留行;重复 finalize 不改写终态', () => {
  repo.create({
    id: 'h-reject', kind: 'dcw-approval', requestType: 'approval', channelId: 'ch-1',
    agentId: 'ag-1', title: '停线', detail: 'x', options: [], questions: [], schema: {},
    policy: 'owner_only', policySnapshot: snapshot,
  })
  assert.equal(repo.finalize('h-reject', 'rejected', { decision: { via: 'hitl/respond' }, nativeConfirmed: false }), true)
  assert.equal(repo.findById('h-reject')?.status, 'rejected')
  const again = repo.finalize('h-reject', 'approved', { decision: {}, nativeConfirmed: true })
  assert.equal(again, false, '终态不可被二次改写')
  assert.equal(repo.findById('h-reject')?.status, 'rejected')
})

test('历史读面存在且有读授权口径', () => {
  const src = readFileSync(join(ROOT, 'server/api/workshop/hitl/history.get.ts'), 'utf-8')
  assert.match(src, /listRecent/, 'admin 全局历史')
  assert.match(src, /listByChannel/, '按频道历史')
  assert.match(src, /getChannelForUser/, '非 admin 必须过频道可见性')
  assert.match(src, /lineMode/, '按产线 grant 过滤')
})

test('agent-tools 决策旁路必须补 finalize', () => {
  const src = readFileSync(join(ROOT, 'server/api/workshop/agent-tools/approvals/[id]/decide.post.ts'), 'utf-8')
  assert.match(src, /groupChat\.hitl\.finalize\(/, '旁路必须把 hitl_requests 收口到终态')
  assert.match(src, /via: 'agent-tools\/decide'/, '决策来源需落 decision_json')
})

test('登记降级必须留 warn(不再静默跳过)', () => {
  const src = readFileSync(join(ROOT, 'server/services/workshop/agents/hitl-registry.ts'), 'utf-8')
  assert.match(src, /跳过持久化登记/, 'channelId/manager 缺失时必须可观测')
})
