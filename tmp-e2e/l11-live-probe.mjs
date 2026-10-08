// L11 多源异构取数实证 v2(只读探针;显式节点 id + 真实字段形状)
// samples 点形状 {at,avg,min,max,cnt};帧形状 {at,kind,points|meta.points,meta{sha256,size,objectKey}}
const BASE = 'http://127.0.0.1:3001'
const fs = await import('node:fs')
const tok = fs.readFileSync('tmp-e2e/admin.tok', 'utf8').trim()
const H = { Authorization: `Bearer ${tok}` }
const api = async path => (await fetch(BASE + path, { headers: H })).json()
let pass = 0, fail = 0
const ok = (name, cond, ev = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${ev ? ' — ' + ev : ''}`)
  if (cond) pass++
  else fail++
}

const daq = await api('/api/workshop/daq')
const nodes = daq?.data?.nodes ?? []
const byDriver = {}
for (const n of nodes) byDriver[n.driver ?? '?'] = (byDriver[n.driver ?? '?'] ?? 0) + 1
console.log('节点驱动族分布:', JSON.stringify(byDriver))
const now = Date.now()
const win = (id, ms, bucket) => api(`/api/workshop/daq/${id}/samples?from=${now - ms}&to=${now}&bucketMs=${bucket}`)

// ① 五协议族标量镜像(显式选各族一个注塑线节点)
const famTargets = { 'modbus-tcp': 'dn-767cae47', 'modbus-rtu': 'dn-a41c49cc', 'opcua': 'dn-121838ac', 'http': 'dn-79957615', 'mqtt': 'dn-b8ee4f86' }
for (const [fam, id] of Object.entries(famTargets)) {
  const n = nodes.find(x => x.id === id)
  const q = await win(id, 120_000, 5000)
  const pts = q?.data?.points ?? []
  const nonNull = pts.filter(p => p.avg != null).length
  ok(`${fam} 标量 2min 窗有数据(${id} ${n?.name ?? '?'})`, nonNull > 0, `points=${pts.length} 非空=${nonNull} 最新 avg=${pts.at(-1)?.avg}@${new Date(pts.at(-1)?.at ?? 0).toISOString().slice(11, 19)}`)
}

// ② 向量帧:注塑壁厚轮廓 dn-f51aa073 + MES 剖面 dn-f83d836c
for (const [label, id] of [['壁厚轮廓向量帧', 'dn-f51aa073'], ['MES 剖面向量帧', 'dn-f83d836c']]) {
  const f = await api(`/api/workshop/daq/${id}/frames?limit=2`)
  const fr = f?.data?.frames ?? []
  const pts = fr[0]?.meta?.points ?? fr[0]?.points ?? []
  ok(`${label}(${id})`, fr.length > 0 && pts.length > 0, `frames=${fr.length} 点数=${pts.length} 最新@${new Date(fr[0]?.at ?? 0).toISOString().slice(11, 19)}`)
}

// ③ 图像帧完整性指纹 + 对象存储可回取
const cf = await api('/api/workshop/daq/dn-2dbe6aa5/frames?limit=1')
const cfr = (cf?.data?.frames ?? [])[0] ?? {}
const cm = cfr.meta ?? {}
ok('CCD 图像帧 sha256+size 完整性指纹(P0 回归)', !!cm.sha256 && cm.size != null, `sha256=${String(cm.sha256).slice(0, 12)}… size=${cm.size} ${cm.width}×${cm.height}`)
ok('CCD 图像帧 objectKey 落对象存储(UTC 取日)', String(cm.objectKey ?? '').startsWith('daq/dn-2dbe6aa5/'), String(cm.objectKey ?? '(无)'))
const content = await fetch(BASE + (cfr.contentUrl ?? ''), { headers: H })
ok('CCD 图像 content 回取 200(存储链路真可读)', content.status === 200, `status=${content.status} type=${content.headers.get('content-type')}`)

// ④ MES 镜像路:注塑·MES厚度均值(镜像) dn-954b6d7a 10min 有桶
const mq = await win('dn-954b6d7a', 600_000, 30_000)
const mpts = mq?.data?.points ?? []
ok('MES 镜像路 daq_query 10min 有桶(dn-954b6d7a)', mpts.filter(p => p.avg != null).length > 0, `points=${mpts.length} 最新 avg=${mpts.at(-1)?.avg}`)

// ⑤ 实时值面:在线节点实时值非空占比
const withVal = nodes.filter(n => n.value != null)
ok('实时值面:77+ 节点带当前值', withVal.length >= 70, `nodes=${nodes.length} withValue=${withVal.length}`)

console.log(`\n======== L11 实证: ${pass} 过 / ${fail} 挂 ========`)
process.exit(fail ? 1 : 0)
