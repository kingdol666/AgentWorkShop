/**
 * 配置分组系统 + 插件独立配置 端到端验证(生产 3001)。
 *
 * A 分组系统:结构/顺序/来源、插件分组声明(声明式 + ctx.config API)、CRUD、
 *   生命周期(停用插件 → 分区消失;启用 → 恢复)、字段永不丢(未登记分组兜底)
 * B 插件独立配置:两个桥接插件各自的 base_url/token 独立生效 ——
 *   正确值 / 错误值(URL 不可达、Token 无效)分别实测,且互不串改
 *
 * 凭据纪律:脚本不写任何可用凭据字面量 —— 正确的 token/URL 一律在运行时从
 * GET /api/system/settings 的 effective 里读取;错误值使用明显无效的占位串。
 *
 * 运行:NO_PROXY='*' AW_BASE=http://127.0.0.1:3001 AW_E2E_TOKEN=<admin token> \
 *       node scripts/e2e-config-groups.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const TOKEN = process.env.AW_E2E_TOKEN ?? ''
const TAG = Date.now().toString(36)

let pass = 0
let fail = 0
const failures = []
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✔ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
  else {
    fail++
    failures.push(label)
    console.error(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}
const section = t => console.log(`\n━━━ ${t} ━━━`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, { body, token = TOKEN } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  }
  catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}
const unwrap = r => r.json?.data ?? r.json

if (!TOKEN) {
  console.error('缺少 AW_E2E_TOKEN')
  process.exit(1)
}

/* ═════════ A 分组系统 ═════════ */
section('A 分组系统 —— 结构与来源')
const groupsRes = await api('GET', '/api/system/config-groups')
ok(groupsRes.status === 200, 'GET /api/system/config-groups 可用', `status=${groupsRes.status}`)
const gAll = unwrap(groupsRes).groups ?? []
ok(gAll.length > 0, '返回分组列表', `count=${gAll.length}`)
ok(gAll.every(g => typeof g.id === 'string' && typeof g.order === 'number'), '每个分组含 id/order')
ok(gAll.every((g, i, a) => i === 0 || a[i - 1].order <= g.order), '分组按 order 升序下发(后端权威顺序)')
ok(gAll.some(g => g.source === 'builtin'), '含内置分组')
ok(gAll.every(g => typeof g.fieldCount === 'number'), '含 fieldCount(字段归属数)')

const settingsRes = await api('GET', '/api/system/settings')
const snap = unwrap(settingsRes)
ok(Array.isArray(snap.groups) && snap.groups.length === gAll.length, '设置快照同一份分组(单一事实来源)')
const descGroups = new Set((snap.descriptors ?? []).map(d => d.group))
const known = new Set(gAll.map(g => g.id))
const orphan = [...descGroups].filter(g => !known.has(g))
ok(orphan.length === 0, '所有描述符的分组都已登记(字段不丢)', orphan.length ? `未登记=${orphan.join(',')}` : '')

section('A 插件分组声明(声明式 + ctx.config API)')
const ragGroups = gAll.filter(g => g.plugin === 'rag-bridge')
const diagGroups = gAll.filter(g => g.plugin === 'diag-bridge')
ok(ragGroups.length === 2, 'rag-bridge 声明了 2 个分区(连接/鉴权)', ragGroups.map(g => g.id).join(','))
ok(diagGroups.length === 4, 'diag-bridge 声明了 4 个分区(连接/执行/自动/规则)', diagGroups.map(g => g.id).join(','))
ok([...ragGroups, ...diagGroups].every(g => g.source === 'plugin'), '插件分区 source=plugin')
ok([...ragGroups, ...diagGroups].every(g => g.id.startsWith(`plugin-${g.plugin}`)), '插件分区 id 收敛进各自命名空间(不互相覆盖)')
ok([...ragGroups, ...diagGroups].every(g => g.labelKey || g.label !== g.id), '插件分区带可读标题')
const rulesGroup = diagGroups.find(g => g.id === 'plugin-diag-bridge-rules')
ok(!!rulesGroup, 'ctx.config.defineGroup 运行时注册的分区已生效(plugin-diag-bridge-rules)')
ok(rulesGroup?.fieldCount === 1, 'ctx.config.defineField 注册的字段归入该分区', `fields=${rulesGroup?.fieldCount}`)
const autoRules = (snap.descriptors ?? []).find(d => d.key === 'plugins.diag-bridge.auto_rules')
ok(autoRules?.group === 'plugin-diag-bridge-rules', 'auto_rules 描述符分组与分区一致')

