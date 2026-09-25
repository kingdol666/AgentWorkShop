/** 临时:核验「模型 ↔ Channel」在数据模型上是否可推导(用打包实例 DB) */
const { DatabaseSync } = require('node:sqlite')

const db = new DatabaseSync('D:/codes/ABO/AgentWorkShop/.aw0746-home/data/workshop.sqlite', { readOnly: true })
const q = (sql) => {
  try {
    return db.prepare(sql).all()
  }
  catch (e) {
    return [{ error: e.message }]
  }
}
console.log('=== aml_models 列 ===')
console.log(q('pragma table_info(aml_models)').map(c => c.name).join(','))
console.log('\n=== aml_jobs 列 ===')
console.log(q('pragma table_info(aml_jobs)').map(c => c.name).join(','))
console.log('\n=== 模型 → 实验 → 作业 → Channel 联查 ===')
console.log(q(`select m.id as model, m.stage, m.dataset_id, e.job_id, j.channel_id, j.agent_id, d.line_id
  from aml_models m
  left join aml_experiments e on e.id = m.experiment_id
  left join aml_jobs j on j.id = e.job_id
  left join aml_datasets d on d.id = m.dataset_id
  order by m.created_at desc limit 6`))
console.log('\n=== 有多少 AML 作业带 channel_id ===')
console.log(q(`select count(*) total, sum(case when channel_id is not null and channel_id <> '' then 1 else 0 end) with_channel from aml_jobs`))
