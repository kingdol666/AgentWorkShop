/**
 * 治理线守卫(2026-11-10 审计 A8/C10/D6/D7)。
 *
 * A8:observe/executionMode 读取失败时静默回落 auto —— 档位不变,但"observe 频道
 *     短暂恢复写面"这件事必须可观测。
 * C10:会话创建无并发上限(每会话克隆全部基础成员并各起独立 runtime/进程)。
 * D7:memoryPolicy 只有消费端(写入门按策略判定),生产端从不传 → line/global
 *     经验写入整条链路不可达。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createChannelSession } from '../server/services/workshop/agents/session-clone'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

test('D7: memoryPolicy 透传到 session 行(session 默认 / shared 解锁跨频道经验)', () => {
  const store = [{ id: 'base-a', name: 'Alice', harness: 'mock', role: 'worker', enabled: 1, agentKind: null, configJson: '{}' }]
  const seen: Array<string | undefined> = []
  const deps = {
    channelAgents: {
      listByChannel: () => store,
      create: () => {
        const row = { id: `clone-${store.length}`, name: `Alice·session·${store.length}`, harness: 'mock', role: 'worker', enabled: 1, agentKind: null, configJson: '{}' }
        store.push(row as never)
        return row
      },
    },
    tasks: { list: () => [], cancelTree: () => [] },
    bindings: { byAgent: () => [], bind: () => null },
    unloadAgent: async () => {},
    notify: () => {},
  }
  const sessionRepo = {
    create: (input: { memoryPolicy?: string }) => {
      seen.push(input.memoryPolicy)
      return { id: 'cs-1' }
    },
  }
  createChannelSession(deps as never, { channelId: 'ch1', actorId: 'u1', memoryPolicy: 'shared', sessionRepo })
  createChannelSession(deps as never, { channelId: 'ch1', actorId: 'u1', sessionRepo })
  assert.deepEqual(seen, ['shared', undefined], 'shared 必须透传;缺省交给 repo 落 session')
})

test('D7: 创建会话 API 接受 memoryPolicy 枚举(非法值 400)', () => {
  const src = read('server/api/workshop/channels/[id]/sessions/index.post.ts')
  assert.match(src, /memoryPolicy: z\.enum\(\['session', 'shared'\]\)/, '必须白名单枚举(不接受 channel:无语义)')
  assert.match(src, /memoryPolicy: body\.memoryPolicy/, '必须透传给 manager')
})

test('C10: 每频道活动会话上限可配置,超限 429', () => {
  const src = read('server/services/workshop/runtime/manager/admin-agents.ts')
  assert.match(src, /max_active_sessions_per_channel/, '必须读设置项')
  assert.match(src, /SESSION_LIMIT/, '超限必须显式 429,不能静默创建')
  const schema = JSON.parse(read('shared/config/schema.json')) as { settings: Array<{ key: string, default?: unknown }> }
  const entry = schema.settings.find(s => s.key === 'workshop.max_active_sessions_per_channel')
  assert.ok(entry, 'schema.json 必须有该设置项')
  assert.equal(entry!.default, 8, '缺省 8(0=不限)')
})

test('A8: 档位读取失败必须留痕(不改变判定值)', () => {
  const mode = read('server/services/workshop/agents/execution-mode.ts')
  assert.equal((mode.match(/console\.error\(`\[execution-mode\]/g) ?? []).length, 2, '两个 catch 都要 log')
  assert.match(mode, /return 'auto'/, '兜底值不得改(fail-safe 由线/绑定层承担)')

  const profile = read('server/services/workshop/aml/twin/channel-profile.ts')
  assert.match(profile, /console\.error\(`\[channel-profile\]/, '档位读失败必须可观测')
})