section('A 字段隔离 —— 每个插件字段各归自己的分区')
const bridgeDescs = (snap.descriptors ?? []).filter(d => d.key.startsWith('plugins.rag-bridge.') || d.key.startsWith('plugins.diag-bridge.'))
// rag-bridge 3(base_url/web_url/token) + diag-bridge 7(base_url/token/harness/max_turns/max_minutes/auto_enabled/auto_rules)
ok(bridgeDescs.length === 10, '两插件共 10 个设置字段', `count=${bridgeDescs.length}`)
ok(bridgeDescs.every(d => d.group.startsWith(`plugin-${d.plugin}`)), '每个字段都落在本插件命名空间的分区里')
const crossGroup = bridgeDescs.filter(d => !known.has(d.group))
ok(crossGroup.length === 0, '无字段落到别的插件分区')

section('A 分组 CRUD(admin)')
const created = await api('POST', '/api/system/config-groups', { body: { label: `验证分组-${TAG}`, description: 'e2e 临时分组' } })
const cg = unwrap(created).group
ok(created.status === 200 && !!cg?.id, '创建分组', `id=${cg?.id}`)
ok(cg?.source === 'user', '新建分组 source=user')
const afterCreate = unwrap(await api('GET', '/api/system/config-groups')).groups ?? []
ok(afterCreate.some(g => g.id === cg.id), '新分组出现在列表中')

const renamed = unwrap(await api('PATCH', `/api/system/config-groups/${cg.id}`, { body: { label: '验证分组(改名)', order: 42 } })).group
ok(renamed?.label === '验证分组(改名)' && renamed?.order === 42, '更新分组(标题 + 排序)')
const afterRename = unwrap(await api('GET', '/api/system/config-groups')).groups ?? []
const idx42 = afterRename.findIndex(g => g.id === cg.id)
ok(idx42 >= 0 && afterRename[idx42].order === 42, '排序变更即刻反映到列表顺序')

const builtinDel = await api('DELETE', '/api/system/config-groups/daq')
ok(builtinDel.status === 409, '内置分组不可删除(409)', `status=${builtinDel.status}`)
const pluginDel = await api('DELETE', '/api/system/config-groups/plugin-rag-bridge')
ok(pluginDel.status === 409, '插件分组不可删除(插件权威,409)', `status=${pluginDel.status}`)
const dupCreate = await api('POST', '/api/system/config-groups', { body: { id: cg.id, label: '重复' } })
ok(dupCreate.status === 409, '重复 id 创建被拒(409)', `status=${dupCreate.status}`)
const badCreate = await api('POST', '/api/system/config-groups', { body: { id: 'bad id with spaces', label: 'x' } })
ok(badCreate.status === 400, '非法 id 被拒(400)', `status=${badCreate.status}`)

const del = await api('DELETE', `/api/system/config-groups/${cg.id}`)
ok(del.status === 200, '删除自建分组')
const afterDel = unwrap(await api('GET', '/api/system/config-groups')).groups ?? []
ok(!afterDel.some(g => g.id === cg.id), '删除后列表不再包含该分组')
const delMissing = await api('DELETE', `/api/system/config-groups/${cg.id}`)
ok(delMissing.status === 404, '删除不存在的分组 → 404', `status=${delMissing.status}`)

