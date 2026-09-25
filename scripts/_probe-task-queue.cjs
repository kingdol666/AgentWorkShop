/** 临时:SQLite 直查 channel 的任务队列字段(定位 SUBMITTED 不被派发) */
const { DatabaseSync } = require('node:sqlite')

const db = new DatabaseSync('D:/codes/ABO/AgentWorkShop/.aw0746-home/data/workshop.sqlite', { readOnly: true })
const channelId = process.argv[2] ?? '81230448-c463-444c-bec2-c2f62721c17c'
const rows = db.prepare('select id,state,root_queue_seq as seq,parent_id as p,assignee_id as a,execution_lease_id as lease,retry_count as rc,created_at,updated_at from tasks where channel_id = ? order by rowid desc limit 10').all(channelId)
for (const r of rows) {
  console.log(`${String(r.id).slice(0, 8)} ${String(r.state).padEnd(10)} seq=${String(r.seq)} parent=${r.p ? 'y' : '-'} assignee=${String(r.a).slice(0, 8)} lease=${r.lease ? 'y' : '-'} rc=${r.rc} ${r.created_at}`)
}
