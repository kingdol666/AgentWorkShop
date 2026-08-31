/** 一次性:清空数字孪生场景实例(非破坏)
 *  - 数采/数控节点:PATCH posX/posZ = null(解除落位,实体保留在左轨树)
 *  - 频道布局(含领地/积木):逐个 DELETE /scene/layouts/:cid
 *  - 设备孪生保留(绑定测试锚点;API 无损清位不支持,如需删除可在 UI 逐台删)
 */
const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const H = { 'authorization': `Bearer ${login.data.token}`, 'content-type': 'application/json' }

const daq = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
const daqPlaced = daq.data.nodes.filter(n => typeof n.posX === 'number')
let daqDone = 0
for (const n of daqPlaced) {
  const r = await fetch(`${BASE}/api/workshop/daq/${n.id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ posX: null, posZ: null }),
  })
  if (r.ok) daqDone++
}
console.log(`daq unplaced: ${daqDone}/${daqPlaced.length}`)

const dcw = await fetch(`${BASE}/api/workshop/dcw`, { headers: H }).then(r => r.json())
const dcwPlaced = dcw.data.nodes.filter(n => typeof n.posX === 'number')
let dcwDone = 0
for (const n of dcwPlaced) {
  const r = await fetch(`${BASE}/api/workshop/dcw/${n.id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ posX: null, posZ: null }),
  })
  if (r.ok) dcwDone++
}
console.log(`dcw unplaced: ${dcwDone}/${dcwPlaced.length}`)

const layouts = await fetch(`${BASE}/api/workshop/scene/layouts`, { headers: H }).then(r => r.json())
const items = layouts.data?.layouts ?? layouts.data?.items ?? []
let layDone = 0
for (const it of items) {
  const cid = it.channelId ?? it.id
  if (!cid) continue
  const r = await fetch(`${BASE}/api/workshop/scene/layouts/${cid}`, { method: 'DELETE', headers: H })
  if (r.ok) layDone++
}
console.log(`layouts removed: ${layDone}/${items.length}`)

// 复核
const daq2 = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
const dcw2 = await fetch(`${BASE}/api/workshop/dcw`, { headers: H }).then(r => r.json())
const lay2 = await fetch(`${BASE}/api/workshop/scene/layouts`, { headers: H }).then(r => r.json())
console.log('verify → placed daq:', daq2.data.nodes.filter(n => typeof n.posX === 'number').length,
  '| placed dcw:', dcw2.data.nodes.filter(n => typeof n.posX === 'number').length,
  '| layouts:', (lay2.data?.layouts ?? []).length,
  '| daq entities kept:', daq2.data.nodes.length,
  '| dcw entities kept:', dcw2.data.nodes.length)
console.log('scene clear done')