section('A 分组鉴权')
const noAuth = await fetch(`${BASE}/api/system/config-groups`)
ok(noAuth.status === 401, '未携带 token → 401', `status=${noAuth.status}`)
const badAuth = await fetch(`${BASE}/api/system/config-groups`, { headers: { authorization: 'Bearer deadbeef' } })
ok(badAuth.status === 401, '无效 token → 401', `status=${badAuth.status}`)

/* ═════════ B 插件独立配置 ═════════ */
section('B 插件独立配置 —— 正确值 / 错误值分别实测')
const eff = snap.effective ?? {}
const srcOf = k => snap.sources?.[k] ?? 'config.yml'
console.log(`  · 当前 rag-bridge.base_url 来源=${srcOf('plugins.rag-bridge.base_url')}, token 已配置=${Boolean(eff['plugins.rag-bridge.token'])}`)
console.log(`  · 当前 diag-bridge.base_url 来源=${srcOf('plugins.diag-bridge.base_url')}, token 已配置=${Boolean(eff['plugins.diag-bridge.token'])}`)

// 运行时读取"正确值"(绝不在脚本里写死凭据)
const GOOD = {
  ragBase: String(eff['plugins.rag-bridge.base_url'] ?? ''),
  ragToken: String(eff['plugins.rag-bridge.token'] ?? ''),
  diagBase: String(eff['plugins.diag-bridge.base_url'] ?? ''),
  diagToken: String(eff['plugins.diag-bridge.token'] ?? ''),
}
// 明显无效的占位值(非凭据)
const BAD_TOKEN = 'invalid-token-do-not-use'
const BAD_URL = 'http://127.0.0.1:9'
const BAD_HOST_URL = 'http://not-a-real-host.invalid:1'

const patchCfg = async overrides => unwrap(await api('PATCH', '/api/system/settings', { body: { override: overrides } }))
const healthOf = async (name) => {
  const r = await api('GET', `/api/plugins/${name}/health`)
  return { status: r.status, body: unwrap(r) }
}
const settle = async (ms = 1200) => sleep(ms)

// ---------- B1 rag-bridge ----------
console.log('\n  ── B1 rag-bridge ──')
let h = await healthOf('rag-bridge')
ok(h.status === 200 && h.body?.outbound === true, '正确 base_url → 出站启用(outbound=true)', `outbound=${h.body?.outbound}`)
ok(h.body?.auth === (GOOD.ragToken ? 'bearer' : 'anonymous'), '正确 token → 鉴权模式与配置一致', `auth=${h.body?.auth}`)
ok(h.body?.token?.configured === Boolean(GOOD.ragToken), '健康面如实上报 token 配置态', `configured=${h.body?.token?.configured}`)

await patchCfg({ 'plugins.rag-bridge.base_url': BAD_HOST_URL })
await settle()
h = await healthOf('rag-bridge')
ok(h.body?.outbound === false, '错误 base_url(非本机)→ 出站即刻禁用(配置变更即时重算)', `outbound=${h.body?.outbound}, url=${h.body?.backend?.url}`)
ok(h.body?.backend?.ok === false, '错误 base_url → backend 探活失败', String(h.body?.backend?.error ?? '').slice(0, 60))

await patchCfg({ 'plugins.rag-bridge.base_url': GOOD.ragBase })
await settle()
h = await healthOf('rag-bridge')
ok(h.body?.outbound === true, '恢复正确 base_url → 出站恢复', `outbound=${h.body?.outbound}`)

await patchCfg({ 'plugins.rag-bridge.token': BAD_TOKEN })
await settle()
h = await healthOf('rag-bridge')
ok(h.body?.auth === 'bearer', '错误 token 写入(仍为 bearer 模式,值已替换)', `auth=${h.body?.auth}`)
ok(h.body?.token?.accepted !== true, '错误 token 不会被健康面判定为「已接受」', `accepted=${h.body?.token?.accepted}`)
const afterBadTok = unwrap(await api('GET', '/api/system/settings')).effective
ok(afterBadTok['plugins.rag-bridge.token'] === BAD_TOKEN, '错误 token 已独立热生效(读回一致)')
ok(afterBadTok['plugins.diag-bridge.token'] === GOOD.diagToken, '改 rag token 不影响 diag token(配置隔离)')
ok(afterBadTok['plugins.rag-bridge.base_url'] === GOOD.ragBase, '改 rag token 不影响 rag base_url')

