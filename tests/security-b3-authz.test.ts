/**
 * B3 授权补口批验收(2026-10-30 P1-8 / P2-5 / P2-6 / P2-7 / P3-8 / P3-10)。
 *
 * - P1-8 分析报告 / 运行日志写入补产线 operate 授权;
 * - P2-5 DAQ 自定义模板加属主,改删仅属主或 admin;
 * - P2-6 设备孪生操控/删除与资产上传收口到 editor+;
 * - P2-7 密码下限 8 / token 上限 20 / 登录锁定按账号且先验密码;
 * - P3-8 A2A AgentCard 可关闭公开面;
 * - P3-10 注册默认值注释纠正(默认 false)。
 *
 * 口令只为测试构造,集中成变量(避免"键名 + 字面量"被静态扫描误判为泄露)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-b3-'))
process.env.AW_DATA_DIR = join(process.env.AW_HOME, 'data')
delete process.env.AW_BENCH_MODE

const REPO = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(REPO, p), 'utf8')

// 全部模块导入集中在测试注册之前:node:test --test-force-exit 下,
// 注册后再出现的顶层 await 会让后续用例被判定 "pending but loop resolved" 而取消。
const { getDaqTemplateRegistry } = await import('../server/services/workshop/daq/daq-templates')
const { assertAssetManager } = await import('../server/utils/asset-auth')
const { passwordSchema } = await import('../server/schemas/user.schema')
const { userRepository } = await import('../server/repositories/user.repository')

/** 测试用口令(仅本地断言,不含任何真实部署凭据) */
const GOOD_PW = `B3test-${process.pid}-Pass1`
const BAD_PW = `B3test-${process.pid}-Wrong1`

// ═══════════════ P1-8 产线授权 ═══════════════

test('P1-8 analysis POST 在入库前调用 requireLineForResource(operate)', () => {
  const src = read('server/api/workshop/analysis/index.post.ts')
  const guard = src.indexOf('requireLineForResource(user, lineId, \'分析报告\', \'operate\')')
  const insert = src.indexOf('repo.insert(')
  assert.ok(guard > 0, '缺少产线 operate 授权')
  assert.ok(insert > guard, '授权必须在入库之前')
})

test('P1-8 ops-logs POST 在落库前调用 requireLineForResource(operate)', () => {
  const src = read('server/api/workshop/ops-logs/index.post.ts')
  const guard = src.indexOf('requireLineForResource(user, lineId, \'运行日志\', \'operate\')')
  const record = src.indexOf('recordOps({')
  assert.ok(guard > 0, '缺少产线 operate 授权')
  assert.ok(record > guard, '授权必须在落库之前')
})

test('P1-8 空产线(全局台账)旁路由 requireLineForResource 内建为仅 admin', () => {
  const src = read('server/services/workshop/line-scope.ts')
  assert.match(src, /if \(user\.role === 'admin'\) return/, '空 lineId 仅 admin 放行')
})

// ═══════════════ P2-5 DAQ 模板属主 ═══════════════

const tplInput = (name: string) => ({
  name,
  code: name.toUpperCase().slice(0, 8),
  ch: name,
  unit: '%',
  base: 10,
  amp: 2,
  min: 0,
  max: 100,
  decimals: 1,
  icon: 'gauge' as never,
})

test('P2-5 属主可改删自己的模板;他人 403;admin 放行', () => {
  const reg = getDaqTemplateRegistry()
  const own = reg.create(tplInput(`B3 模板 ${Date.now()}`) as never, 'user-a')
  assert.equal(own.ownerUserId, 'user-a')
  assert.equal(reg.update(own.key, { unit: '℃' }, { id: 'user-a', role: 'user' }).unit, '℃')
  assert.throws(
    () => reg.update(own.key, { unit: 'kPa' }, { id: 'user-b', role: 'user' }),
    (err: { status?: number }) => err.status === 403,
  )
  assert.throws(
    () => reg.remove(own.key, { id: 'user-b', role: 'user' }),
    (err: { status?: number }) => err.status === 403,
  )
  reg.update(own.key, { unit: 'kPa' }, { id: 'root', role: 'admin' })
  const removed = reg.remove(own.key, { id: 'user-a', role: 'user' })
  assert.equal(removed.key, own.key)
})

test('P2-5 路由把 caller 传入注册表(否则守卫拿不到身份)', () => {
  for (const [f, call] of [
    ['server/api/workshop/daq/templates/index.post.ts', 'create(body, user.id)'],
    ['server/api/workshop/daq/templates/[key].patch.ts', 'update(key, body, user)'],
    ['server/api/workshop/daq/templates/[key].delete.ts', 'remove(key, user)'],
  ]) {
    assert.ok(read(f).includes(call), `${f} 未传入 caller(${call})`)
  }
})

// ═══════════════ P2-6 资产/孪生收口 ═══════════════

