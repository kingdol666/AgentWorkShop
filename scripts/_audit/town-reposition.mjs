/**
 * town-reposition.mjs —— 把设备孪生收拢到默认相机取景范围内
 * 起因:posX/posZ 用的是场景世界坐标,初版按"米"给了 ±14,实际远在默认视锥之外 ——
 * __townStats 显示 devices=12(实例确实存在),但画面里几乎看不到。
 * 这里按小坐标重新落位,并顺带把频道领地收紧。
 */
const BASE = (() => {
  const i = process.argv.indexOf('--base')
  return (i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:3112').replace(/\/$/, '')
})()

let TOKEN = null
const api = async (method, path, { body } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const data = r => r?.data ?? {}

TOKEN = data(await api('POST', '/api/users/login', { body: { email: 'plant@awshop.local', password: 'Plant!2026' } })).token
if (!TOKEN) { console.error('✖ 登录失败'); process.exit(2) }

/**
 * 三组工艺设备:围绕**世界中心**一字排开。
 * ⚠️ 这里是世界坐标,不是"米":shared/town-scene-math.ts 里
 * WORLD_W=3200 / WORLD_H=2400,相机看向 (WORLD_CX, WORLD_CZ) = (1600, 1200)。
 * 初版按 ±14 给坐标 → 设备落在世界原点那一角,相机根本看不到
 * (__townStats 仍报 devices=12,但画面里只有一个位于世界中心的物体)。
 */
const CX = 1600
const CZ = 1200
const PLAN = [
  { match: /挤出主机/, posX: CX - 120, posZ: CZ - 70 },
  { match: /收卷机组/, posX: CX, posZ: CZ - 70 },
  { match: /MDO/, posX: CX + 120, posZ: CZ - 70 },
  { match: /配电柜/, posX: CX - 120, posZ: CZ + 80 },
  { match: /机械臂/, posX: CX, posZ: CZ + 80 },
  { match: /测厚仪/, posX: CX + 120, posZ: CZ + 80 },
]
/** 数采/数控节点也参与场景渲染(伪孪生),它们的 posX/posZ 同样要对齐世界中心 */
const NODE_PLAN = [
  { match: /温度采集/, posX: CX - 120, posZ: CZ - 70 },
  { match: /速度采集/, posX: CX, posZ: CZ - 70 },
  { match: /张力采集/, posX: CX + 120, posZ: CZ - 70 },
  { match: /温度设定/, posX: CX - 120, posZ: CZ + 80 },
  { match: /速度设定/, posX: CX, posZ: CZ + 80 },
  { match: /张力设定/, posX: CX + 120, posZ: CZ + 80 },
]

const twins = data(await api('GET', '/api/workshop/device-twins')).twins ?? []
console.log(`孪生实体 ${twins.length} 个`)
let moved = 0
for (const tw of twins) {
  const plan = PLAN.find(p => p.match.test(tw.name))
  if (!plan) continue
  const r = await api('PATCH', `/api/workshop/device-twins/${tw.id}`, { body: { posX: plan.posX, posZ: plan.posZ, rotationY: 0 } })
  const okr = r.code === 0 || (r.status >= 200 && r.status < 300)
  console.log(`  ${okr ? '✔' : '✖'} ${tw.name} → (${plan.posX}, ${plan.posZ})`)
  if (okr) moved++
}

// 数采/数控节点:它们的 posX/posZ 决定场景里的伪孪生落点
let movedNodes = 0
for (const [ep, plan] of [['daq', NODE_PLAN], ['dcw', NODE_PLAN]]) {
  const nodes = data(await api('GET', `/api/workshop/${ep}`)).nodes ?? []
  for (const n of nodes) {
    const p = plan.find(x => x.match.test(n.name))
    if (!p) continue
    const r = await api('PATCH', `/api/workshop/${ep}/${n.id}`, { body: { posX: p.posX, posZ: p.posZ } })
    const okr = r.code === 0 || (r.status >= 200 && r.status < 300)
    if (okr) movedNodes++
    console.log(`  ${okr ? '✔' : '✖'} [${ep}] ${n.name} → (${p.posX}, ${p.posZ})`)
  }
}

// 频道领地铺在世界中心,让地面环与设备尺度匹配
const chans = data(await api('GET', '/api/workshop/channels'))
const ch = (Array.isArray(chans) ? chans : (chans.channels ?? []))[0]
if (ch) {
  const r = await api('PUT', `/api/workshop/scene/layouts/${ch.id}`, { body: { x: CX, z: CZ, radiusX: 260, radiusZ: 180, shape: 'ellipse' } })
  console.log(`  领地铺在世界中心 (${CX}, ${CZ}) radius 260×180 (code=${r.code})`)
}

console.log(`\n${moved === PLAN.length && movedNodes === 6 ? '✅' : '⚠'} 孪生 ${moved}/${PLAN.length} · 节点 ${movedNodes}/6 已重排`)