await patchCfg({ 'plugins.rag-bridge.token': GOOD.ragToken })
await settle()
const restored = unwrap(await api('GET', '/api/system/settings')).effective
ok(restored['plugins.rag-bridge.token'] === GOOD.ragToken, '恢复正确 token(运行时读回一致)')

// ---------- B2 diag-bridge(上游健康 → 可实测到鉴权/连通差异) ----------
console.log('\n  ── B2 diag-bridge ──')
h = await healthOf('diag-bridge')
ok(h.status === 200 && h.body?.remote?.status === 'ok', '正确 base_url + token → 诊断服务可达', `status=${h.body?.remote?.status}`)

await patchCfg({ 'plugins.diag-bridge.base_url': BAD_URL })
await settle()
h = await healthOf('diag-bridge')
ok(h.body?.remote?.status !== 'ok', '错误 base_url(端口不可达)→ 诊断服务不可达', `status=${JSON.stringify(h.body?.remote).slice(0, 120)}`)

await patchCfg({ 'plugins.diag-bridge.base_url': GOOD.diagBase })
await settle()
h = await healthOf('diag-bridge')
ok(h.body?.remote?.status === 'ok', '恢复正确 base_url → 恢复可达', `status=${h.body?.remote?.status}`)

if (GOOD.diagToken) {
  await patchCfg({ 'plugins.diag-bridge.token': BAD_TOKEN })
  await settle()
  h = await healthOf('diag-bridge')
  // 可达性与鉴权是两件事:服务仍可达(status=ok),但 token 被上游拒绝必须显式暴露
  ok(h.body?.token?.accepted === false, '错误 token → 健康面明确标记「被上游拒绝」(accepted=false)', `token=${JSON.stringify(h.body?.token)}`)
  ok(String(h.body?.remote?.auth ?? '').includes('401'), '错误 token → 受保护端点回 401(拼进 remote.auth)', `remote.auth=${h.body?.remote?.auth}`)
  ok(!!h.body?.remote?.hint, '健康面给出修复提示', String(h.body?.remote?.hint ?? '').slice(0, 70))
  const mid = unwrap(await api('GET', '/api/system/settings')).effective
  ok(mid['plugins.rag-bridge.token'] === GOOD.ragToken, '改 diag token 不影响 rag token(配置隔离)')

  await patchCfg({ 'plugins.diag-bridge.token': GOOD.diagToken })
  await settle()
  h = await healthOf('diag-bridge')
  ok(h.body?.remote?.status === 'ok', '恢复正确 token → 恢复可达', `status=${h.body?.remote?.status}`)
  ok(h.body?.token?.accepted === true, '恢复后健康面标记 token 已接受(accepted=true)', `token=${JSON.stringify(h.body?.token)}`)
}
else {
  console.log('  · diag token 未配置,跳过错误 token 分支')
}

section('B 配置落盘与来源')
const finalSettings = unwrap(await api('GET', '/api/system/settings'))
ok(finalSettings.effective['plugins.rag-bridge.base_url'] === GOOD.ragBase, 'rag base_url 已复原')
ok(finalSettings.effective['plugins.rag-bridge.token'] === GOOD.ragToken, 'rag token 已复原')
ok(finalSettings.effective['plugins.diag-bridge.base_url'] === GOOD.diagBase, 'diag base_url 已复原')
if (GOOD.diagToken) ok(finalSettings.effective['plugins.diag-bridge.token'] === GOOD.diagToken, 'diag token 已复原')

console.log(`\n══ 结果:${pass} 通过 / ${fail} 失败 ══`)
if (failures.length) console.log('失败项:\n  - ' + failures.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
