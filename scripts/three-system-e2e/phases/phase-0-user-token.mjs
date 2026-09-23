/**
 * 0. 用户 token(持久化演示账号 → env → 现场注册)—— 原 L83–116
 * (由 scripts/three-system-e2e.mjs 按职责拆出;语句逐行原文搬运,仅跨模块引用/状态访问机械改写)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, api, ok } from '../lib.mjs'
import { getUserId, getUserToken, setUserId, setUserToken } from '../state.mjs'

export async function run() {
  console.log('\n══ 三系统集成 e2e ══')
  const TOKEN_FILE = join(ROOT, '.AgentWorkShop', 'data', '.three-system-e2e-token.json')
  try {
    const saved = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'))
    setUserToken(saved.token ?? '')
    setUserId(saved.uid ?? '')
  }
  catch { /* 首跑 */ }
  if (getUserToken()) {
    // 持久化 token 可能已随 users.sqlite 重建失效 → 先验证,失效则现场重新注册
    const me = await api('GET', '/api/workshop/users/me', { token: getUserToken() })
    if (me.status !== 200) {
      console.log('  · 持久化 token 已失效,重新注册 e2e 用户')
      setUserToken('')
      setUserId('')
    }
  }
  if (!getUserToken() && process.env.AW_E2E_TOKEN) setUserToken(process.env.AW_E2E_TOKEN)
  if (!getUserToken()) {
    const name = `e2e3sys-${Date.now().toString(36)}`
    const reg = await api('POST', '/api/workshop/users/register', { body: { name } })
    setUserToken(reg?.json?.data?.token ?? '')
    setUserId(reg?.json?.data?.id ?? '')
    try {
      writeFileSync(TOKEN_FILE, JSON.stringify({ token: getUserToken(), uid: getUserId(), name }))
    }
    catch { /* 忽略 */ }
    ok(Boolean(getUserToken()), '注册 e2e 用户拿 token', getUserToken() ? 'ok' : `resp=${JSON.stringify(reg.json).slice(0, 120)}`)
    if (!getUserToken()) process.exit(1)
  }
  else { console.log('  · 复用持久化演示账号 token') }
}
