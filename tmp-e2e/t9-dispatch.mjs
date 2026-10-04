// T9: 线3(MQTT)/线4(HTTP) 跨协议数据巡检任务
const B = 'http://localhost:3001'
const TOK = (await (await fetch(`${B}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }),
})).json()).data?.token
const H = { 'authorization': `Bearer ${TOK}`, 'content-type': 'application/json' }

const t9a = {
  title: '终测T9a·MQTT测厚线数据巡检',
  description: '你是线3(在线测厚仪,MQTT 协议)的量测工程师。用 daq_query 读取 dn-b8ee4f86(thick,μm)最近 5 分钟数据:给出样本数/均值/min/max/std,判读厚度是否在 78~90μm 工艺带内;若有越界趋势给一句量测建议。complete_task 交付统计表与结论(必须引用实测数值与时间窗,不得编造)。',
  assigneeId: '7a3f86fd-7170-413f-9f27-b1966e3c038b',
}
const t9b = {
  title: '终测T9b·HTTP CCD检测线数据巡检',
  description: '你是线4(CCD检测站,HTTP 协议)的质量工程师。用 daq_query 读取 dn-79957615(defect,个/m²)最近 5 分钟数据:给出样本数/均值/min/max/std,判读缺陷密度是否 <10 个/m² 验收线;若有恶化趋势给一句质检建议。complete_task 交付统计表与结论(必须引用实测数值与时间窗,不得编造)。',
  assigneeId: 'a12c1618-545c-41ad-a6ba-df6e7130e1d2',
}
const r3 = await (await fetch(`${B}/api/workshop/channels/ad44dbe4-10b3-445f-b956-2ac6e443df53/tasks`, { method: 'POST', headers: H, body: JSON.stringify(t9a) })).json()
console.log('T9a:', r3.code, r3.data?.id ?? r3.message)
const r4 = await (await fetch(`${B}/api/workshop/channels/cc06b794-23b3-4bfb-aed0-fd1270ad92ab/tasks`, { method: 'POST', headers: H, body: JSON.stringify(t9b) })).json()
console.log('T9b:', r4.code, r4.data?.id ?? r4.message)
