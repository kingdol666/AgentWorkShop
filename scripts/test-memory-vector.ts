/**
 * 向量记忆管线测试:repo vec 方法(vec0 分区隔离/BigInt 绑定/刷新语义)+ embedding provider。
 * 用确定性 hash provider(零网络);真实 provider 由 env 配置,e2e 可选验证。
 * AgentMemory 混合召回融合断言由后续 task 追加(embedder 注入 AgentMemory 后)。
 * 运行: npx tsx scripts/test-memory-vector.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createMemoryRepo, TEAM_AGENT_ID } from '../server/services/workshop/db/memory.repo'
import { segmentCJK } from '../server/services/workshop/runtime/memory'
import {
  createEnvEmbeddingProvider,
  createHashEmbeddingProvider,
} from '../server/services/workshop/runtime/embedding-provider'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const DIMS = 64 // hash 词袋维度:过小(如 8)会哈希碰撞扰乱 top-1 语义
const db: DatabaseSync = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const embedder = createHashEmbeddingProvider(DIMS)
const embed = async (text: string): Promise<Float32Array> => (await embedder.embed([text]))[0]!

// ---- embedding provider:确定性 hash 词袋 ----
console.log('--- hash provider ---')
check('dims 返回构造维度', embedder.dims() === DIMS)
const [va, vb] = await embedder.embed(['登录 鉴权', '登录 鉴权'])
check('相同词集向量一致(确定性)', va!.every((x, i) => x === vb![i]))
const norm = Math.sqrt(va!.reduce((s, x) => s + x * x, 0))
check('向量归一化(L2=1)', Math.abs(norm - 1) < 1e-5, `norm=${norm.toFixed(5)}`)

// ---- embedding provider:env 驱动 + 熔断 ----
console.log('--- env provider ---')
const savedBase = process.env.AW_MEMORY_EMBED_BASE_URL
const savedModel = process.env.AW_MEMORY_EMBED_MODEL
const savedKey = process.env.AW_MEMORY_EMBED_API_KEY
delete process.env.AW_MEMORY_EMBED_BASE_URL
delete process.env.AW_MEMORY_EMBED_MODEL
delete process.env.AW_MEMORY_EMBED_API_KEY
check('env 未配置返回 null(纯 FTS 降级)', createEnvEmbeddingProvider() === null)
process.env.AW_MEMORY_EMBED_BASE_URL = 'http://127.0.0.1:1' // 立即拒绝,零等待
process.env.AW_MEMORY_EMBED_MODEL = 'test-model'
const breaker = createEnvEmbeddingProvider()!
for (let i = 0; i < 3; i++) await breaker.embed(['x']).catch(() => {})
const cooled = await breaker.embed(['x']).then(() => false, (e: Error) => e.message.includes('冷却'))
check('连续 3 次失败进入冷却熔断', cooled)
const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}
restoreEnv('AW_MEMORY_EMBED_BASE_URL', savedBase)
restoreEnv('AW_MEMORY_EMBED_MODEL', savedModel)
restoreEnv('AW_MEMORY_EMBED_API_KEY', savedKey)

// ---- repo:vec 延迟建表(首次 embed 维度)----
console.log('--- repo vec 方法 ---')
check('vecInit 首次建表', repo.vecInit(DIMS) === true)
check('vecInit 幂等(同维度)', repo.vecInit(DIMS) === true)
check('vecInit 维度不符拒绝(不重建)', repo.vecInit(4) === false)
check('vecReady 状态只读', repo.vecReady === true)

// rowid → agentId 映射(kNN 分区隔离断言用)
const rowAgent = new Map<number, string>()
const seed = async (agentId: string, title: string, content: string, key: string): Promise<void> => {
  repo.upsert({ channelId: 'ch1', agentId, kind: 'episodic-task', title, titleFts: segmentCJK(title), content: segmentCJK(content), importance: 0.8, taskId: key, dedupKey: `task:${key}` })
  const at = repo.findByAgentDedup(agentId, `task:${key}`)!
  rowAgent.set(at.rowid, agentId)
  repo.vecSet(at.rowid, agentId, await embed(segmentCJK(content)))
}
await seed('a1', '登录鉴权', '用OAuth2做了登录鉴权组件', 't1')
await seed('a1', '数据库调研', '选择SQLite作为存储', 't2')
await seed('a2', '他人登录杂事', '别的agent的登录内容', 't3')
await seed(TEAM_AGENT_ID, '团队规范', '本团队代码必须写测试', 'g1')

// ---- 域隔离 kNN(agent_id 分区;本人/team 各自命中,不串他人)----
const a1hits = repo.vecSearch('a1', await embed(segmentCJK('登录鉴权')), 5)
check('a1 向量命中本人记忆', a1hits.length >= 1 && a1hits.every(h => rowAgent.get(h.memRowid) === 'a1'), `hits=${JSON.stringify(a1hits)}`)
check('a1 top1 为登录鉴权记忆', a1hits[0]?.memRowid === repo.findByAgentDedup('a1', 'task:t1')?.rowid)
check('kNN 距离非负', a1hits.every(h => h.distance >= 0))
const teamHits = repo.vecSearch(TEAM_AGENT_ID, await embed(segmentCJK('团队规范') + ' 测试'), 5)
check('team 向量域命中(恒不串私有域)', teamHits.length >= 1 && teamHits.every(h => rowAgent.get(h.memRowid) === TEAM_AGENT_ID))

// ---- 刷新语义:重写 t1 内容后 vecSet 覆盖旧向量 ----
repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '登录鉴权', titleFts: segmentCJK('登录鉴权'), content: segmentCJK('重写为JWT方案'), importance: 0.8, taskId: 't1', dedupKey: 'task:t1' })
const t1at = repo.findByAgentDedup('a1', 'task:t1')!
repo.vecSet(t1at.rowid, 'a1', await embed(segmentCJK('重写为JWT方案')))
const refreshed = repo.vecSearch('a1', await embed(segmentCJK('JWT方案')), 5)
check('vecSet 刷新后新向量命中', refreshed.length >= 1 && refreshed[0]!.memRowid === t1at.rowid && refreshed[0]!.distance < 1.0, `top=${JSON.stringify(refreshed[0])}`)
const oldQ = repo.vecSearch('a1', await embed(segmentCJK('OAuth2登录鉴权组件')), 5)
check('旧向量不再零距命中(已替换)', oldQ.every(h => h.distance > 0.5), `hits=${JSON.stringify(oldQ)}`)

// ---- vecDelete(删除记忆联动;不炸未向量化的 rowid)----
const t2at = repo.findByAgentDedup('a1', 'task:t2')!
repo.vecDelete(t2at.rowid)
check('vecDelete 后不命中', repo.vecSearch('a1', await embed(segmentCJK('SQLite存储')), 5).every(h => h.memRowid !== t2at.rowid))
repo.vecDelete(999_999) // 不存在的 rowid:静默
check('vecDelete 不存在的 rowid 静默', true)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