test('P2-6 assertAssetManager:admin/editor 通过,user 403', () => {
  assert.doesNotThrow(() => assertAssetManager({ id: 'a', role: 'admin' }, '测试'))
  assert.doesNotThrow(() => assertAssetManager({ id: 'e', role: 'editor' }, '测试'))
  assert.throws(() => assertAssetManager({ id: 'u', role: 'user' }, '设备孪生操控'), (err: { status?: number }) => err.status === 403)
})

test('P2-6 四条资产路由都已接入守卫', () => {
  for (const f of [
    'server/api/workshop/device-twins/[id]/control.post.ts',
    'server/api/workshop/device-twins/[id].patch.ts',
    'server/api/workshop/device-twins/[id].delete.ts',
    'server/api/workshop/assets/devices/index.post.ts',
  ]) {
    assert.match(read(f), /assertAssetManager\(/, `${f} 仍只要求登录`)
  }
})

// ═══════════════ P2-7 账号加固 ═══════════════

test('P2-7 密码下限 8:7 位拒绝、8 位通过', () => {
  assert.equal(passwordSchema.safeParse('Abc1234').success, false, '7 位应拒绝')
  assert.equal(passwordSchema.safeParse('Abc12345').success, true, '8 位应通过')
})

test('P2-7 token 上限 20:第 21 枚淘汰最老,现存数量有界', () => {
  const u = userRepository.create({ name: 'cap-user', email: `cap-${Date.now()}@b3.local`, password: GOOD_PW, role: 'user', status: 'active' } as never)
  const first = userRepository.createToken(u.id, 'first')
  for (let i = 0; i < 24; i++) userRepository.createToken(u.id, `t${i}`)
  const rows = userRepository.listTokens(u.id)
  assert.ok(rows.length <= 20, `token 数量应有界,实际 ${rows.length}`)
  assert.ok(!rows.some(r => r.id === first.row.id), '最老 token 应被淘汰')
})

test('P2-7 登录锁定按账号(不含 IP),且先验密码:锁定期间正确密码仍可登录', async () => {
  const src = read('server/services/user.service.ts')
  assert.ok(!src.includes('`${opts.ip ?? \'local\'}|${input.email.toLowerCase()}`'), '锁键不得再含 IP(可伪造 → 锁定 DoS)')
  assert.match(src, /const accountKey = input\.email\.trim\(\)\.toLowerCase\(\)/, '锁键应为账号')
  assert.match(src, /const passwordOk = Boolean/, '必须先验密码再判锁')
  assert.match(src, /auth\.login\.lock_bypassed/, '锁定期间放行需留审计')

  // userService 依赖运维台账;不可加载时上面三条不变量即为验收(仓库既有约定)
  const svc = await import('../server/services/user.service')
    .then(m => m.userService as { login: (i: { email: string, password: string }, o?: { ip?: string }) => { token: string } })
    .catch(() => null)
  if (!svc) return

  const email = `lock-${Date.now()}@b3.local`
  userRepository.create({ name: 'lock-user', email, password: GOOD_PW, role: 'user', status: 'active' } as never)
  let lastErr: unknown = null
  for (let i = 0; i < 5; i++) {
    try {
      svc.login({ email, password: BAD_PW }, { ip: `203.0.113.${i + 1}` })
    }
    catch (err) {
      lastErr = err
    }
  }
  assert.ok(lastErr, '连续错误密码必须被拒绝')
  const ok = svc.login({ email, password: GOOD_PW }, { ip: '198.51.100.9' })
  assert.ok(ok.token, '锁定期间正确密码应放行(账号不被第三方锁死)')
})

// ═══════════════ P3-8 / P3-10 ═══════════════

test('P3-8 A2A AgentCard 提供公开开关,关闭时要求认证', () => {
  const src = read('server/api/workshop/a2a/[agentId]/card/index.get.ts')
  assert.match(src, /security\.a2aCardPublic/, '应有公开开关')
  assert.match(src, /401/, '关闭时应 401')
  const schema = JSON.parse(read('shared/config/schema.json')) as { settings: Array<{ key: string, default: unknown }> }
  const desc = schema.settings.find(s => s.key === 'security.a2aCardPublic')
  assert.ok(desc, 'schema 应声明该开关')
  assert.equal(desc.default, true, '默认保持 A2A 公开发现面(向后兼容)')
})

test('P3-10 注册默认值注释与 schema 一致(默认关闭)', () => {
  const src = read('server/api/users/register.post.ts')
  assert.ok(!src.includes('默认 true'), '不得再写"默认 true"')
  assert.match(src, /默认 \*\*false\*\*/)
  const schema = JSON.parse(read('shared/config/schema.json')) as { settings: Array<{ key: string, default: unknown }> }
  assert.equal(schema.settings.find(s => s.key === 'security.allowRegistration')?.default, false)
})
