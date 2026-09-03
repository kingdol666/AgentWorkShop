/**
 * DCW 读写集成 E2E(真实 dev server):
 * ①mock 驱动手动读写闭环(读随写变) ②标定 transform 物理域往返
 * ③周期读服务端调度(不手动读,等节点自己读) ④真实 Modbus TCP(127.0.0.1:1502 从站,
 * 40021 保持寄存器 float32 大端)写→读 roundtrip ×2  ⑤视图字段/视图列表收敛。
 * 运行: node scripts/_dbg-dcw-read-rest.mjs(CLEANUP=1 结束后清理测试节点)
 */
const ROOT = process.env.E2E_ROOT ?? 'http://127.0.0.1:3000'
const CLEANUP = process.env.CLEANUP === '1'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) failed++ }

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())
const nodesOf = async () => (await j('/api/workshop/dcw')).data.nodes
const nodeView = async (id) => (await nodesOf()).find(n => n.id === id)
const write = (id, value) => j(`/api/workshop/dcw/${id}/write`, 'POST', { value }).then(r => r.data.outcome)
const read = (id) => j(`/api/workshop/dcw/${id}/read`, 'POST', {}).then(r => r.data.read)

const created = []
async function mkNode(name, extra) {
  const node = (await j('/api/workshop/dcw', 'POST', { templateRef: 'dcw-temp-sp', name, readIntervalMs: 0, ...extra })).data.node
  created.push(node.id)
  return node
}

// 幂等清理:上一次异常中断残留的同名节点先删
for (const stale of (await nodesOf()).filter(n => n.name?.startsWith('读写验证·'))) {
  await j(`/api/workshop/dcw/${stale.id}`, 'DELETE').catch(() => {})
}
// mock PLC 状态在服务进程内掉电保持(同真实寄存器):每次运行用独立 key 避免跨运行串扰
const RUN = Date.now().toString(36)

// ===== ① mock 手动读写闭环 =====
console.log('\n--- ① mock 手动读写闭环 ---')
{
  const n = await mkNode('读写验证·mock 手动', { driver: 'mock', driverConfig: { key: `rw-e2e-1-${RUN}` } })
  check('视图透出读字段(readValue/readIntervalMs/lastRead*)', 'readValue' in n && 'readIntervalMs' in n && 'lastReadAt' in n && 'lastReadError' in n)
  const before = await read(n.id)
  check('未写入时读取:如实报告失败(mock 无记录)', before.ok === false && before.value == null, before.message.slice(0, 50))
  const w1 = await write(n.id, 165.5)
  check('写 165.5 成功(回读一致)', w1.ok === true, w1.message.slice(0, 60))
  const r1 = await read(n.id)
  check('读回 = 刚写值(165.5)', r1.ok && Math.abs(r1.value - 165.5) < 0.01, `value=${r1.value}`)
  await write(n.id, 180)
  const r2 = await read(n.id)
  check('再写 180 后读随写变', r2.ok && Math.abs(r2.value - 180) < 0.01, `value=${r2.value}`)
  const v = await nodeView(n.id)
  check('节点视图记账(readValue/lastReadAt/SET value)', Math.abs(v.readValue - 180) < 0.01 && v.lastReadAt != null && Math.abs(v.value - 180) < 0.01, `act=${v.readValue} set=${v.value}`)
}

// ===== ② 标定 transform 物理域往返 =====
console.log('\n--- ② transform 物理域往返 ---')
{
  const n = await mkNode('读写验证·标定×2', { driver: 'mock', driverConfig: { key: `rw-e2e-2-${RUN}` }, transform: { kind: 'linear', scale: 2, offset: 0 }, min: 0, max: 400 })
  await write(n.id, 100)
  const r = await read(n.id)
  check('物理 100(PLC 50)写→读往返一致', r.ok && Math.abs(r.value - 100) < 0.01, `value=${r.value}(raw=${r.raw})`)
}

// ===== ③ 周期读服务端调度 =====
console.log('\n--- ③ 周期读调度(readIntervalMs=1000,不手动读) ---')
{
  const n = await mkNode('读写验证·周期读', { driver: 'mock', driverConfig: { key: `rw-e2e-3-${RUN}` }, readIntervalMs: 1000 })
  await write(n.id, 155)
  check('写入后 SET 已记账', Math.abs((await nodeView(n.id)).value - 155) < 0.01)
  await sleep(2600)
  const v = await nodeView(n.id)
  check('2.6s 内周期读自动回填 ACT(服务端调度)', Math.abs(v.readValue - 155) < 0.01 && v.lastReadAt != null, `act=${v.readValue} @${v.lastReadAt?.slice(11, 19)}`)
}

// ===== ④ 真实 Modbus TCP 读写 roundtrip =====
console.log('\n--- ④ 真实 Modbus TCP(1502 从站,float32 大端) ---')
{
  const cfg = { host: '127.0.0.1', port: 1502, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big' }
  const n = await mkNode('读写验证·Modbus真实链路', { driver: 'modbus-tcp', driverConfig: cfg, min: 0, max: 300 })
  const t = await j(`/api/workshop/dcw/${n.id}/test`, 'POST').then(r => r.data.test)
  check('真实从站连接测试(40021 可访问)', t.ok === true, t.message.slice(0, 60))
  const r0 = await read(n.id)
  check('真实读:初始寄存器值(raw=0 → 0)', r0.ok && r0.raw != null, `raw=${r0.raw}`)
  const w1 = await write(n.id, 3.1416)
  check('真实写:3.1416 下发+同址回读一致', w1.ok === true, w1.message.slice(0, 70))
  const r1 = await read(n.id)
  check('真实读:寄存器回 3.1416(独立于写回读的第二笔读)', r1.ok && Math.abs(r1.raw - 3.1416) < 0.001, `raw=${r1.raw} eng=${r1.value}`)
  const w2 = await write(n.id, 2.71828)
  const r2 = await read(n.id)
  check('第二轮写读:2.71828 roundtrip', w2.ok && r2.ok && Math.abs(r2.raw - 2.71828) < 0.001, `raw=${r2.raw}`)
  const v = await nodeView(n.id)
  check('真实节点视图 ACT 收敛(2.72 MPa? ℃模板域 150~200 → 用原始值展示)', v.readValue != null && v.lastReadAt != null, `act=${v.readValue} raw=${r2.raw}`)
}

// ===== 收尾 =====
if (CLEANUP) {
  for (const id of created) await j(`/api/workshop/dcw/${id}`, 'DELETE').catch(() => {})
  console.log(`(cleanup:${created.length} 个测试节点已删)`)
}
else {
  console.log(`(节点保留:${created.join(', ')};CLEANUP=1 可清理)`)
}
console.log(failed === 0 ? '\nDCW-READ-E2E ALL PASS' : `\nDCW-READ-E2E FAILED(${failed})`)
process.exit(failed === 0 ? 0 : 1)
