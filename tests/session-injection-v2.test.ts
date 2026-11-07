/**
 * Session 注入 v2：分层装配（身份/pinned/早期压缩/近期原文）+ 提取式压缩 + profile。
 * 纯内存 DB；不依赖 manager/harness。断言面即注入块文本本身。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-inject-v2-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')
const { SessionContextService, formatBriefText } = await import('../server/services/workshop/sessions/context')

const PINNED = '决策：锁定A方案作为本会话交付基线，后续轮次不得更改验收口径'
const FILLER = '今天我们先聊一下值班手册的目录结构，然后再看看 FAQ 需要补充哪些条目，最后讨论一下巡检报告的模板格式安排'

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const messages = createMessageRepo(db)
  const sessions = createChannelSessionRepo(db)
  const channel = channels.create({ name: '注入频道', ownerUserId: 'u-owner' })
  const session = sessions.create({
    channelId: channel.id,
    title: '注入会话',
    memberMap: { 'base-lead': 'clone-lead' },
    createdBy: 'u-owner',
    instanceKind: 'manual',
  })
  const svc = new SessionContextService(db, sessions)
  function say(text: string, opts: { role?: 'ROLE_USER' | 'ROLE_AGENT', from?: string | null } = {}): void {
    messages.create({
      channelId: channel.id,
      sessionId: session.id,
      fromAgentId: opts.from ?? null,
      toAgentId: 'clone-lead',
      role: opts.role ?? 'ROLE_USER',
      parts: [{ text }],
      metadata: { 'x-aw-session-id': session.id },
    })
  }
  return { db, svc, session, say }
}

test('v2 分层：近期原文进 recent 层，generation=0 时无压缩层', () => {
  const f = fixture()
  try {
    f.say(`请按 ${PINNED.slice(3)} 的要求先补 FAQ 增量`)
    f.say('收到，我先梳理 FAQ 目录')
    const brief = f.svc.buildBrief(f.session.id, { refresh: true })
    assert.ok(brief)
    const block = formatBriefText(brief!)
    assert.match(block, /## Session Context \(authoritative\)/)
    assert.match(block, /profile=full/)
    assert.match(block, /### 近期对话 \(recent, 2 turns\)/)
    assert.match(block, /我先梳理 FAQ 目录/)
    assert.ok(!block.includes('### 早期上下文'), 'generation=0 且无折叠行时不应出现压缩层')
    assert.match(block, /## Session Boundary/)
  }
  finally {
    f.db.close()
  }
})

test('v2 压缩：窗口外旧轮折叠，pinned 原文保留、填充句被压缩为话题行；幂等', () => {
  const f = fixture()
  try {
    // 10 条消息：窗口 8 → 最早 2 条（1 pinned + 1 填充）应被折叠
    f.say(PINNED)
    f.say(FILLER)
    for (let i = 1; i <= 8; i++) f.say(`第 ${i} 轮推进：补充 FAQ 条目 ${i}`)
    const brief = f.svc.buildBrief(f.session.id, { refresh: true })
    assert.ok(brief)
    assert.equal(brief!.compressed.generation, 1)
    assert.ok(brief!.compressed.lines.some(l => l.includes(PINNED)), 'pinned 行必须原文保留')
    const block = formatBriefText(brief!)
    assert.match(block, /### 早期上下文 \(compressed, generation=1\)/)
    assert.match(block, /### 关键事实 \(pinned\)/)
    assert.ok(block.includes(PINNED), 'pinned 原文完整出现在注入块')
    assert.ok(!block.includes(FILLER), '填充长句不应以原文出现在注入块（已压缩）')
    assert.ok(block.includes(`· 人类: ${FILLER.slice(0, 36)}`), '填充句以截断话题行出现')

    // 幂等：再次构建不重复折叠、世代不涨
    const again = f.svc.buildBrief(f.session.id, { refresh: true })
    assert.equal(again!.compressed.generation, 1)
    assert.equal(again!.compressed.lines.length, brief!.compressed.lines.length)
  }
  finally {
    f.db.close()
  }
})

test('v2 预算：recent 层从最新往回保留，超预算丢最旧整条；单条截断 300', () => {
  const f = fixture()
  try {
    for (let i = 1; i <= 8; i++) f.say(`长消息 ${i}：${'内容'.repeat(150)}`) // 每条正文 306 字符
    const brief = f.svc.buildBrief(f.session.id, { refresh: true })
    assert.ok(brief)
    assert.equal(brief!.recentTurns.length, 8)
    assert.ok(brief!.recentTurns[0]!.text.length <= 307, `单条截断 ≤300+省略号，实际 ${brief!.recentTurns[0]!.text.length}`)
    const block = formatBriefText(brief!)
    const turnLines = block.split('\n').filter(l => /^\[\d{2}:\d{2}\]/.test(l))
    assert.ok(turnLines.length < 8, `预算 2400 应只保留最新 ~7 条，实际 ${turnLines.length}`)
    assert.ok(turnLines[turnLines.length - 1]?.includes('长消息 8'), '保留的是最新的连续窗口（含第 8 条）')
    assert.ok(!turnLines[0]?.includes('长消息 1'), '最旧的一条应被预算丢弃')
  }
  finally {
    f.db.close()
  }
})

test('v2 profile=brief：只保留身份+pinned，省略 recent/compressed 层', () => {
  const f = fixture()
  try {
    f.say(PINNED)
    f.say(FILLER)
    for (let i = 1; i <= 8; i++) f.say(`第 ${i} 轮推进`)
    const brief = f.svc.buildBrief(f.session.id, { refresh: true })
    const block = formatBriefText(brief!, 'brief')
    assert.match(block, /profile=brief/)
    assert.ok(block.includes(PINNED), 'brief 档仍保留 pinned 关键事实')
    assert.ok(!block.includes('### 近期对话'), 'brief 档不注入近期层')
    assert.ok(!block.includes('### 早期上下文'), 'brief 档不注入压缩层')
    assert.match(block, /## Session Boundary/)
  }
  finally {
    f.db.close()
  }
})

test('v2 跨代累积：两批折叠去重合并，pinned 不重复', () => {
  const f = fixture()
  try {
    f.say(PINNED)
    for (let i = 1; i <= 8; i++) f.say(`第一批 ${i}`)
    f.svc.buildBrief(f.session.id, { refresh: true })
    f.say(`第二批标记句：${FILLER}`)
    for (let i = 1; i <= 8; i++) f.say(`第二批 ${i}`)
    const brief = f.svc.buildBrief(f.session.id, { refresh: true })
    assert.equal(brief!.compressed.generation, 2)
    const pinnedCount = brief!.compressed.lines.filter(l => l.includes(PINNED)).length
    assert.equal(pinnedCount, 1, 'pinned 行跨代去重')
    assert.ok(brief!.compressed.lines.some(l => l.includes('第二批标记句')), '第二批旧消息继续折叠')
  }
  finally {
    f.db.close()
  }
})
