/**
 * DCW 写入保持窗(写锁)REST E2E —— 对运行中的隔离实例验证完整链路。
 *
 * 前置:隔离 dev 实例(全新配置根,首注册即 admin)
 *   AW_MODE=home AW_HOME=<fresh-dir> node bin/aw.mjs dev --port 3461
 * 运行: node scripts/_dbg-write-lock-e2e.mjs
 *   WL_E2E_BASE / WL_E2E_EMAIL / WL_E2E_PASSWORD 可覆写
 *
 * 覆盖:
 *  1. 建节点携带 writeLockSeconds(默认 30 / 自定义 2)→ toView 回读
 *  2. 写成功 → 立即再写 → 429 WRITE_FREQUENT「当前写入频繁」
 *  3. 保持窗(2s)经过后再写 → 成功
 *  4. PATCH writeLockSeconds=0(不锁)→ 连续写不再 429
 *  5. PATCH 非法值(9999 / -1)→ 400 VALIDATION_ERROR
 *  6. 清理删除节点
 */
const BASE = process.env.WL_E2E_BASE ?? 'http://127.0.0.1:3461'
const EMAIL = process.env.WL_E2E_EMAIL ?? 'write-lock-e2e@awshop.local'
const PASSWORD = process.env.WL_E2E_PASSWORD ?? 'writeL0ck'

let n = 0
let bad = 0
const ok = (name, cond, detail = '') => {
  n += 1
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) bad += 1
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, ...json }
}

async function waitUp(deadlineMs = 180_000) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/users/setup-status`)
      if (r.ok) return true
    }
    catch { /* not up yet */ }
    await sleep(1500)
  }
  return false
}

async function login() {
  const reg = await api('POST', '/api/users/register', { body: { name: 'write-lock-e2e', email: EMAIL, password: PASSWORD } })
  if (reg.code === 0 && reg.data?.token) return reg.data.token
  const login = await api('POST', '/api/users/login', { body: { email: EMAIL, password: PASSWORD } })
  if (login.code === 0 && login.data?.token) return login.data.token
  throw new Error(`注册/登录均失败: ${JSON.stringify(reg)} / ${JSON.stringify(login)}`)
}

async function main() {
  console.log('━━━ DCW 写入保持窗 REST E2E ━━━')
  console.log(`base = ${BASE}`)
  if (!await waitUp()) {
    console.error('服务未在时限内就绪')
    process.exit(1)
  }
  const token = await login()
  ok('认证就绪', !!token)

  // 取一个模板键(dcw index 随 nodes 一并返回 templates)
  const tpl = await api('GET', '/api/workshop/dcw', { token })
  const tplKey = tpl.data?.templates?.[0]?.key
  ok('存在 DCW 模板', !!tplKey, `key=${tplKey}`)

  // 1. 建节点(写锁 2s)
  const lo = Number.isFinite(Number(tpl.data?.templates?.[0]?.min)) ? Number(tpl.data.templates[0].min) : 0
  const hi = Number.isFinite(Number(tpl.data?.templates?.[0]?.max)) ? Number(tpl.data.templates[0].max) : 100
  const v1 = Math.round((lo + hi) / 2)
  const created = await api('POST', '/api/workshop/dcw', {
    token,
    body: { templateRef: `dcw-${tplKey}`, driver: 'mock', name: 'write-lock-e2e', writeLockSeconds: 2 },
  })
  ok('建节点成功', created.code === 0 && !!created.data?.node?.id, JSON.stringify(created).slice(0, 120))
  const id = created.data?.node?.id
  ok('writeLockSeconds=2 回读', created.data?.node?.writeLockSeconds === 2)
  if (!id) process.exit(1)

  const write = async (value) => api('POST', `/api/workshop/dcw/${id}/write`, { token, body: { value } })

  // 2. 首写成功(落在量程中点)
  const w1 = await write(v1)
  ok('首写成功', w1.code === 0, JSON.stringify(w1).slice(0, 120))

  // 3. 立即再写 → 429 WRITE_FREQUENT「当前写入频繁」
  const w2 = await write(v1 + 1)
  ok('锁定窗内被拒', w2.status === 429 && w2.code === 'WRITE_FREQUENT', `status=${w2.status} code=${w2.code}`)
  ok('拒绝消息含「当前写入频繁」', String(w2.message ?? '').includes('当前写入频繁'), String(w2.message ?? '').slice(0, 80))

  // 4. 保持窗(2s)经过后再写 → 成功
  await sleep(2300)
  const w3 = await write(v1 + 1)
  ok('窗口经过后写成功', w3.code === 0, JSON.stringify(w3).slice(0, 120))

  // 5. PATCH writeLockSeconds=0(不锁)→ 连续写不再 429
  const p0 = await api('PATCH', `/api/workshop/dcw/${id}`, { token, body: { writeLockSeconds: 0 } })
  ok('PATCH 0 成功', p0.code === 0 && p0.data?.node?.writeLockSeconds === 0)
  const w4 = await write(v1)
  ok('锁关闭后立即写成功', w4.code === 0)

  // 6. PATCH 非法值 → 400
  const p9 = await api('PATCH', `/api/workshop/dcw/${id}`, { token, body: { writeLockSeconds: 9999 } })
  ok('非法值 9999 → 400', p9.status === 400 && p9.code === 'VALIDATION_ERROR', `status=${p9.status}`)
  const pn = await api('PATCH', `/api/workshop/dcw/${id}`, { token, body: { writeLockSeconds: -1 } })
  ok('非法值 -1 → 400', pn.status === 400, `status=${pn.status}`)

  // 7. 清理
  const del = await api('DELETE', `/api/workshop/dcw/${id}`, { token })
  ok('删除节点', del.code === 0 || del.status === 200)

  console.log(`\n━━━ 结果: ${n - bad}/${n} PASS${bad ? `, ${bad} FAIL` : ''} ━━━`)
  if (bad) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
