// 重建被孤儿进程抹掉的 zone2/3 写节点,并把配方 rc-bbab24bc 的死引用换到新 id
const B = 'http://localhost:3001'
const TOK = (await (await fetch(`${B}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }),
})).json()).data?.token
const H = { 'authorization': `Bearer ${TOK}`, 'content-type': 'application/json' }

const mk = (name, reg) => ({
  templateRef: 'dcw-temp-sp', name, driver: 'modbus-tcp',
  driverConfig: { host: '127.0.0.1', port: 16040, unitId: 1, register: reg, registerType: 'holding', dataType: 'float32', byteOrder: 'big' },
  unit: '℃', decimals: 1, min: 120, max: 260, lineId: 'ln-d7e0a2a2', enabled: true,
  semantics: '模拟器设备「挤出主机PLC」加热区温度设定(float32,big);写入经 SP→PV 回灌联动一阶惯性回路(孤儿进程事故后重建)',
})
const created = {}
for (const [key, name, reg] of [
  ['z2', '演示·挤出主机PLC(Modbus TCP)·加热区2SP', 40023],
  ['z3', '演示·挤出主机PLC(Modbus TCP)·加热区3SP', 40025],
]) {
  const r = await (await fetch(`${B}/api/workshop/dcw`, { method: 'POST', headers: H, body: JSON.stringify(mk(name, reg)) })).json()
  created[key] = r.data?.node?.id
  console.log('重建', key, created[key], 'code=' + r.code)
}
const j = await (await fetch(`${B}/api/workshop/dcw`, { headers: H })).json()
const r = (j.data?.recipes ?? []).find(x => x.id === 'rc-bbab24bc')
const params = r.params.map(p => p.nodeId === 'dw-4d980ff1' ? { ...p, nodeId: created.z2 } : p.nodeId === 'dw-752ad470' ? { ...p, nodeId: created.z3 } : p)
const pr = await (await fetch(`${B}/api/workshop/dcw/recipes/rc-bbab24bc`, { method: 'PATCH', headers: H, body: JSON.stringify({ params }) })).json()
console.log('配方修复:', pr.code, pr.message ?? '', 'v' + (pr.data?.recipe?.version ?? pr.data?.version ?? '?'))
console.log('RESULT ' + JSON.stringify(created))
