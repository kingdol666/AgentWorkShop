/**
 * Stage 1:四服务健康 + 插件装载 + 鉴权门 —— 原 L256–293
 * (由 scripts/three-system-e2e.mjs 按职责拆出;语句逐行原文搬运,仅跨模块引用/状态访问机械改写)
 *
 * 原阶段的裸块 `{ ... }` 已由本 run() 的函数体取代(其作用只是给阶段划作用域)。
 */
import { BASE, DIAG, KB, KBWEB, api, envelopeData, ok, raw } from '../lib.mjs'
import { getKbTokenG, getUserToken } from '../state.mjs'

export async function run() {
  console.log('\n── Stage 1 系统与插件健康 ──')

  const awsGate = await api('GET', '/api/workshop/plugins')
  ok(awsGate.status === 401, 'AWS 3021 活着(无 token 401 信封)', `status=${awsGate.status}`)

  const kbH = await raw('GET', `${KB}/api/v1/health`)
  ok(kbH.json?.status === 'healthy', 'rag-knowledge 后端 8770 healthy', JSON.stringify(kbH.json))
  // web catalog:服务端开启鉴权时无 token 401,带 MCP token 应 success(两种部署形态都接受)
  const kbWebNoAuth = await raw('GET', `${KBWEB}/api/kb/catalog`)
  const kbWeb = await raw('GET', `${KBWEB}/api/kb/catalog`, { token: getKbTokenG() || undefined })
  ok(kbWeb.json?.success === true || (kbWebNoAuth.status === 401 && kbWebNoAuth.json?.error),
    'rag-knowledge web 6789 catalog 可用(鉴权形态:无 token 401 / 带 token success)',
    `noAuth=${kbWebNoAuth.status} withToken=${kbWeb.status} count=${kbWeb.json?.count}`)
  const dgH = await raw('GET', `${DIAG}/api/health`)
  ok(dgH.json?.status === 'ok', '诊断服务 3210 healthy', `activeRuns=${dgH.json?.checks?.activeRuns}`)
  const rgH = await raw('GET', 'http://127.0.0.1:8764/health', { timeoutMs: 5000 }).catch(e => ({ json: { status: String(e) } }))
  ok(rgH.json?.status === 'healthy', '诊断 RAG 引擎 8764 healthy(降级容忍)', JSON.stringify(rgH.json ?? {}))

  const plugs = await api('GET', '/api/workshop/plugins', { token: getUserToken() })
  // 兼容两种形状:顶层 {plugins:[...]}(插件清单端点未包信封)/ 信封 data.plugins
  const list = plugs.json?.plugins ?? envelopeData(plugs)?.plugins ?? []
  const names = list.map(p => p?.name)
  const enabled = n => list.find(p => p?.name === n)?.enabled === true
  ok(Array.isArray(list) && list.length > 0, '插件清单可读', list.length ? `count=${list.length}` : `resp=${JSON.stringify(plugs.json).slice(0, 160)}`)
  ok(names.includes('rag-bridge'), 'rag-bridge 已装载')
  ok(names.includes('diag-bridge'), 'diag-bridge 已装载')
  ok(enabled('rag-bridge') && enabled('diag-bridge'), '两桥接插件均为启用态')

  const noAuthRag = await raw('GET', `${BASE}/api/plugins/rag-bridge/health`)
  const noAuthDiag = await raw('GET', `${BASE}/api/plugins/diag-bridge/health`)
  ok(noAuthRag.status === 401 && noAuthDiag.status === 401, '插件路由鉴权门生效(auth:user → 无 token 401)', `rag=${noAuthRag.status} diag=${noAuthDiag.status}`)

  const ragH = await raw('GET', `${BASE}/api/plugins/rag-bridge/health`, { token: getUserToken() })
  ok(ragH.status === 200 && ragH.json?.outbound === true && ragH.json?.kb?.id, 'rag-bridge 健康(kb.id 就绪)', `kb=${ragH.json?.kb?.id}`)
  const diagH = await raw('GET', `${BASE}/api/plugins/diag-bridge/health`, { token: getUserToken() })
  ok(diagH.status === 200 && diagH.json?.remote?.status === 'ok', 'diag-bridge 健康(3210 可达)', `activeRuns=${diagH.json?.remote?.activeRuns}`)
}
