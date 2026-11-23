/**
 * 鉴权先于资源查找(2026-11-23 发布前 API 审查)。
 *
 * 未鉴权调用者若先拿到「资源不存在」的 404,就能借 404 与 401 的差异枚举 ID 是否存在。
 * 这些 handler 过去都是「先查资源 → 404 → resolveUser」,这里锁定修正后的顺序;
 * 行为面的证明见发布验收的路线扫描(未鉴权探测全部 401)。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
/** 只看 handler 主体(export default 起)的首次出现位置;未出现返回 Infinity */
function firstIndex(source: string, pattern: RegExp): number {
  const body = source.slice(source.indexOf('export default'))
  const match = body.match(pattern)
  return match ? match.index : Number.POSITIVE_INFINITY
}

const AUTH_FIRST: Array<[string, RegExp]> = [
  ['server/api/workshop/agents/[id].get.ts', /manager\.getAgent\(/],
  ['server/api/workshop/agents/[id].delete.ts', /manager\.getAgent\(/],
  ['server/api/workshop/channel-templates/[id].get.ts', /manager\.getChannelTemplate\(/],
  ['server/api/workshop/teams/[id].get.ts', /manager\.getTeam\(/],
  ['server/api/workshop/teams/[id]/members/index.get.ts', /manager\.getTeam\(/],
  ['server/api/workshop/tasks/[id].get.ts', /taskEngineOf\(manager\)\.get\(/],
  ['server/api/workshop/tasks/[id]/cancel/index.post.ts', /taskEngineOf\(manager\)\.get\(/],
  ['server/api/workshop/tasks/[id]/retry.post.ts', /taskEngineOf\(manager\)\.get\(/],
  ['server/api/workshop/tasks/[id]/reopen.post.ts', /\.getTaskEngine\?\.\(\)\.get\(/],
  ['server/api/workshop/tasks/[id]/update.post.ts', /\.getTaskEngine\(\)\.get\(/],
  ['server/api/workshop/daq/[id]/ingest.post.ts', /getDaqController\(\)\.byId\(/],
]

test('资源详情与任务 handler 先验身份再查资源', () => {
  for (const [file, lookup] of AUTH_FIRST) {
    const source = read(file)
    const auth = firstIndex(source, /resolveUser\(event\)/)
    const lookupAt = firstIndex(source, lookup)
    assert.ok(Number.isFinite(auth), `${file} 必须解析用户身份`)
    assert.ok(Number.isFinite(lookupAt), `${file} 必须查找资源`)
    assert.ok(auth < lookupAt, `${file}: resolveUser 必须先于资源查找(否则 404 成为未鉴权枚举 oracle)`)
  }
})

test('A2A RPC message/send 先验发送方 token 再判目标;agent/getCard 与 HTTP card 共用公开开关', () => {
  const rpc = read('server/api/workshop/a2a/[agentId]/rpc/index.post.ts')
  const send = rpc.slice(rpc.indexOf('case \'message/send\':'), rpc.indexOf('case \'agent/getCard\':'))
  assert.ok(send.includes('manager.findByToken(') && send.includes('findAgent(manager, agentId)'), 'message/send 必须同时验 token 与判目标')
  assert.ok(
    send.indexOf('manager.findByToken(') < send.indexOf('findAgent(manager, agentId)'),
    'message/send: 未鉴权调用者不得先拿到 -32001(Agent not found)',
  )
  const cardStart = rpc.indexOf('case \'agent/getCard\':')
  const card = rpc.slice(cardStart, rpc.indexOf('default:', cardStart))
  assert.ok(
    card.indexOf('canReadAgentCard(event)') !== -1 && card.indexOf('canReadAgentCard(event)') < card.indexOf('findAgent(manager, agentId)'),
    'agent/getCard: 公开开关关闭时先验身份,再判 Agent 是否存在',
  )
  assert.match(
    read('server/api/workshop/a2a/[agentId]/card/index.get.ts'),
    /if \(!canReadAgentCard\(event\)\)/,
    'HTTP card 端点必须走同一守卫',
  )
})
