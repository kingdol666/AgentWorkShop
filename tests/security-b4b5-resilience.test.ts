/**
 * B4 韧性 + B5 结构债批验收(2026-10-30)。
 *
 * B4:P1-4 Modbus 首连去重 / P1-6 sweep 逐段隔离 / P1-7 出站 SSRF 护栏 /
 *     P2-3 CSP 生产去 unsafe-eval / P2-8 legacy 错误分支删除 / P1-10 限流 Map 回收与 chunked 上限
 * B5:P2-12 工具白名单单一源 / P3-2 备份并发互斥 / P3-7 json-store 读失败留痕
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-b45-'))
delete process.env.AW_ALLOW_PRIVATE_OUTBOUND

const REPO = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(REPO, p), 'utf8')

const { HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES, OBSERVE_BLOCKED_TOOL_NAMES } = await import('../server/services/workshop/agents/tool-classes')
const { assertSafeHttpUrl, allowPrivateOutbound } = await import('../server/services/workshop/net/ssrf')
const { loadJsonFile } = await import('../server/services/workshop/json-store.mjs')

// ═══════════════ P1-4 Modbus 首连在飞去重 ═══════════════

test('P1-4 getModbusConn 有 inflight 去重,且复用 createModbusConn', () => {
  const src = read('server/services/workshop/daq/drivers/modbus-tcp.ts')
  assert.match(src, /modbusInflight/, '缺少在飞映射')
  assert.match(src, /const pending = modbusInflight\.get\(key\)/, '未命中在飞任务')
  assert.match(src, /finally\s*\{\s*modbusInflight\.delete\(key\)/, 'finally 必须清理在飞条目')
  assert.match(src, /createModbusConn\(/, '建连应拆成独立函数以便复用')
})

// ═══════════════ P1-6 sweep 逐段隔离 ═══════════════

test('P1-6 daq sweep 逐段兜底(异常不冒泡、不跳过后续段)', () => {
  const src = read('server/services/workshop/daq/daq-controller/sweep-alarms.ts')
  assert.match(src, /private guardStep\(/, '缺少定时器安全包裹')
  assert.match(src, /this\.guardStep\('syncPushBindings'/, 'syncPushBindings 未包裹')
  assert.match(src, /this\.guardStep\('checkPushLiveness'/, 'checkPushLiveness 未包裹')
  assert.match(src, /到期判定异常\(已隔离\)/, '逐节点判定未包裹')
})

test('P1-6 dcw sweep 逐 runtime 兜底 + 回退评估兜底', () => {
  const src = read('server/services/workshop/dcw/dcw-controller/state.ts')
  assert.match(src, /tick 异常\(已隔离\)/, '单节点 tick 未隔离')
  assert.match(src, /回退评估异常\(已隔离\)/, '回退评估未隔离')
})

// ═══════════════ P1-7 出站 SSRF ═══════════════

test('P1-7 报警 webhook 出站前过 SSRF 护栏', () => {
  const src = read('server/services/workshop/daq/alarm-notify.ts')
  assert.match(src, /assertSafeHttpUrl\(/, 'webhook 未校验')
  assert.match(src, /SSRF 防护拒绝/, '拒绝原因应留痕到报警事件')
})

test('P1-7 embedding 服务地址过 SSRF 护栏(失败即熔断)', () => {
  const src = read('server/services/workshop/runtime/embedding-provider.ts')
  assert.match(src, /assertSafeHttpUrl\(baseUrl/, 'embedding baseUrl 未校验')
  assert.match(src, /disabledUntil = Number\.POSITIVE_INFINITY/, '校验失败应永久熔断')
})

test('P1-7 插件 ctx.http 拒绝私网/环回目标', () => {
  const src = read('sdk/context.mjs')
  assert.match(src, /function isPrivateAddress/, '缺少私网判定')
  for (const hint of ['169', '254', '127', 'localhost']) {
    assert.ok(src.includes(hint), `私网判定缺 ${hint} 段`)
  }
  assert.match(src, /AW_ALLOW_PRIVATE_OUTBOUND/, '需显式开关(默认拒绝)')
})

test('P1-7 行为:默认拒绝内网目标,开关打开后放行', async () => {
  delete process.env.AW_ALLOW_PRIVATE_OUTBOUND
  assert.equal(allowPrivateOutbound(), false)
  await assert.rejects(() => assertSafeHttpUrl('http://169.254.169.254/latest/meta-data', { label: '测试' }), (err: { status?: number }) => err.status === 400)
  await assert.rejects(() => assertSafeHttpUrl('http://127.0.0.1:8080/x', { label: '测试' }), (err: { status?: number }) => err.status === 400)
  await assert.rejects(() => assertSafeHttpUrl('file:///etc/passwd', { label: '测试' }), (err: { status?: number }) => err.status === 400)
  // 公网域名解析不在单测里做 DNS:只验证协议面
  process.env.AW_ALLOW_PRIVATE_OUTBOUND = '1'
  try {
    assert.equal(allowPrivateOutbound(), true)
    const u = await assertSafeHttpUrl('http://127.0.0.1:8080/x', { label: '测试', allowPrivateHost: 'true' })
    assert.equal(u.hostname, '127.0.0.1')
  }
  finally {
    delete process.env.AW_ALLOW_PRIVATE_OUTBOUND
  }
})

// ═══════════════ P2-3 CSP ═══════════════

test('P2-3 CSP:生产环境不带 unsafe-eval', () => {
  const src = read('server/middleware/00-security-headers.ts')
  assert.match(src, /ALLOW_EVAL = process\.env\.NODE_ENV !== 'production'/, '需按生产环境判定')
  // unsafe-eval 只允许出现在 ALLOW_EVAL 的三元分支里(不得作为静态字面量常驻)
  const lines = src.split(String.fromCharCode(10)).filter(l => l.includes('script-src') && /`/.test(l))
  assert.ok(lines.length > 0, '未找到 unsafe-eval 拼接点')
  for (const line of lines) {
    assert.ok(line.includes('ALLOW_EVAL ?'), `unsafe-eval 未受 ALLOW_EVAL 守卫:${line.trim()}`)
  }
})

// ═══════════════ P2-8 legacy 错误分支 ═══════════════

test('P2-8 响应层不再直通裸 Error 的 message', () => {
  const src = read('server/utils/response.ts')
  assert.ok(!src.includes('legacyStatus'), 'legacy 分支应删除')
  assert.ok(!src.includes('message: (error as Error).message'), '不得直通任意 Error 消息')
})

test('P2-8 全仓已无 Object.assign(new Error){status} 生产者', () => {
  for (const f of [
    'server/services/workshop/daq/daq-controller/crud.ts',
    'server/services/workshop/daq/daq-controller/driver-probe.ts',
    'server/services/workshop/daq/daq-controller/frames.ts',
    'server/services/workshop/eda/data-export.ts',
  ]) {
    assert.ok(!read(f).includes('Object.assign(new Error'), `${f} 仍有裸 status 错误`)
  }
})

// ═══════════════ P1-10 限流 Map 与 chunked ═══════════════

test('P1-10 限流 Map 有惰性清扫 + chunked body 直接拒绝', () => {
  const src = read('server/middleware/01-rate-guard.ts')
  assert.match(src, /sweepExpired/, '缺少过期条目清扫')
  assert.match(src, /SWEEP_EVERY/, '清扫应有节流')
  assert.match(src, /transfer-encoding/, '应识别 chunked')
  assert.match(src, /Chunked request body not allowed/, 'chunked 应直接拒绝')
})

// ═══════════════ B5 结构债 ═══════════════

test('P2-12 观察拒写面由单一源派生(dispatch 不再内联 8 项)', () => {
  const dispatch = read('server/services/workshop/agents/host-tool-bridge/dispatch.ts')
  assert.ok(!dispatch.includes('\'dcw_control\', \'param_control\''), 'dispatch 仍有内联清单(第三份)')
  assert.match(dispatch, /OBSERVE_BLOCKED_TOOL_NAMES/, '应使用派生集')
  assert.match(dispatch, /HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES\.has\(/, '写面守卫应查单一源集合')
})

test('P2-12 派生集不变式:直写族 ⊆ 观察拒写面', () => {
  for (const tool of HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES) {
    assert.ok(OBSERVE_BLOCKED_TOOL_NAMES.has(tool), `${tool} 未进入观察拒写面`)
  }
  for (const extra of ['optimization_explore', 'recipe_propose', 'line_start', 'line_stop']) {
    assert.ok(OBSERVE_BLOCKED_TOOL_NAMES.has(extra), `${extra} 应在观察拒写面`)
  }
  assert.equal(HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES.size, 8)
})

test('P3-2 backupOnce 并发互斥(在飞复用同一 promise)', () => {
  const src = read('server/plugins/backup.ts')
  assert.match(src, /inFlightBackup/, '缺少在飞标志')
  assert.match(src, /if \(inFlightBackup\) return inFlightBackup/, '并发调用应复用同一任务')
})

test('P3-7 json-store 读失败(非 ENOENT)留痕', () => {
  // 行为验证:指向一个目录路径 → readFileSync 抛 EISDIR/EPERM,应打 warn 且返回 fallback
  const warnings: string[] = []
  const orig = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(' '))
  }
  try {
    const out = loadJsonFile(mkdtempSync(join(tmpdir(), 'aw-js-')), { a: 1 })
    assert.deepEqual(out, { a: 1 }, '读失败应回落 fallback')
    assert.ok(warnings.some(w => w.includes('[json-store] 读取失败')), '应留一条 warn')
  }
  finally {
    console.warn = orig
  }
})
