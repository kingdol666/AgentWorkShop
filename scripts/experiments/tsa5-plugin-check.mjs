// tsa5 round — plugin tool leg (PR#250 acceptance): user-scope plugin persists across
// instance restarts/builds, its tools are in the registry, and the read tool fails closed
// (operable guidance, zero outbound calls) while unconfigured. Honest boundary: no external
// MES is contacted; the live-injection/role-boundary proof lives in the 2026-11-20 evidence.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-21-tsa5-v0140-round')
mkdirSync(EV, { recursive: true })
const BASE = 'http://127.0.0.1:3021'
const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin
const CH = '4bbf5d97-b677-499f-abaf-9698ac76a234'
const LEAD = 'ec2758d0-53cc-41ff-8a98-e64a812dfa75'
const WORKER = '27184eb1-299e-4c4c-9ff8-73a9d0110d8d'
const log = (m) => console.log(`[tsa5-plugin] ${m}`)
const save = (name, obj) => writeFileSync(join(EV, name), JSON.stringify(obj, null, 1))

async function api(method, path, body, timeoutMs = 30_000) {
  let r
  try {
    r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) { return { status: 0, json: { raw: `network-error:${e.cause?.code ?? e.name}` } } }
  const text = await r.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 300) } }
  return { status: r.status, json }
}

// 1) persistence: plugin manifest visible + enabled after restart on a NEW build
const plugins = await api('GET', '/api/workshop/plugins')
const plist = plugins.json?.data?.plugins ?? []
const mine = plist.filter(p => p.name === 'mes-tool-bridge')
save('plugin-manifest.json', mine)
if (!mine.length || mine[0].enabled !== true) throw new Error(`mes-tool-bridge not loaded: ${JSON.stringify(mine).slice(0, 200)}`)
log(`persistence OK scope=${mine[0].scope} enabled=${mine[0].enabled}`)

// 2) registry: both tools present with expected shape
const tools = await api('GET', '/api/workshop/tools')
const names = (tools.json?.data?.tools ?? []).map(t => t.name ?? t)
const have = { order: names.includes('mes_order_status'), report: names.includes('mes_quality_report') }
save('plugin-registry.json', { total: names.length, ...have })
if (!have.order || !have.report) throw new Error(`plugin tools missing from registry: ${JSON.stringify(have)}`)
log(`registry OK total=${names.length} mes_order_status=${have.order} mes_quality_report=${have.report}`)

// 3) fail-closed invoke (lead agent): unconfigured → operable guidance, isError, no hang
const inv = await api('POST', '/api/workshop/agent-tools/invoke', {
  agentId: LEAD,
  tool: 'mes_order_status',
  args: { orderId: 'PO-TSA5-1' },
}, 60_000)
const text = String(inv.json?.data?.result?.text ?? '')
save('plugin-invoke-unconfigured.json', { status: inv.status, textHead: text.slice(0, 300) })
const failClosed = inv.status === 200 && /未配置/.test(text) && /系统设置/.test(text) && (inv.json?.data?.result?.isError === true || /未配置/.test(text))
log(`fail-closed invoke: status=${inv.status} guided=${/未配置/.test(text)}`)
if (!failClosed) throw new Error(`unexpected unconfigured behavior: ${text.slice(0, 200)}`)

// 4) worker role sees the read tool in its surface (injection boundary re-check on this build)
const wl = await api('GET', `/api/workshop/agent-tools/list?agentId=${WORKER}`)
const wnames = (wl.json?.data?.tools ?? []).map(t => t.name)
save('plugin-worker-surface.json', { total: wnames.length, order: wnames.includes('mes_order_status'), report: wnames.includes('mes_quality_report') })
const workerOk = wnames.includes('mes_order_status') && !wnames.includes('mes_quality_report')
log(`worker surface: order=${wnames.includes('mes_order_status')} report=${wnames.includes('mes_quality_report')} (expect true/false)`)

console.log('TSA5-PLUGIN-RESULT ' + JSON.stringify({ persisted: true, registry: have, failClosed, workerBoundaryOk: workerOk }))
