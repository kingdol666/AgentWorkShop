/**
 * 协议自测 —— HTTP 端点(GET /sim-http/{deviceId}{path},主项目 http 驱动同语义)。
 * 覆盖:JSON 模板响应 / 值域 / 404。
 */
const nodes = (await (await fetch('http://127.0.0.1:4010/api/nodes')).json()).data as Array<{ id: string, protocol: string }>
const dev = nodes.find(n => n.protocol === 'http')
if (!dev) throw new Error('FAIL 无 http 设备(先应用 film-line 预设)')

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const res = await fetch(`http://127.0.0.1:4010/sim-http/${dev.id}/api/value`)
const body = await res.json() as { data?: { value?: number } }
check('GET /api/value → 200 JSON', res.status === 200 && typeof body.data?.value === 'number', JSON.stringify(body))
check('流量值域(0~100)', body.data!.value! >= 0 && body.data!.value! <= 100, `value=${body.data!.value}`)

const nf = await fetch(`http://127.0.0.1:4010/sim-http/${dev.id}/nope`)
check('未注册路径 → 404', nf.status === 404)

console.log(`\nhttp 自测: ${passed} passed / ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
export {}
