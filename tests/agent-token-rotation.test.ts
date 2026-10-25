/**
 * WP3 token 生命周期单测(临时 home + 临时 sqlite,不联网):
 *  - findByToken:当前 token 命中;轮换后旧 token 在宽限窗内同样命中(四路调用点共用);
 *  - 宽限窗过期后旧 token 不再命中;
 *  - isTokenValid:常量时间比较 + 宽限双接受;空 token 恒 false;
 *  - safeTokenEqual:长度不同不抛异常、返回 false;等长不同返回 false。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
const awHome = mkdtempSync(join(tmpdir(), 'aw-token-rotate-test-'))
process.env.AW_HOME = awHome
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelAgentRepo, safeTokenEqual } = await import('../server/services/workshop/db/channel-agent.repo')

const db = openWorkshopDb(join(awHome, 'token-rotate-test.sqlite'))
const repo = createChannelAgentRepo(db)
const now = new Date().toISOString()
db.prepare(
  `INSERT INTO channels (id, name, description, lead_agent_id, workspace, enabled, created_at, updated_at)
   VALUES (?, ?, '', NULL, '', 1, ?, ?)`,
).run('ch-rotate', '轮换测试频道', now, now)

function makeAgent(token?: string) {
  return repo.create({ channelId: 'ch-rotate', templateId: null, name: `agent-${Math.random().toString(36).slice(2, 6)}`, harness: 'mock', role: 'worker', token })
}

test('当前 token 命中;轮换后旧 token 宽限内仍命中,新 token 立即命中', () => {
  const agent = makeAgent('tok-old-0001')
  assert.equal(repo.findByToken('tok-old-0001')?.id, agent.id)

  const rotated = repo.rotateToken(agent.id, 60_000)
  assert.ok(rotated)
  assert.notEqual(rotated!.token, 'tok-old-0001')

  assert.equal(repo.findByToken(rotated!.token)?.id, agent.id, '新 token 立即生效')
  assert.equal(repo.findByToken('tok-old-0001')?.id, agent.id, '旧 token 宽限内双接受')

  const row = repo.findById(agent.id)!
  assert.equal(repo.isTokenValid(row, rotated!.token), true)
  assert.equal(repo.isTokenValid(row, 'tok-old-0001'), true, 'isTokenValid 同样双接受')
  assert.equal(repo.isTokenValid(row, 'tok-never'), false)
  assert.equal(repo.isTokenValid(row, ''), false)
})

test('宽限过期后旧 token 彻底失效(确定性:直接改写到期时刻,不等待)', () => {
  const agent = makeAgent('tok-old-0002')
  const rotated = repo.rotateToken(agent.id, 60_000)!
  db.prepare('UPDATE channel_agents SET prev_token_until = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', agent.id)
  assert.equal(repo.findByToken('tok-old-0002'), undefined)
  assert.equal(repo.findByToken(rotated.token)?.id, agent.id)
  const row = repo.findById(agent.id)!
  assert.equal(repo.isTokenValid(row, 'tok-old-0002'), false)
})

test('宽限窗 0ms:轮换后旧 token 立即失效', () => {
  const agent = makeAgent('tok-old-0003')
  const rotated = repo.rotateToken(agent.id, 0)!
  assert.equal(repo.findByToken('tok-old-0003'), undefined)
  assert.equal(repo.findByToken(rotated.token)?.id, agent.id)
})

test('旋转不存在的 agent → undefined;重复旋转保留最新宽限', () => {
  assert.equal(repo.rotateToken('no-such-agent', 1000), undefined)
  const agent = makeAgent('tok-a')
  const r1 = repo.rotateToken(agent.id, 60_000)!
  const r2 = repo.rotateToken(agent.id, 60_000)!
  assert.equal(repo.findByToken(r2.token)?.id, agent.id)
  assert.equal(repo.findByToken(r1.token)?.id, agent.id, 'r1 成为上一代 token,仍在自身宽限内')
})

test('safeTokenEqual:等长比较/异长不抛/空值 false', () => {
  assert.equal(safeTokenEqual('abc', 'abc'), true)
  assert.equal(safeTokenEqual('abc', 'abd'), false)
  assert.equal(safeTokenEqual('abc', 'abcd'), false)
  assert.equal(safeTokenEqual('', ''), false)
  assert.equal(safeTokenEqual('abc', ''), false)
})
