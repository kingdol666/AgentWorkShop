/**
 * 事件历史查询验证(channel-event.repo 过滤查询):
 *  1. 内存库:agentId / excludeTypes / beforeSeq 组合语义 + count 同口径 + 幂等 insert;
 *  2. 生产库只读抽查:对存量 channel 验证「agent 维度历史不再被 delta 淹没」——
 *     全局 200 帧窗口里 0 条 a2a.message 的 channel,按 agent 过滤后消息可完整取回。
 */
import { DatabaseSync } from 'node:sqlite'
import { createChannelEventRepo } from '../server/services/workshop/db/channel-event.repo'

let failures = 0
const ok = (name: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures += 1
}

// ---------- 1. 内存库语义验证 ----------
console.log('[1] 内存库:过滤查询语义')
const mem = new DatabaseSync(':memory:')
mem.exec(`
  CREATE TABLE channel_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    at TEXT NOT NULL,
    agent_id TEXT,
    task_id TEXT,
    payload_json TEXT NOT NULL,
    UNIQUE(channel_id, seq)
  );
  CREATE INDEX idx_channel_events_channel ON channel_events(channel_id, seq DESC);
`)
const repo = createChannelEventRepo(mem)
const CH = 'ch-test'
const AG_A = 'agent-a'
const AG_B = 'agent-b'
// seq 1..12:A 两条 delta + 消息,B 的消息夹在中间,A 的更早消息在窗口外
const fixture: Array<[number, string, string | null]> = [
  [1, 'a2a.message', AG_A],
  [2, 'agent.delta', AG_A],
  [3, 'agent.delta', AG_A],
  [4, 'agent.message', AG_A],
  [5, 'a2a.message', AG_B],
  [6, 'agent.status', AG_B],
  [7, 'agent.delta', AG_B],
  [8, 'a2a.message', AG_A],
  [9, 'task.status', null],
  [10, 'agent.delta', AG_A],
  [11, 'a2a.message', AG_B],
  [12, 'agent.status', AG_A],
]
for (const [seq, type, agentId] of fixture) {
  repo.insert(CH, { seq, type, at: `2026-08-23T00:00:${String(seq).padStart(2, '0')}Z`, agentId, taskId: null, payload: { t: seq } })
}
// 幂等:同 seq 重插不报错不重复
repo.insert(CH, { seq: 1, type: 'a2a.message', at: 'x', agentId: AG_A, taskId: null, payload: {} })
ok('insert 幂等(同 seq 重插)', repo.count(CH) === 12, `count=${repo.count(CH)}`)

// agentId 过滤
const aRecent = repo.listRecent(CH, 10, { agentId: AG_A })
ok('agentId 过滤仅返回该 agent', aRecent.length === 7 && aRecent.every(e => e.agentId === AG_A), `n=${aRecent.length}`)
ok('listRecent 正序返回', aRecent[0]!.seq === 1 && aRecent.at(-1)!.seq === 12)

// excludeTypes:剔除 delta 后 A 的历史只剩实质帧
const aNoDelta = repo.listRecent(CH, 100, { agentId: AG_A, excludeTypes: ['agent.delta'] })
ok('agentId + excludeTypes 组合', aNoDelta.length === 4 && aNoDelta.every(e => e.type !== 'agent.delta'),
  `types=[${aNoDelta.map(e => e.type).join(',')}]`)

// count 同口径
ok('count 尊重过滤条件', repo.count(CH, { agentId: AG_A, excludeTypes: ['agent.delta'] }) === 4)

// beforeSeq 翻页(A 视角:seq < 8 且剔除 delta → 1、4 两帧)
const aBefore = repo.listBefore(CH, 8, 10, { agentId: AG_A, excludeTypes: ['agent.delta'] })
ok('listBefore + 过滤组合', aBefore.length === 2 && aBefore.map(e => e.seq).join(',') === '1,4',
  `seqs=[${aBefore.map(e => e.seq).join(',')}]`)

// 无过滤路径向后兼容(旧签名)
const plain = repo.listRecent(CH, 3)
ok('无过滤调用向后兼容', plain.length === 3 && plain.at(-1)!.seq === 12)

// payload 反序列化
ok('payload JSON 反序列化', aRecent[0]!.payload != null && JSON.stringify(aRecent[0]!.payload).includes('"t"'))

// ---------- 2. 生产库只读抽查 ----------
console.log('[2] 生产库只读抽查(data/workshop.sqlite)')
try {
  const prod = new DatabaseSync('data/workshop.sqlite', { readOnly: true })
  const prodRepo = createChannelEventRepo(prod)
  const row = prod.prepare(`SELECT channel_id, MAX(agent_id) ag FROM channel_events WHERE type='a2a.message' AND agent_id IS NOT NULL AND agent_id != '' GROUP BY channel_id ORDER BY COUNT(*) DESC LIMIT 1`).get() as { channel_id: string, ag: string } | undefined
  if (!row) {
    console.log('  (生产库无 a2a.message 样本,跳过)')
  }
  else {
    const ch = row.channel_id
    const totalMsg = (prod.prepare(`SELECT COUNT(*) n FROM channel_events WHERE channel_id=? AND type='a2a.message'`).get(ch) as { n: number }).n
    // 全局 200 帧窗口(含 delta)里的消息数
    const winMsg = (prod.prepare(`SELECT COUNT(*) n FROM channel_events WHERE channel_id=? AND seq > (SELECT MAX(seq)-200 FROM channel_events WHERE channel_id=? ) AND type='a2a.message'`).get(ch, ch) as { n: number }).n
    // agent 维度 + 剔除 delta 的 200 帧
    const laneList = prodRepo.listRecent(ch, 200, { agentId: row.ag, excludeTypes: ['agent.delta'] })
    const laneMsg = laneList.filter(e => e.type === 'a2a.message').length
    console.log(`  channel ${ch.slice(0, 8)} · agent ${row.ag.slice(0, 8)}:`)
    ok('全局 200 帧窗口被流式帧淹没(复现根因)', winMsg < totalMsg, `窗口内消息 ${winMsg}/${totalMsg}`)
    ok('agent 维度过滤取回完整消息', laneMsg > winMsg, `lane 内消息 ${laneMsg} > 全局窗口 ${winMsg}`)
    prod.close()
  }
}
catch (err) {
  console.log(`  (生产库不可读,跳过:${err instanceof Error ? err.message : String(err)})`)
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`)
process.exit(failures === 0 ? 0 : 1)
