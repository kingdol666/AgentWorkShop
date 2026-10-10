// 真实作业腿(anneal-line 新频道):MES 直取取数 + recipe HITL 下发 + 工艺响应复测
// 执行者 = 新频道内持配方绑定的 Agent(工艺工程师,工具桥直调 = Agent 真实工具语义)
import { readFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3001'
const prov = JSON.parse(readFileSync('tmp-e2e/anneal-onboarding/provision-result.log', 'utf8').split('\n').find(l => l.startsWith('{')))
const forge = JSON.parse(readFileSync('tmp-e2e/anneal-onboarding/forge-result.log', 'utf8').split('\n').find(l => l.startsWith('{')))
const checks = []
let TOKEN = (await (await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }) })).json()).data?.token
const H = { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` }
const ok = (name, cond, detail = '') => {
  checks.push(!!cond)
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${String(detail).slice(0, 150)}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(m, u, b) {
  return (await fetch(BASE + u, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) })).json()
}
async function inv(agentId, tool, args, timeoutMs = 300_000) {
  const res = await fetch(BASE + '/api/workshop/agent-tools/invoke', { method: 'POST', headers: H, body: JSON.stringify({ agentId, tool, args }), signal: AbortSignal.timeout(timeoutMs) })
  const j = await res.json().catch(() => ({}))
  return j?.data?.result ?? { text: JSON.stringify(j).slice(0, 200), isError: j?.code !== 0 }
}
async function adjudicate(pattern, comment, choice) {
  for (let i = 0; i < 60; i++) {
    await sleep(2000)
    const pend = await api('GET', '/api/workshop/hitl/pending')
    const items = pend?.data?.items ?? []
    const card = items.filter(x => x.kind === 'dcw-approval' && pattern.test(String(x.nodeId ?? '')))
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
    if (card) {
      await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, comment, ...(Number.isInteger(choice) ? { choice } : {}) })
      return card
    }
  }
  return null
}

const channelId = forge.channelId
// 找持配方绑定的 worker 实例 id(工艺工程师)+ 持 daq 绑定的分析师(读面分离,权限模型 v2)
const members = await api('GET', `/api/workshop/channels/${channelId}/agents`)
const mArr = members?.data?.items ?? members?.data ?? []
const bs = await api('GET', '/api/workshop/agent-tools/bindings')
const recipeBinding = (bs?.data?.bindings ?? []).find(b => b.kind === 'recipe' && b.nodeId === prov.recipeId)
const workerId = recipeBinding?.agentId ?? ''
const analystId = (bs?.data?.bindings ?? []).find(b => b.kind === 'daq' && b.nodeId === prov.daq['硬度HV'])?.agentId ?? ''
ok('J1 频道内持配方绑定的 Agent 在位(工艺工程师)', !!workerId, `${workerId.slice(0, 8)} member=${(mArr.find(m => m.agentId === workerId)?.name ?? mArr.find(m => m.id === workerId)?.name ?? '?').slice(0, 12)}`)

// J2 MES 直取:mes_fetch 30 分钟窗(ISO from/to;ids=节点 id,可见面=授权配方参数)
const now = Date.now()
const mes = await inv(workerId, 'mes_fetch', { ids: [prov.dcw['MES温度序列'], prov.dcw['MES压力序列']], from: new Date(now - 30 * 60_000).toISOString(), to: new Date(now).toISOString(), max_rows: 2000 })
const mesTxt = String(mes.text ?? '')
console.log('  [mes_fetch full]\n    ' + mesTxt.split('\n').join('\n    ').slice(0, 900))
const nodeFails = (mesTxt.match(/取数失败/g) ?? []).length
ok('J2 MES 直取取数(mes_fetch 30min 窗,逐点成功)', !mes.isError && /历史取数/.test(mesTxt) && nodeFails === 0, `${mesTxt.split('\n')[0]?.slice(0, 80)} 失败点=${nodeFails}`)
ok('J3 MES 取到真实行(行数>0 且含统计)', !/取数失败/.test(mesTxt) && /\d/.test(mesTxt) && /均值|mean|min|max|行/i.test(mesTxt), (mesTxt.match(/共\s*\d+\s*行|(\d+)\s*行/)?.[0] ?? mesTxt.slice(0, 80)))

// J0 基线固化:把基线配方对齐设备现况(757/762/760/128/410/65/9;预检限界保护实证:
// 文档值 745/120 与现况脱节时,提案权被限界正确拒绝 —— 先快照现况再寻优)
const updP = inv(workerId, 'recipe_update', {
  recipe_id: prov.recipeId,
  params: [
    { node_id: prov.dcw['均热区1炉温SP'], value: 757 },
    { node_id: prov.dcw['均热区2炉温SP'], value: 762 },
    { node_id: prov.dcw['均热区3炉温SP'], value: 760 },
    { node_id: prov.dcw['线速SP'], value: 128 },
    { node_id: prov.dcw['过时效温度SP'], value: 410 },
    { node_id: prov.dcw['冷却档位SP'], value: 65 },
    { node_id: prov.dcw['氢气占比SP'], value: 9 },
  ],
  reason: '投用 J0:基线配方对齐设备现况快照(现值读数;寻优起点)',
})
const updCard = await adjudicate(/^recipe:/, '投用裁决:批准基线固化到现况快照')
const updTxt = String((await updP).text ?? '')
ok('J0 基线固化到现况(人工批准)', updCard && /已保存为 v\d+/.test(updTxt), updTxt.split('\n')[0]?.slice(0, 100))

// J4 闭环步:线速 现值→+4 提案 → HITL 批准 → 设备证实(治理窗重试 + 在飞单采纳)
const aggNow = await api('GET', '/api/workshop/dcw')
const speedNode = (aggNow?.data?.nodes ?? []).find(n => n.id === prov.dcw['线速SP'])
const SPEED_NOW = Math.round(Number(speedNode?.value ?? 128))
let okDispatch = false
let propTxt = ''
for (let attempt = 1; attempt <= 4 && !okDispatch; attempt++) {
  const pkg = {
    name: `AN-线速微升(投用 ${attempt})`,
    params: [{ node_id: prov.dcw['线速SP'], to: SPEED_NOW + 4, basis: `投用首轮:线速 ${SPEED_NOW}→${SPEED_NOW + 4}(≤步限 8,有界单变量;硬度窗 125~165HV 待复测)`, exp_ref: '退火基线配方 v2(现况快照);标准产线开发文档 §2 作业目标' }],
  }
  const propP = inv(workerId, 'recipe_propose', { recipe_id: prov.recipeId, packages: [pkg], emergency: true })
  await adjudicate(/^recipe-propose:/, `投用裁决:批准线速微升(方案 #0,attempt ${attempt})`, 0)
  const prop = await propP
  let txt = String(prop.text ?? '')
  const flying = /已有在飞方案审批单\((ap-[\w-]+)\)/.exec(txt)?.[1]
  if (flying) {
    await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: flying, confirmed: true, comment: '投用:批准在飞单', choice: 0 })
    await sleep(5000)
    txt = String((await inv(workerId, 'recipe_propose', { recipe_id: prov.recipeId, packages: [pkg], emergency: true }, 240_000)).text ?? '')
  }
  propTxt = txt
  okDispatch = /已获批准|已批准/.test(txt) && /设备证实/.test(txt) && !/失败|超时未批|未获批准/.test(txt)
  if (!okDispatch) {
    const w = Number(/请等待约?\s*(\d+)s/.exec(txt)?.[1] ?? 0)
    if (w > 0 && attempt < 4) {
      console.log(`  ⏳ 治理窗(${w}s),等 ${w + 10}s 重提…`)
      await sleep((w + 10) * 1000)
      continue
    }
  }
}
ok('J4 提案→HITL 批准→整批下发(设备证实)', okDispatch, propTxt.split('\n')[0]?.slice(0, 110))
const runId = /runId[:：]\s*(rr-[\w-]+)/.exec(propTxt)?.[1] ?? ''
ok('J5 回执携带 runId', !!runId, runId)

