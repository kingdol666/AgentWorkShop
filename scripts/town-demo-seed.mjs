/**
 * 小镇演示数据准备(dev server :3000):注册用户 → workspace → channel(lead+2 worker, mock)
 * → 挂载 → 场景布局(放置领地)→ 泵机设备孪生 → 提交任务 + 制造 A2A 对话(气泡活动)。
 * 运行: node scripts/town-demo-seed.mjs [--base http://127.0.0.1:3000]
 */
const BASE = (process.argv.find(a => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:3000') + '/api/workshop'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: await r.json().catch(() => null) }
}

const name = 'town-demo-' + Math.random().toString(36).slice(2, 7)
const u = await api('POST', '/users/register', { body: { name } })
const token = u.json?.data?.token
if (!token) {
  console.error('注册失败', u.json)
  process.exit(1)
}
console.log('user:', name, 'token:', token)

const ws = await api('POST', '/workspaces', { token, body: { name: '工业孪生演示工作区' } })
const wsId = ws.json?.data?.id ?? ws.json?.data?.workspaceId
console.log('workspace:', wsId)

const ch = await api('POST', '/channels', { token, body: { name: '工业孪生演示频道', description: 'RPG 2.5D 小镇演示' } })
const cid = ch.json?.data?.channelId
console.log('channel:', cid)
await api('POST', `/channels/${cid}/agents`, { token, body: { name: '调度主管', harness: 'mock', role: 'lead' } })
await api('POST', `/channels/${cid}/agents`, { token, body: { name: '数据工程师', harness: 'mock', role: 'worker' } })
await api('POST', `/channels/${cid}/agents`, { token, body: { name: '运维工程师', harness: 'mock', role: 'worker' } })

if (wsId && cid) await api('POST', `/workspaces/${wsId}/channels/${cid}`, { token })

// 场景布局:把频道领地放到世界中央偏左(工业园东区)
await api('PUT', `/scene/layouts/${cid}`, { token, body: { x: 1150, z: 1500, radiusX: 320, radiusZ: 210, shape: 'ellipse', rotationY: 0 } })
// 第二块领地(同用户再建一个频道,形成"园区"群像)
const ch2 = await api('POST', '/channels', { token, body: { name: '设备在线监测组', description: '孪生设备监控' } })
const cid2 = ch2.json?.data?.channelId
await api('POST', `/channels/${cid2}/agents`, { token, body: { name: '监测主管', harness: 'mock', role: 'lead' } })
await api('POST', `/channels/${cid2}/agents`, { token, body: { name: '巡检员', harness: 'mock', role: 'worker' } })
if (wsId && cid2) await api('POST', `/workspaces/${wsId}/channels/${cid2}`, { token })
await api('PUT', `/scene/layouts/${cid2}`, { token, body: { x: 1950, z: 1520, radiusX: 250, radiusZ: 170, shape: 'rect', rotationY: 18 } })

// 泵机设备孪生(工业园中央)+ 高清遥测
await api('POST', '/device-twins', {
  token,
  body: {
    name: '循环泵 #01', modelRef: 'pump', kind: 'device',
    posX: 1580, posZ: 1560, rotationY: 30, scale: 1.6,
    controls: ['start', 'stop'],
    telemetry: { rpm: 2960, pressure: 0.82, temp: 63, vibration: 3.4 },
  },
})

// 提交任务 → mock 闭环,产生大量事件/气泡
const t = await api('POST', `/channels/${cid}/tasks`, { token, body: { title: '巡检泵组并汇报', description: '就地巡检 01/02 号循环泵' } })
console.log('task:', t.json?.data?.id)
await sleep(2500)

// 制造 A2A 对话气泡(lead → 数据工程师 / 运维工程师)
const agents = (await api('GET', `/channels/${cid}/agents`, { token })).json?.data ?? []
const lead = agents.find(a => a.role === 'lead')
const w = agents.filter(a => a.role === 'worker')
for (const worker of w) {
  await api('POST', '/a2a/send', {
    token: lead?.token,
    body: { toAgentId: worker.id, parts: [{ text: `巡检完成,请汇总 ${worker.name} 负责的泵组运行数据` }] },
  })
}
console.log('演示数据就绪')
console.log('DIALOG_READY token=' + token)
