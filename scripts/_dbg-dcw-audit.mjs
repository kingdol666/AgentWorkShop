/** 一次性:DCW 写控制全链路审计(mock ACK/工程换算/回读校验/量程拒绝/Recipe 隔离/Modbus 真写) */
import { randomUUID } from 'node:crypto'
const TOKEN = process.env.ADMIN_TOKEN ?? process.env.AW_PAGE_TOKEN ?? process.env.DAQ_TOKEN ?? ''
const BASE = (process.env.DAQ_BASE ?? 'http://127.0.0.1:3000') + '/api/workshop/dcw'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const post = (url, body) => fetch(BASE + url, { method: 'POST', headers: H, body: JSON.stringify(body) }).then(r => r.json())
const patch = (url, body) => fetch(BASE + url, { method: 'PATCH', headers: H, body: JSON.stringify(body) }).then(r => r.json())
const del = (url) => fetch(BASE + url, { method: 'DELETE', headers: H }).then(r => r.json())
const get = (url = '') => fetch(BASE + url, { headers: H }).then(r => r.json())
const { makeLineFixture } = await import('./_lib-dcw-line.mjs')
const fx = await makeLineFixture(process.env.DAQ_BASE ?? 'http://127.0.0.1:3000', H, 'dcw-audit 线')

// ===== 1. Mock 写节点:创建/下发/ACK =====
const mkA = (await post('', { templateRef: 'dcw-temp-sp', name: '审计-温度设定' })).data.node
if (!mkA) { console.error('FAIL: create mock node'); process.exit(1) }
console.log('created:', mkA.id, '| domain:', mkA.min, '~', mkA.max, mkA.unit)

const wOk = await post(`/${mkA.id}/write`, { value: 180 })
console.log('write 180:', wOk.data?.outcome?.ok, '|', (wOk.data?.outcome?.message ?? wOk.message ?? '').slice(0, 60))
if (wOk.data?.outcome?.ok !== true) fail('mock write 180 failed')

const list = await get()
const nodeA = list.data.nodes.find(n => n.id === mkA.id)
if (nodeA?.value === 180 && nodeA.state === 'ok') console.log('PASS node value/state updated (180, ok)')
else fail(`node state wrong: ${JSON.stringify({ value: nodeA?.value, state: nodeA?.state })}`)

// ===== 2. 工艺量程硬校验(越界拒绝) =====
const wOver = await post(`/${mkA.id}/write`, { value: 250 })
if (wOver.code === 'VALIDATION_ERROR') console.log('PASS over-range rejected:', (wOver.message ?? '').slice(0, 40))
else fail(`over-range not rejected: ${wOver.code}`)

// ===== 3. Modbus 真实写 + 工程量→原始值换算 + 回读校验 =====
// 节点:写 40021 float32,工程量程 150~200 → 原始 0~2000(0.1 分辨率);write 175 → raw 1000
const mkM = (await post('', {
  templateRef: 'dcw-temp-sp',
  name: '审计-Modbus温度',
  driver: 'modbus-tcp',
  driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big', engMin: 150, engMax: 200, rawMin: 0, rawMax: 2000 },
})).data.node
if (!mkM) { console.error('FAIL: create modbus node'); process.exit(1) }
const testM = await post(`/${mkM.id}/test`, {})
console.log('modbus test:', testM.data?.test?.ok, '|', (testM.data?.test?.message ?? '').slice(0, 50))

const wM = await post(`/${mkM.id}/write`, { value: 175 })
console.log('modbus write 175:', JSON.stringify(wM.data?.outcome ?? wM).slice(0, 140))
if (wM.data?.outcome?.ok === true && wM.data.outcome.raw === 1000) console.log('PASS modbus real write: raw=1000(换算 175→0.1分辨率), 回读一致')
else fail(`modbus write wrong: ${JSON.stringify(wM.data?.outcome ?? wM.message)}`)

// ===== 3.5 数采通道(挂审计产线:门控下仅线内节点采样;批次 daq 聚合用) =====
const dqA = (await (await fetch((process.env.DAQ_BASE ?? 'http://127.0.0.1:3000') + '/api/workshop/daq', { method: 'POST', headers: H, body: JSON.stringify({ templateRef: 'daq-temp-tc', name: 'dcw审计-温度通道', intervalMs: 500, lineId: fx.line.id }) })).json()).data.node
if (!dqA) { console.error('FAIL: create daq node'); process.exit(1) }

