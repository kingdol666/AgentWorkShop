/**
 * AgentMemory P0 测试:repo(FTS/去重/touch/delete/team 预埋)→ 模块(排序/预算/格式)→ 运行时集成。
 * 运行: npx tsx scripts/test-memory.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createMemoryRepo, TEAM_AGENT_ID } from '../server/services/workshop/db/memory.repo'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const db: DatabaseSync = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const seg = (s: string): string => s.replace(/([\u4e00-\u9fff])/g, ' $1 ')

// ---- repo:写入 + CJK FTS 检索(title 经 titleFts 切分入索引;content 切分传入)----
repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '实现登录页面', titleFts: seg('实现登录页面'), content: seg('用OAuth2方案完成了登录鉴权'), importance: 0.8, taskId: 't1', dedupKey: 'task:t1' })
repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '数据库调研', titleFts: seg('数据库调研'), content: seg('最终选择SQLite因为轻量嵌入式'), importance: 0.8, taskId: 't2', dedupKey: 'task:t2' })
repo.upsert({ channelId: 'ch1', agentId: 'a2', kind: 'episodic-task', title: '他人记忆', titleFts: seg('他人记忆'), content: seg('别的agent的登录杂事'), importance: 0.8, taskId: 't3', dedupKey: 'task:t3' })

const hit = repo.search('a1', `${seg('登录').trim()} OR oauth`, 5)
check('FTS 中英混合检索命中(经 titleFts)', hit.length >= 1 && hit[0].title === '实现登录页面', `hits=${hit.length}`)
check('展示 title 保持原文(未切分)', hit[0]?.title === '实现登录页面')
check('FTS 不串他人私有记忆', hit.every(r => r.agentId === 'a1'))

// ---- repo:team 域预埋(search 恒含 team 行)----
repo.upsert({ channelId: 'ch1', agentId: TEAM_AGENT_ID, kind: 'semantic', title: 'channel 代码风格', titleFts: seg('channel 代码风格'), content: seg('全部使用TypeScript strict模式'), importance: 0.9, taskId: null, dedupKey: 'style:ts' })
const teamQuery = seg('代码风格').trim().split(/\s+/).join(' OR ') // → '代 OR 码 OR 风 OR 格'
const teamHit = repo.search('a1', teamQuery, 5)
check('team 记忆对所有 agent 可见(经 titleFts 命中)', teamHit.some(r => r.agentId === TEAM_AGENT_ID))
check('listRecent 严格本人(不含 team)', !repo.listRecent('a1', 10).some(r => r.agentId === TEAM_AGENT_ID))

// ---- repo:去重 upsert ----
repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '实现登录页面', titleFts: seg('实现登录页面'), content: seg('重跑后改用JWT方案'), importance: 0.8, taskId: 't1', dedupKey: 'task:t1' })
check('同 dedupKey 去重', repo.listByAgent('a1', 10).length === 2)
check('upsert 刷新后 FTS 同步', repo.search('a1', 'jwt', 5).length === 1)
const dedup = repo.findByAgentDedup('a1', 'task:t1')
check('findByAgentDedup 返回 id+rowid', dedup !== null && typeof dedup.rowid === 'number')

// ---- repo:touch + delete ----
repo.touch(dedup!.id)
check('touch 递增 access_count', repo.listByAgent('a1', 10).find(r => r.id === dedup!.id)!.accessCount >= 1)
const teamDel = repo.findByAgentDedup(TEAM_AGENT_ID, 'style:ts')!
check('team 行去重键独立', teamDel !== null)
check('delete 返回 true 且 FTS 同步清理', repo.delete(dedup!.id) === true && repo.search('a1', 'jwt', 5).length === 0)
check('listMemoryAgentIds 排除 team', repo.listMemoryAgentIds().includes(TEAM_AGENT_ID) === false)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
