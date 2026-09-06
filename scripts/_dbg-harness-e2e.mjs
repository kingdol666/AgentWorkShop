/**
 * Harness 可用性检查 E2E(隔离实例 :3021)
 *  1) GET /harnesses:6 引擎 + available 探测(进程型有 resolvedPath)
 *  2) ?refresh=1 强制重探
 *  3) 负向:config.command 指向不存在的二进制 → 模板创建 409 HARNESS_UNAVAILABLE
 *  4) 负向:settings 热改 harness.dsh_command → dsh available=false;恢复后 true
 *  5) 未知 harness → 400 UNKNOWN_HARNESS
 *  6) 正向:模板创建/更新/克隆(harness 可用)照常
 */
const BASE = 'http://127.0.0.1:3021'
let token = process.argv[2] ?? ''
let pass = 0
let fail = 0

const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}
const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* ignore */ }
  return { status: res.status, json }
}

console.log('== 1. GET /api/workshop/harnesses ==')
{
  const { status, json } = await api('GET', '/api/workshop/harnesses')
  ok(status === 200, '200')
  const hs = json?.data?.harnesses ?? []
  ok(hs.length === 6, `6 harnesses(实际 ${hs.length})`)
  const byId = Object.fromEntries(hs.map(h => [h.id, h]))
  for (const id of ['omp', 'opencode', 'codex', 'dsh']) {
    ok(byId[id]?.available === true, `${id} available=true`)
    ok(!!byId[id]?.resolvedPath, `${id} resolvedPath=${byId[id]?.resolvedPath ?? '∅'}`)
    ok(byId[id]?.command === id, `${id} command=${byId[id]?.command}`)
  }
  ok(byId.mock?.available === true && byId.mock?.inprocess === true, 'mock in-process 恒可用')
  ok(byId.claude?.available === true && byId.claude?.inprocess === true, 'claude in-process 恒可用')
  ok(typeof byId.omp?.label === 'string' && typeof byId.omp?.capabilities?.steer === 'boolean', 'meta 能力面齐全')
}

console.log('== 2. ?refresh=1 强制重探 ==')
{
  const { json } = await api('GET', '/api/workshop/harnesses?refresh=1')
  ok(json?.data?.harnesses?.every(h => typeof h.available === 'boolean'), 'refresh 结果完整')
}

console.log('== 3. 负向:模板创建(引擎命令不存在)==')
{
  const r1 = await api('POST', '/api/workshop/agents', { name: 'bad-dsh', harness: 'dsh', config: { command: 'aw-definitely-missing-xyz' } })
  ok(r1.status === 409 && r1.json?.code === 'HARNESS_UNAVAILABLE', `409 HARNESS_UNAVAILABLE(实际 ${r1.status}/${r1.json?.code})`)
  ok(String(r1.json?.message ?? '').includes('aw-definitely-missing-xyz'), `人话报错含命令名:${r1.json?.message}`)
  // 同 harness、同错误命令的探测缓存 → 克隆路径同样拒绝
  const tpl = await api('POST', '/api/workshop/agents', { name: 'good-omp', harness: 'omp', config: {} })
  ok(tpl.status === 200, '正向:omp 模板创建成功')
  if (tpl.status === 200) await api('DELETE', `/api/workshop/agents/${tpl.json?.data?.id}`)
}

console.log('== 4. settings 热改 dsh 命令 → 探测联动 ==')
{
  await api('PATCH', '/api/system/settings', { override: { 'harness.dsh_command': 'aw-bogus-dsh-bin' } })
  await new Promise(r => setTimeout(r, 4000))
  const q = await api('GET', '/api/workshop/harnesses?refresh=1')
  const dsh = q.json?.data?.harnesses?.find(h => h.id === 'dsh')
  ok(dsh?.available === false, 'dsh available=false')
  ok(String(dsh?.command ?? '').includes('aw-bogus-dsh-bin'), `command 联动=${dsh?.command}`)
  await api('PATCH', '/api/system/settings', { override: { 'harness.dsh_command': null } })
  await new Promise(r => setTimeout(r, 4000))
  const q2 = await api('GET', '/api/workshop/harnesses?refresh=1')
  const dsh2 = q2.json?.data?.harnesses?.find(h => h.id === 'dsh')
  ok(dsh2?.available === true, '恢复后 dsh available=true')
}

console.log('== 5. 未知 harness ==')
{
  const r = await api('POST', '/api/workshop/agents', { name: 'u', harness: 'nope', config: {} })
  ok(r.status === 400 && r.json?.code === 'UNKNOWN_HARNESS', `400 UNKNOWN_HARNESS(实际 ${r.status}/${r.json?.code})`)
}

console.log('== 6. 未认证 ==')
{
  const res = await fetch(`${BASE}/api/workshop/harnesses`)
  ok(res.status === 401, `401(实际 ${res.status})`)
}

console.log(`\nRESULT: ${pass} pass / ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
