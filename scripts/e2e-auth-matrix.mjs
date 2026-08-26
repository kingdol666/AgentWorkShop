/**
 * API 鉴权矩阵端到端验证
 * ============================================================
 * 原则:业务 API 必须 401(无 token)/ 正常(有效 token);公开 API(认证入口/A2A card)免 token。
 *
 * 矩阵:
 *  1. 公开面(无需 token):register/login(workshop 遗留注册)、a2a agent card(协议公开发现)
 *  2. 业务面(无 token → 401 USER_UNAUTHORIZED / ADMIN_REQUIRED):
 *     - workshop: agents/teams/channel-templates/channels/workspaces/runtime/fs
 *     - system: config/monitor
 *     - game: brain/cmd
 *     - users: 管理面(admin 门,无 token 同样 401)
 *  3. 有效 token 下抽检关键路由返回 200/预期
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3001'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) {
    pass++
  }
  else {
    fail++
  }
}

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  let json
  try {
    json = await res.json()
  }
  catch {
    json = {}
  }
  return { status: res.status, code: json.code, message: json.message, data: json.data }
}

/** 业务路由清单(方法, 路径, 有效 token 下预期状态码) */
const BUSINESS_ROUTES = [
  ['GET', '/api/system/config', 200],
  ['GET', '/api/system/monitor', 200],
  ['GET', '/api/workshop/agents', 200],
  ['POST', '/api/workshop/agents', 200],
  ['GET', '/api/workshop/teams', 200],
  ['GET', '/api/workshop/channel-templates', 200],
  ['GET', '/api/workshop/channels', 200],
  ['POST', '/api/workshop/channels', 200],
  ['GET', '/api/workshop/workspaces', 200],
  ['GET', '/api/workshop/runtime', 200],
  ['GET', '/api/workshop/fs/dirs', 200],
  ['GET', '/api/users', 403], // 有 token 但非 admin → ADMIN_REQUIRED(无 token 401)
  // 注:game/* 端点已随 2D RPG → 3D 小镇重构移除(2026),其鉴权语义由 town/device 域承担,此处不再断言
]

async function main() {
  const stamp = Date.now().toString(36)

  // ===== 1. 公开面 =====
  console.log('=== 公开路由(免 token) ===')
  const legacyReg = await api('POST', '/api/workshop/users/register', { body: { name: `authmx-legacy-${stamp}` } })
  check('P1 workshop 遗留注册免 token 可达', legacyReg.status === 200 && legacyReg.code === 0, legacyReg.message)

  const login = await api('POST', '/api/users/login', { body: { email: 'nonexistent@x.test', password: 'x' } })
  check('P2 login 免 token 进入认证逻辑(凭据错误 401 而非拦截)', login.status === 401 && login.code === 'UNAUTHORIZED', login.message)

  // a2a card:协议公开发现端点(不存在的 agent → 404,证明未被 401 拦截)
  const card = await api('GET', '/api/workshop/a2a/none-such-agent/card')
  check('P3 a2a agent card 免 token(404 而非 401)', card.status === 404, `status=${card.status}`)

  // ===== 2. 业务面:无 token 全部 401 =====
  console.log('\n=== 业务路由(无 token → 401) ===')
  for (const [method, path] of BUSINESS_ROUTES) {
    const r = await api(method, path)
    check(`401 ${method} ${path}`, r.status === 401 && r.code === 'USER_UNAUTHORIZED', `status=${r.status} code=${r.code}`)
  }

  // ===== 3. 有效 token 下抽检 =====
  console.log('\n=== 有效 token 行为抽检 ===')
  const email = `authmx-user-${stamp}@test.local`
  const reg = await api('POST', '/api/users/register', { body: { name: `authmx-main-${stamp}`, email, password: 'Passw0rd!123' } })
  const token = reg.data?.token
  if (!token) throw new Error(`注册失败: ${reg.message}`)

  for (const [method, path, expectStatus] of BUSINESS_ROUTES) {
    const body = method === 'POST' && (path.includes('/agents') || path.includes('/channels'))
      ? (path.includes('/agents') ? { name: `mx-${stamp}`, harness: 'mock' } : { name: `mx-ch-${stamp}` })
      : (method === 'POST' ? {} : undefined)
    const r = await api(method, path, { token, body })
    check(`${expectStatus} ${method} ${path}(带 token)`, r.status === expectStatus, `status=${r.status} code=${r.code}`)
  }

  // game/cmd 与 game/ws:游戏域端点已随 2D→3D 小镇重构移除(2026),check 从略。
  // 等价鉴权语义由 workshop/town/device 域用例覆盖(见 test-dual-drive / e2e-rest-robustness)。
  console.log('SKIP  game/cmd + game/ws(游戏域端点已移除,鉴权语义由 town/device 域覆盖)')

  // ===== 4. users 管理面:无 token 401;普通 token 403 =====
  console.log('\n=== 用户管理面分层 ===')
  const noTok = await api('GET', '/api/users')
  check('U1 /api/users 无 token → 401', noTok.status === 401 && noTok.code === 'USER_UNAUTHORIZED')
  const userTok = await api('GET', '/api/users', { token })
  check('U2 /api/users 普通用户 → 403 ADMIN_REQUIRED', userTok.status === 403 && userTok.code === 'ADMIN_REQUIRED')

  console.log(`\n${pass} pass / ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('E2E 崩溃:', e)
  process.exit(1)
})
