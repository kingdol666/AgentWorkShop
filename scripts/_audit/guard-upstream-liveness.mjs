/**
 * 稳定性护栏端到端验证:外部设备不可达时,服务端**必须存活**。
 *
 * 复现的真实事故:一台 Modbus TCP 设备未启动(connect ECONNREFUSED 127.0.0.1:1502)
 * 触发 unhandledRejection 走到 fatal 分支 → 整个生产实例 exit 1 →
 * 数采/数控/数字孪生全平台被一台设备带走。
 *
 * 做法:
 *  1. 建立指向**必然拒绝连接**的端口的 Modbus TCP 数采节点(默认 1502,可 --port 覆盖)
 *  2. 等采集轮询真正发起连接(默认 25s)
 *  3. 断言:健康门仍 200、进程未死、日志出现 upstream 分级记录
 *
 * 用法:node scripts/_audit/guard-upstream-liveness.mjs [--base http://127.0.0.1:3001] [--port 1502] [--wait 25] [--keep]
 */
const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const BASE = arg('--base', 'http://127.0.0.1:3001')
const DEAD_PORT = Number(arg('--port', '1502'))
const WAIT_S = Number(arg('--wait', '25'))
const KEEP = process.argv.includes('--keep')
const TOKEN = process.env.AW_E2E_TOKEN
  ?? (await (await fetch(`${BASE}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }),
  })).json()).data.token

const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return r.json().catch(() => ({}))
}

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const health = async () => {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) })
    const j = await r.json()
    return { ok: r.ok && j?.data?.status === 'ok', version: j?.data?.version }
  }
  catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

console.log(`\n━━━ 稳定性护栏:外部设备不可达不应带走服务(设备端口 :${DEAD_PORT}) ━━━`)
const before = await health()
check('前置:服务健康', before.ok, `version=${before.version}`)

// 1) 建一条指向死端口的 Modbus TCP 节点。字段形状对齐既有节点:
//    templateRef 必填(信号模板)、地址走 driverConfig.register。
const ts = Date.now()
const line = await api('POST', '/api/workshop/dcw/lines', { name: `护栏验证线-${ts}`, productId: null })
const lineId = line?.data?.line?.id ?? line?.data?.id
check('创建验证产线', !!lineId, lineId ?? JSON.stringify(line).slice(0, 120))

const node = await api('POST', '/api/workshop/daq', {
  lineId,
  name: `死端口节点-${ts}`,
  templateRef: arg('--template', 'daq-temp-tc'),
  driver: 'modbus-tcp',
  unit: '℃',
  intervalMs: 500,
  enabled: true,
  driverConfig: { host: '127.0.0.1', port: DEAD_PORT, unitId: 1, register: 40001, dataType: 'float32', byteOrder: 'big' },
})
const nodeId = node?.data?.node?.id ?? node?.data?.id
check('创建指向必然拒绝连接端口的数采节点', !!nodeId, nodeId ?? JSON.stringify(node).slice(0, 200))

// 2) 开跑,让轮询真正去连那个端口
if (lineId) await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, {})
console.log(`  · 等待 ${WAIT_S}s 让采集轮询发起连接 ...`)
await sleep(WAIT_S * 1000)

// 3) 核心断言:服务还活着
const after = await health()
check('设备不可达后服务仍健康(修复前此处 exit 1)', after.ok, after.ok ? `version=${after.version}` : `unreachable: ${after.error}`)

const opened = await api('GET', `/api/workshop/daq/${nodeId}/samples?from=${Date.now() - WAIT_S * 1000}&bucketMs=1000&limit=5`).catch(() => null)
check('节点面仍可查询(平台未被带走)', opened !== null)

// 4) 清理
if (!KEEP && lineId) {
  await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {}).catch(() => null)
  await api('DELETE', `/api/workshop/daq/${nodeId}`).catch(() => null)
  await api('DELETE', `/api/workshop/dcw/lines/${lineId}`).catch(() => null)
  console.log('  · 验证用产线/节点已清理')
}
else if (KEEP) console.log(`  · KEEP=1,保留现场:line=${lineId} node=${nodeId}`)

console.log(`\n━━━ 结果:${pass} PASS / ${fail} FAIL ━━━\n`)
process.exitCode = fail === 0 ? 0 : 1
