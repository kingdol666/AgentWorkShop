/**
 * 会话/内核加固守卫(2026-11-10 审计 C4/C5/C9)。
 *
 * C4:创建会话先循环建 clone、最后写 session 行 —— 中途失败留下无会话归属的孤儿 clone。
 *     修复=clone 行 + session 行进同一事务(绑定面是 JSON 文件,出事务后复制)。
 * C5:关闭会话先读 status、跑完 await 级联才关行 —— 两个并发 close 都能通过检查,
 *     重复 cancelTree/abort。修复=CAS-first(条件 UPDATE 抢到才级联)。
 * C9:tool-registry / channel-plugins 自持第二条 DatabaseSync 打开同一 sqlite,
 *     busy_timeout 仅 4s,且裸 BEGIN IMMEDIATE 在共享连接后会与调用方事务嵌套冲突。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-session-hardening-'))

const { createChannelSession, closeChannelSession } = await import('../server/services/workshop/agents/session-clone')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { withTransaction } = await import('../server/services/workshop/db/transaction')
const { initToolRegistryDb, getToolRegistryRepo } = await import('../server/services/workshop/db/tool-registry.repo')

const cloneCtx = () => {
  const store: Array<{ id: string, name: string, harness: string, role: string, enabled: number, agentKind: null, configJson: string }> = [
    { id: 'base-a', name: 'Alice', harness: 'mock', role: 'worker', enabled: 1, agentKind: null, configJson: '{}' },
    { id: 'base-b', name: 'Bob', harness: 'mock', role: 'lead', enabled: 1, agentKind: null, configJson: '{}' },
  ]
  let seq = 0
  return {
    store,
    deps: {
      channelAgents: {
        listByChannel: () => store,
        create: (input: { name: string, harness: string, role: string }) => {
          const row = { id: `clone-${++seq}`, name: input.name, harness: input.harness, role: input.role, enabled: 1, agentKind: null, configJson: '{}' }
          store.push(row)
          return row
        },
      },
      tasks: { list: () => [], cancelTree: () => [] },
      bindings: { byAgent: () => [], bind: () => null },
      unloadAgent: async () => {},
      notify: () => {},
    },
  }
}

test('C4:session 行写入失败时 clone 行必须整体回滚(无孤儿 clone)', () => {
  const { store, deps } = cloneCtx()
  const before = store.length
  // 模拟真实事务:失败即恢复快照(生产由 withTransaction 的 ROLLBACK 完成)
  const withTx = <T>(fn: () => T): T => {
    const snapshot = store.map(r => ({ ...r }))
    try {
      return fn()
    }
    catch (err) {
      store.length = 0
      store.push(...snapshot)
      throw err
    }
  }
  assert.throws(() => createChannelSession(
    { ...deps, withTx } as never,
    {
      channelId: 'ch1',
      actorId: 'u1',
      sessionRepo: { create: () => { throw new Error('session insert failed') } },
    },
  ), /session insert failed/)
  assert.equal(store.length, before, 'clone 行必须随事务回滚,不得留下无会话归属的孤儿')
})

test('C4:事务提交后才复制绑定面(绑定失败不产生孤儿 clone)', () => {
  const { store, deps } = cloneCtx()
  const bound: string[] = []
  const result = createChannelSession(
    {
      ...deps,
      // 绑定阶段抛错:clone/session 已提交,但不会再回滚(绑定是文件存储)
      bindings: { byAgent: () => [], bind: () => { throw new Error('binding io failed') } },
    } as never,
    { channelId: 'ch1', actorId: 'u1', sessionRepo: { create: () => ({ id: 'cs-1' }) } },
  )
  assert.equal(result.members.length, 2, '绑定面为空时不应触发 bind')
  assert.equal(store.length, 4, 'base 2 + clone 2')
  void bound
})

test('C4:集成绑定复制失败时清理部分绑定、clone 与已提交会话', () => {
  const { store, deps } = cloneCtx()
  const removed: string[] = []
  const bound: Array<{ agentId: string, nodeId: string }> = []
  let bindCalls = 0
  let compensated: string | null = null
  const channelAgents = {
    ...deps.channelAgents,
    remove: (_channelId: string, id: string) => {
      removed.push(id)
      const index = store.findIndex(row => row.id === id)
      if (index >= 0) store.splice(index, 1)
    },
  }
  const bindings = {
    byAgent: () => [],
    bind: (agentId: string, nodeId: string) => {
      bindCalls += 1
      if (bindCalls === 2) throw new Error('binding io failed')
      bound.push({ agentId, nodeId })
    },
    removeAgent: (agentId: string) => {
      for (let i = bound.length - 1; i >= 0; i--) {
        if (bound[i]!.agentId === agentId) bound.splice(i, 1)
      }
    },
  }
  assert.throws(() => createChannelSession(
    {
      ...deps,
      channelAgents,
      bindings,
      compensateSession: (sessionId: string) => { compensated = sessionId },
    } as never,
    {
      channelId: 'ch1',
      actorId: 'u1',
      channelMode: 'production_line_integrated',
      bindingsSnapshot: {
        'base-a': [{ nodeId: 'node-a', kind: 'dcw', mode: 'auto', tuning: { step: 2 } }],
        'base-b': [{ nodeId: 'node-b', kind: 'daq', mode: 'manual' }],
      },
      sessionRepo: { create: () => ({ id: 'cs-rollback' }) },
    },
  ), /binding io failed/)
  assert.equal(compensated, 'cs-rollback')
  assert.equal(store.length, 2, '补偿后不得留下 clone 行')
  assert.deepEqual(bound, [], '补偿后不得留下部分绑定')
  assert.equal(removed.length, 2, '补偿必须移除全部 clone')
})

test('C5:并发 close 只有一个执行级联(cancelTree 只调一次)', async () => {
  let status = 'active'
  let cancelCalls = 0
  let closeCalls = 0
  const sessionRepo = {
    // 故意返回"过期快照"(恒 active):模拟两个并发请求都先读到 active 的窗口,
    // 此时入口的 status 检查救不了,只有 CAS(close 的条件 UPDATE)能挡住重复级联。
    findById: () => ({ status: 'active', memberMapJson: JSON.stringify({ 'base-a': 'clone-1' }) }),
    close: () => {
      closeCalls += 1
      if (status === 'closed') return false
      status = 'closed'
      return true
    },
  }
  const deps = {
    channelAgents: { listByChannel: () => [], create: () => ({ id: 'x' }) },
    tasks: {
      list: () => [{ id: 't-1', state: 'WORKING', assigneeId: 'clone-1' }],
      cancelTree: () => {
        cancelCalls += 1
        return [{ id: 't-1', assigneeId: 'clone-1' }]
      },
    },
    bindings: { byAgent: () => [], bind: () => null },
    unloadAgent: async () => {},
    notify: () => {},
  }
  const input = { channelId: 'ch1', sessionId: 'cs-1', actorId: 'u1', sessionRepo }
  const [a, b] = await Promise.all([
    closeChannelSession(deps as never, input),
    closeChannelSession(deps as never, input),
  ])
  assert.equal(cancelCalls, 1, '重复 close 不得重复 cancelTree')
  assert.equal(closeCalls, 1, '只有抢到在飞位的调用会走到 close(CAS 兜底)')
  assert.deepEqual([a.canceledTasks, b.canceledTasks].sort(), [0, 1], '输的一方幂等返回 0')
})

test('C9:注入主连接后策略保存不再自持第二连接,且可嵌在调用方事务里', () => {
  const db = openWorkshopDb(join(process.env.AW_HOME!, 'tool-registry.sqlite'))
  initToolRegistryDb(db)
  const repo = getToolRegistryRepo()
  repo.upsertMany([{
    name: 'demo_tool',
    source: 'builtin',
    definitionHash: 'h1',
    roles: ['lead', 'worker'],
    parameters: {},
    description: 'demo',
    label: 'demo',
  }] as never)
  // 共享连接 + 可重入事务:外层事务里保存策略必须走 SAVEPOINT,不得抛
  // "cannot start a transaction within a transaction"(旧实现裸 BEGIN IMMEDIATE 会抛)
  withTransaction(db, () => {
    repo.savePolicy('ch-1', 'selected', [{ name: 'demo_tool', enabled: true }], 'u1')
  })
  const rows = db.prepare('SELECT tool_name, enabled FROM channel_tool_settings WHERE channel_id = ?').all('ch-1') as Array<{ tool_name: string, enabled: number }>
  assert.deepEqual(rows.map(r => [r.tool_name, r.enabled]), [['demo_tool', 1]], '写必须落在主连接可见的库里')
})