// J6 工艺响应复测:实际线速 PV + 带温 PV + 硬度 镜像跟测
await sleep(12_000)
const now2 = Date.now()
// 读面走数据分析师(数采绑定在 analyst 名下;工艺工程师查数会被权限模型正确拒绝 —— 治理语义)
const spd = await inv(analystId, 'daq_query', { node_id: prov.daq['实际线速PV'], from_ms: now2 - 120_000, to_ms: now2, bucket_ms: 10_000 })
const spdTxt = String(spd.text ?? '')
const aggAfter = await api('GET', '/api/workshop/dcw')
const speedAfter = Number((aggAfter?.data?.nodes ?? []).find(n => n.id === prov.dcw['线速SP'])?.value ?? 0)
const target = SPEED_NOW + 4
ok('J6 线速下发值设备读回一致 + 数据分析师 PV 复测在采', speedAfter === target && /\d/.test(spdTxt) && !spd.isError, `SP读回=${speedAfter}(期望 ${target}) PV采样=${/\d/.test(spdTxt) ? '有' : '无(' + spdTxt.slice(0, 40) + ')'}`)
const q = await inv(analystId, 'daq_query', { node_id: prov.daq['硬度HV'], from_ms: now2 - 120_000, to_ms: now2, bucket_ms: 10_000 })
ok('J7 质检硬度 PV 在采(质量窗观测,分析师读面)', /\d/.test(String(q.text ?? '')) && !q.isError, String(q.text ?? '').split('\n')[1]?.slice(0, 70) ?? '')

// J8 种子任务在册
const tasks = await api('GET', `/api/workshop/channels/${channelId}/tasks`)
const tArr = tasks?.data?.items ?? tasks?.data ?? []
ok('J8 种子任务已派发在册', tArr.length >= 1, tArr.map(t => String(t.title ?? '').slice(0, 24)).join(' | ').slice(0, 90))

const pass = checks.filter(Boolean).length
console.log(`\n======== 真实作业腿(anneal 新频道): ${pass}/${checks.length} ========`)
process.exit(pass === checks.length ? 0 : 1)
