/**
 * 0c. 插件出站鉴权夹具:rag-knowledge(MCP token)+ 诊断服务(API token)→ 写入系统配置 —— 原 L173–254
 * (由 scripts/three-system-e2e.mjs 按职责拆出;语句逐行原文搬运,仅跨模块引用/状态访问机械改写)
 *
 * rag-knowledge(MCP token)+ 诊断服务(API token)→ 写入系统配置:
 * 两外部服务默认开启鉴权(rag-knowledge server.auth / IDD AUTH_ENABLED!==0),
 * rag-bridge/diag-bridge 的出站 token 走前端全局配置(plugins.kb.token / plugins.diag.token),
 * 此处拿真实 token 后经 PATCH /api/system/settings 配置 —— 同时验证「配置界面 → 插件热生效」链路。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, DIAG, ROOT, api, ok, raw, sleep } from '../lib.mjs'
import { getUserToken, setKbTokenG } from '../state.mjs'

export async function run() {
  try {
    // admin 夹具:注册临时用户 → users.sqlite 直改 role=admin(resolveUser 按请求查库,即时生效)
    let adminToken = process.env.AW_E2E_ADMIN_TOKEN ?? ''
    if (!adminToken) {
      const adminName = `e2e3sys-admin-${Date.now().toString(36)}`
      const reg = await api('POST', '/api/workshop/users/register', { body: { name: adminName } })
      adminToken = reg?.json?.data?.token ?? ''
      const adminId = reg?.json?.data?.id ?? ''
      if (adminToken && adminId) {
        const dbPath = join(ROOT, '.AgentWorkShop', 'data', 'users.sqlite')
        const db = new DatabaseSync(dbPath)
        db.exec('PRAGMA busy_timeout=4000')
        db.prepare('UPDATE users SET role = \'admin\' WHERE id = ?').run(adminId)
        db.close()
        console.log(`  · admin 夹具就绪(${adminName} → role=admin)`)
      }
      else {
        console.log('  ! admin 夹具注册失败,系统配置断言将跳过')
      }
    }
    if (adminToken) {
      // ① rag-knowledge MCP token:优先 env,否则读 rag-knowledge .env
      let kbToken = process.env.KB_MCP_TOKEN ?? ''
      if (!kbToken) {
        const kbRoot = process.env.KB_ROOT ?? 'D:/codes/ClaudeGPT/rag_project/rag-knowledge'
        try {
          const envText = readFileSync(join(kbRoot, '.env'), 'utf8')
          kbToken = (envText.match(/^MCP_AUTH_TOKEN=(.+)$/m) ?? [])[1]?.trim() ?? ''
        }
        catch { /* .env 不可读 */ }
      }
      setKbTokenG(kbToken)
      // ② 诊断服务 token:优先 env,否则在 IDD 上注册 e2e 账号换会话 JWT
      let diagToken = process.env.IDD_API_TOKEN ?? ''
      if (!diagToken) {
        const iu = `e2e3sys_${Date.now().toString(36)}`
        const ipw = `E2e3sys${Date.now().toString(36)}a1`
        const reg = await raw('POST', `${DIAG}/api/auth/register`, { body: { username: iu, password: ipw, email: `${iu}@e2e.local` } })
        if (!reg.json?.data?.user) console.log(`  ! 诊断服务注册失败:${JSON.stringify(reg.json).slice(0, 120)}`)
        const login = await raw('POST', `${DIAG}/api/auth/login`, { body: { username: iu, password: ipw } })
        diagToken = login.json?.data?.session_token ?? login.json?.session_token ?? ''
        if (!diagToken) console.log('  ! 诊断服务注册/登录未取得 token(3210 鉴权断言可能失败)')
        else console.log('  · 诊断服务 e2e 账号 + 会话 token 就绪')
      }
      const patch = {}
      if (kbToken) patch['plugins.rag-bridge.token'] = kbToken
      if (diagToken) patch['plugins.diag-bridge.token'] = diagToken
      if (Object.keys(patch).length) {
        const set = await api('PATCH', '/api/system/settings', { token: adminToken, body: { override: patch } })
        ok(set.status === 200 && set.json?.data?.ok !== false, '插件出站 token 写入系统配置(PATCH /api/system/settings)', `keys=${Object.keys(patch).join(',')}`)
        if (set.status === 200) {
          // 配置即时查询回读 + 插件侧热生效(diag-bridge health.auth 应变 bearer)
          let hot = false
          for (let i = 0; i < 10 && !hot; i++) {
            await sleep(1000)
            const h = await raw('GET', `${BASE}/api/plugins/diag-bridge/health`, { token: getUserToken() })
            if (h.json?.auth === 'bearer') hot = true
          }
          ok(hot, 'diag-bridge 热读取新 token(配置保存 → 插件即时生效,免重启)')
        }
      }
      if (kbToken) {
        // rag-bridge 出站鉴权链路:带 token 后 catalog/建库应成功(kb.id 就绪)
        let kbReady = false
        let kbDetail = ''
        for (let i = 0; i < 12 && !kbReady; i++) {
          await sleep(2500)
          const h = await raw('GET', `${BASE}/api/plugins/rag-bridge/health`, { token: getUserToken() })
          kbDetail = `kb.id=${h.json?.kb?.id} auth=${h.json?.auth}`
          if (h.json?.kb?.id) kbReady = true
        }
        ok(kbReady, 'rag-bridge 带 token 打通 rag-knowledge(ensureKB 自愈 → kb.id 就绪)', kbDetail)
      }
    }
  }
  catch (err) {
    console.log(`  ! 插件出站鉴权夹具异常(继续): ${err?.message ?? err}`)
  }
}
