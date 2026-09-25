/** 临时:查看 FAILED 根任务的执行租约是否回收(定位"根队列 FAILED 后不再派发") */
const { DatabaseSync } = require('node:sqlite')

const db = new DatabaseSync('D:/codes/ABO/AgentWorkShop/.aw0746-home/data/workshop.sqlite', { readOnly: true })
const channelId = process.argv[2] ?? '81230448-c463-444c-bec2-c2f62721c17c'
const rows = db.prepare(`select id, state, root_queue_seq as seq, assignee_id as a,
    execution_lease_id as lease, execution_lease_agent_id as leaseAgent,
    execution_lease_started_at as leaseStart, execution_lease_revoked_at as leaseRevoked, close_reason as closeReason
  from tasks where channel_id = ? order by rowid desc limit 6`).all(channelId)
for (const r of rows) {
  console.log(`${String(r.id).slice(0, 8)} ${String(r.state).padEnd(10)} seq=${r.seq} assignee=${String(r.a).slice(0, 8)}`)
  console.log(`   lease=${String(r.lease).slice(0, 12) || '-'} leaseAgent=${String(r.leaseAgent).slice(0, 8) || '-'} started=${r.leaseStart ?? '-'} revoked=${r.leaseRevoked ?? '(未回收)'} close=${r.closeReason ?? '-'}`)
}
