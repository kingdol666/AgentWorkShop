/**
 * 视觉走查用示范数据集 —— 用 visual 账号通过公开 REST 建一套「像真产线」的工作区:
 * 工作区 + 3 个语义化频道(mock harness, 带 streamDemo 流式事件) + 一次真实派发。
 *
 * 为什么不复用仓库里已有的 43 个频道:它们是压测遗留的 team-ip16i7gy 之类机读名,
 * 拿来当 README/GIF 的素材会让截图说不出故事。这里只新增,不改动既有数据。
 */
import { ensureVisualUser, api } from './lib.mjs'

const token = await ensureVisualUser()

const CHANNELS = [
  {
    name: '熔温优化',
    scenarioPrompt: '分析熔体温度趋势并优化设定值:读取近 24h 历史,做统计与异常剔除,给出新设定值建议,走 HITL 审批后写入 PLC 并回读校验。',
    lead: 'melt-lead',
    workers: [
      { name: 'trend-analyst', role: 'worker' },
      { name: 'setpoint-writer', role: 'worker' },
    ],
    goal: '分析 1 号挤出线的熔体温度趋势,给出把温控设定值下调 5°C 的依据,并说明风险。',
  },
  {
    name: '厚度扫描诊断',
    scenarioPrompt: '厚度扫描仪的多点剖面数据诊断:定位横向厚度偏差来源,给出模头螺栓调整建议。',
    lead: 'scan-lead',
    workers: [{ name: 'profile-analyst', role: 'worker' }],
    goal: '诊断 abw16t4v19 的横向厚度剖面偏差,指出偏差最大的点位。',
  },
  {
    name: '配方调优',
    scenarioPrompt: '配方参数寻优:在工艺窗口内搜索更优参数组合,记录每次试验并给出推荐版本。',
    lead: 'recipe-lead',
    workers: [{ name: 'doe-runner', role: 'worker' }],
    goal: '在工艺窗口内搜索一组更优的牵引速度与冷却水温组合。',
  },
]

const existing = await api('GET', '/api/workshop/workspaces', { token })
const wsList = existing.data?.workspaces ?? existing.data ?? []
let ws = Array.isArray(wsList) ? wsList.find(w => w.name === '示范产线') : null
if (!ws) {
  const r = await api('POST', '/api/workshop/workspaces', { body: { name: '示范产线' }, token })
  ws = r.data
}
const wsId = ws?.id ?? ws?.workspaceId
if (!wsId) throw new Error('workspace 创建失败: ' + JSON.stringify(existing).slice(0, 300))
console.log('workspace:', wsId, ws?.name)

const channels = []
const chList = await api('GET', '/api/workshop/channels', { token })
const all = chList.data?.channels ?? chList.data ?? []
for (const spec of CHANNELS) {
  let ch = (Array.isArray(all) ? all : []).find(c => c.name === spec.name)
  if (!ch) {
    const r = await api('POST', '/api/workshop/channels', {
      body: {
        name: spec.name,
        scenarioPrompt: spec.scenarioPrompt,
        leadAgent: { name: spec.lead, harness: 'mock', config: { delayMs: 260, streamDemo: true } },
      },
      token,
    })
    ch = r.data
    if (!ch) {
      console.log('channel fail', spec.name, JSON.stringify(r).slice(0, 200))
      continue
    }
    const cid = ch.channelId ?? ch.id
    for (const wk of spec.workers) {
      await api('POST', `/api/workshop/channels/${cid}/agents`, {
        body: { name: wk.name, harness: 'mock', role: wk.role, config: { delayMs: 300, streamDemo: true } },
        token,
      })
    }
  }
  const cid = ch.channelId ?? ch.id
  channels.push({ id: cid, name: spec.name, goal: spec.goal })
  await api('POST', `/api/workshop/workspaces/${wsId}/channels/${cid}`, { token })
  console.log('mounted channel:', spec.name, cid)
}

console.log(JSON.stringify({ wsId, channels }, null, 1))