// ===== 4. Recipe 配方 + 一键下发 + 批次隔离 =====
// 无节点自定义模板 → 验证"参数无匹配节点记失败不阻塞"(内置模板均有 legacy 示例节点,不可再作反例)
// 名字带随机后缀:上次失败运行残留同名模板(同名 409)时本脚本仍可重跑
const tplEmpty = (await post('/templates', { name: `审计-无节点模板-${randomUUID().slice(0, 4)}`, unit: 'kPa', min: 0, max: 400, decimals: 1, ch: '审计用空模板', code: 'AUDIT · VOID' })).data?.template
if (!tplEmpty?.key) { console.error('FAIL: create empty template'); process.exit(1) }
// 先给该模板建一个节点(配方参数必须可解析到节点),建配方后再删节点 → apply 时逐参数失败隔离
const mkC = (await post('', { templateRef: `dcw-${tplEmpty.key}`, name: '审计-临时参数节点' })).data.node
const prod = (await post('/products', { name: '审计产品', lineId: fx.line.id })).data.product
const rc = await post('/recipes', { productId: prod.id,
  name: '审计配方-光学膜',
  description: '审计用',
  params: [
    // 显式 nodeId(自建节点):templateRef 兼容解析会命中"最早同模板节点"——
    // 多产线环境下那可能是用户 fixture 节点(已挂产线),产线隔离会正确拒绝
    { nodeId: mkA.id, value: 185 },
    { nodeId: mkC.id, value: 320 },
  ],
})
const recipeId = rc.data?.recipe?.id
if (!recipeId) { console.error('FAIL: create recipe', JSON.stringify(rc).slice(0, 120)); process.exit(1) }
console.log('recipe created:', recipeId)
await del(`/${mkC.id}`) // 参数目标节点被删 → apply 该参数应记失败不阻塞

// 已删节点的参数 → 该参数应记失败不阻塞;温度参数 → 写成功(命中 legacy 示例节点)
const ap = await post(`/recipes/${recipeId}/apply`, {})
const run = ap.data?.run
if (!run) { console.error('FAIL: apply recipe', JSON.stringify(ap).slice(0, 160)); process.exit(1) }
const okCount = run.results.filter(r => r.ok).length
console.log(`apply: ${okCount}/${run.results.length} ok |`, run.results.map(r => `${r.templateRef}:${r.ok ? 'ok' : 'fail'}`).join(' '))
if (okCount >= 1 && okCount < run.results.length) console.log('PASS recipe apply: partial success isolated per-param')

await sleep(800)
const data1 = await get(`/runs/${run.id}/data`)
const writes1 = data1.data?.writes ?? []
console.log(`run data: writes=${writes1.length}, daq channels=${(data1.data?.daq ?? []).length}`)
// 无节点模板参数未产生写命令 → 预期 1 条(温度写);且必须归属本批次
if (writes1.length === 1 && writes1[0].recipeRunId === run.id) console.log('PASS run data: write history bound to run (无节点参数不产生写)')
else fail(`run data writes wrong: ${writes1.length}`)

// 第二个配方 + 批次 → 验证窗口隔离
const rc2 = await post('/recipes', { productId: prod.id, name: '审计配方-B', params: [{ nodeId: mkA.id, value: 160 }] })
// 门控语义:runData 的数采聚合需产线开跑(配方驱动采集 + 打标)
const ap2 = await fx.start(rc2.data.recipe.id)
const run2 = ap2.data?.run
await sleep(2500) // 等数采样本落入 run2 窗口(1s 采样周期)
const data2 = await get(`/runs/${run2.id}/data`)
console.log(`run2: writes=${(data2.data?.writes ?? []).length}, daq=${(data2.data?.daq ?? []).length}`)
if ((data2.data?.daq ?? []).length > 0) console.log('PASS run data: daq channels aggregated in window')
else fail('run2 daq empty')
const r2writes = data2.data?.writes ?? []
// 产品隔离:run2 窗口只含自己的写入(160),不含 run1 的 185
if (r2writes.length === 1 && r2writes[0].eng === 160) console.log('PASS product isolation: run2 window only contains its own writes')
else fail(`isolation broken: ${JSON.stringify(r2writes.map(w => w.eng))}`)

// close + 数据仍可查(历史批次)
const cl = await post(`/runs/${run.id}/close`, {})
if (cl.data?.run?.endedAt) console.log('PASS run closed (isolation window sealed)')
else fail('run close failed')

// ===== 清理 =====
await fetch((process.env.DAQ_BASE ?? 'http://127.0.0.1:3000') + '/api/workshop/daq/' + dqA.id, { method: 'DELETE', headers: H })
await del(`/${mkA.id}`)
await del(`/${mkM.id}`)
await del(`/recipes/${recipeId}`)
await fx.cleanup()
await del(`/recipes/${rc2.data.recipe.id}`)
await del(`/templates/${tplEmpty.key}`)
await fetch((process.env.DAQ_BASE ?? 'http://127.0.0.1:3000') + '/api/workshop/dcw/products/' + prod.id, { method: 'DELETE', headers: H })
console.log('cleanup done')

console.log(process.exitCode ? 'AUDIT FAILED' : 'AUDIT ALL PASS')
process.exit(process.exitCode ?? 0)
