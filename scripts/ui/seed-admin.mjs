/**
 * 给 admin 账号准备一套可看的演示数据(工作区 + 3 个频道 + 挂载)。
 * 幂等:已存在就不重复建。admin 是文档里写的管理员账号(admin@awshop.local),
 * 而演示工作区原本挂在另一个账号下 —— 不补的话 /town 与 /workshop 会是空态。
 *
 * ⚠️ 本文件的 api() 是**位置参数** (m, p, body, token);别照抄 lib.mjs 的
 * options-object 写法 —— 混用会把 {body,token} 整体当成请求体序列化出去,
 * 服务端 zod 校验失败但外层仍是 200,排查时极具迷惑性(已踩)。
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3021'
const api = async (m, p, body, token) => {
  const h = { 'content-type': 'application/json' }
  if (token) h.authorization = 'Bearer ' + token
  const r = await fetch(BASE + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  try {
    return JSON.parse(t)
  }
  catch {
    return { code: -1, message: 'HTTP ' + r.status }
  }
}
const login = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })
const token = login.data.token
console.log('admin:', login.data.user.name, login.data.user.role)

const WANT = [
  { name: '熔温优化', prompt: '分析熔体温度趋势并优化设定值:读取历史,统计与异常剔除,给出新设定值建议,走 HITL 审批后写入 PLC 并回读校验。', lead: 'melt-lead', workers: ['trend-analyst', 'setpoint-writer'] },
  { name: '厚度扫描诊断', prompt: '厚度扫描仪多点剖面诊断:定位横向厚度偏差来源,给出模头螺栓调整建议。', lead: 'scan-lead', workers: ['profile-analyst'] },
  { name: '配方调优', prompt: '配方参数寻优:在工艺窗口内搜索更优参数组合,记录每次试验并给出推荐版本。', lead: 'recipe-lead', workers: ['doe-runner'] },
]

let wsList = await api('GET', '/api/workshop/workspaces', null, token)
let list = wsList.data ?? []
let ws = list.find(w => w.name === '示范产线')
if (!ws) {
  const r = await api('POST', '/api/workshop/workspaces', { name: '示范产线' }, token)
  ws = r.data
}
const wsId = ws?.id
if (!wsId) throw new Error('工作区创建失败: ' + JSON.stringify(wsList).slice(0, 200))
console.log('workspace:', wsId, ws.name)

const chList = await api('GET', '/api/workshop/channels', null, token)
const all = chList.data?.channels ?? chList.data ?? []
for (const spec of WANT) {
  let ch = (Array.isArray(all) ? all : []).find(c => c.name === spec.name)
  if (!ch) {
    const r = await api('POST', '/api/workshop/channels', {
      name: spec.name,
      scenarioPrompt: spec.prompt,
      leadAgent: { name: spec.lead, harness: 'mock', config: { delayMs: 260, streamDemo: true } },
    }, token)
    ch = r.data
    if (!ch) {
      console.log('  建频道失败', spec.name, JSON.stringify(r).slice(0, 150))
      continue
    }
    for (const w of spec.workers) {
      await api('POST', `/api/workshop/channels/${ch.channelId ?? ch.id}/agents`, { name: w, harness: 'mock', role: 'worker', config: { delayMs: 300, streamDemo: true } }, token)
    }
  }
  const cid = ch.channelId ?? ch.id
  await api('POST', `/api/workshop/workspaces/${wsId}/channels/${cid}`, {}, token)
  console.log('  挂载:', spec.name, cid)
}
const after = await api('GET', '/api/workshop/workspaces', null, token)
console.log('workspaces now:', JSON.stringify(after.data).slice(0, 300))
