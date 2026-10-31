/**
 * B2 子进程与密钥批验收(2026-10-30 P1-1 / P1-2 / P1-3 / P2-1 / P2-11)。
 *
 * - P1-1 omp 子进程不得继承平台会话/管理员口令;
 * - P1-2 MES hook 子进程走白名单 env(与 AML 训练器同口径);
 * - P1-3 设置面凭据出口掩码,掩码回传不覆盖真实值;
 * - P2-1 ingest token 常量时间比较(行为等价 + 实现断言);
 * - P2-11 AW_BENCH_MODE 单 env 不再解除防线。
 *
 * 说明:平台秘密变量名集中成数组、值统一合成,避免把"键名 + 值"写成字面量对
 * (静态扫描会误判为真实凭据;本轮审计已确认该规则误报面)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-b2-'))
delete process.env.AW_BENCH_MODE
delete process.env.AW_BENCH_ACK

const REPO = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(REPO, p), 'utf8')

// ═══════════════ P1-1 omp 子进程 env ═══════════════

const { scrubPlatformSecrets } = await import('../server/services/workshop/agents/adapters/line-spawn')

/** 平台秘密变量名(与 line-spawn PLATFORM_SECRET_ENV 同源,此处只做断言) */
const PLATFORM_SECRET_NAMES = ['NUXT_SESSION_PASSWORD', 'AW_ADMIN_PASSWORD', 'AW_E2E_TOKEN', 'CLOUDFLARE_TUNNEL_TOKEN']

test('P1-1 scrubPlatformSecrets 剥离会话/管理员/隧道凭据', () => {
  const synthetic = 'synthetic-value-for-assertion'
  const input: Record<string, string> = { PATH: '/usr/bin', AW_ENGINE_PROVIDER_KEY: synthetic }
  for (const name of PLATFORM_SECRET_NAMES) input[name] = synthetic
  const env = scrubPlatformSecrets(input)
  assert.equal(env.PATH, '/usr/bin')
  for (const name of PLATFORM_SECRET_NAMES) {
    assert.equal(env[name], undefined, `${name} 不得泄入引擎子进程`)
  }
  // 引擎自身凭据不在平台秘密面内(由引擎配置/显式 env 管理)
  assert.equal(env.AW_ENGINE_PROVIDER_KEY, synthetic)
})

test('P1-1 omp 启动器使用同一清洗函数(不得全量继承 process.env)', () => {
  const src = read('server/services/workshop/agents/adapters/omp-rpc-client/start.ts')
  assert.match(src, /scrubPlatformSecrets\(/, 'omp 必须复用平台秘密清洗')
  assert.ok(!src.includes('env: { ...process.env, ...this.options.env }'), '不得保留全量继承写法')
})

// ═══════════════ P1-2 MES hook 白名单 ═══════════════

test('P1-2 MES hook 走 cleanEnv 白名单(不再只剥 10 键)', () => {
  const src = read('server/services/workshop/mes/mes-hook.ts')
  assert.match(src, /cleanEnv: true/, '必须使用白名单语义')
  assert.match(src, /hookEnv\(\)/, '应有显式白名单构造')
  const fn = src.slice(src.indexOf('const HOOK_ENV_ALLOW'), src.indexOf('async function runHookModule'))
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'USERPROFILE']) {
    assert.ok(fn.includes(`'${k}'`), `白名单缺系统必需键 ${k}`)
  }
  assert.match(fn, /AW_MES_/, 'hook 专用变量应经 AW_MES_* 显式放行')
})

// ═══════════════ P1-3 设置面掩码 ═══════════════

const { maskSecretSettings, stripMaskedSettings, isSecretSettingKey, SECRET_MASK } = await import('../server/services/system-config/secrets')

test('P1-3 凭据键识别:password/secretKey/api_key/token 命中,业务键不误伤', () => {
  for (const k of ['daq.mqtt.password', 'daq.objectstore.secretKey', 'daq.objectstore.accessKey', 'memory.embed_api_key', 'plugins.rag.token']) {
    assert.equal(isSecretSettingKey(k), true, `${k} 应判为凭据`)
  }
  for (const k of ['daq.mqtt.username', 'daq.timescale.host', 'security.allowRegistration', 'server.prod.port']) {
    assert.equal(isSecretSettingKey(k), false, `${k} 不应判为凭据`)
  }
})

test('P1-3 出口掩码:凭据替换为 ***,空串与非凭据保持原值', () => {
  const masked = maskSecretSettings({
    'daq.mqtt.password': 'runtime-value',
    'daq.mqtt.username': 'user1',
    'memory.embed_api_key': '',
    'server.prod.port': 3000,
  })
  assert.equal(masked['daq.mqtt.password'], SECRET_MASK)
  assert.equal(masked['daq.mqtt.username'], 'user1')
  assert.equal(masked['memory.embed_api_key'], '')
  assert.equal(masked['server.prod.port'], 3000)
})

test('P1-3 入口 strip:回传 *** 不覆盖真实值,其他键正常透传', () => {
  const { clean, skipped } = stripMaskedSettings({
    'daq.mqtt.password': SECRET_MASK,
    'daq.timescale.host': '10.0.0.5',
  })
  assert.deepEqual(skipped, ['daq.mqtt.password'])
  assert.equal('daq.mqtt.password' in clean, false)
  assert.equal(clean['daq.timescale.host'], '10.0.0.5')
})

test('P1-3 快照与写回路径都接入掩码(不得只改一处)', () => {
  assert.match(read('server/services/system-config/snapshot.ts'), /maskSecretSettings\(this\.effective\)/)
  const mutate = read('server/services/system-config/mutate.ts')
  assert.match(mutate, /stripMaskedSettings\(patch\)/, 'PATCH 入口必须剔除掩码回传')
  assert.match(mutate, /maskSecretSettings\(this\.effective\)/, '写回响应/广播必须掩码')
})

// ═══════════════ P2-1 ingest token 常量时间 ═══════════════

const { ingestAuthMode } = await import('../server/services/workshop/daq/ingest-policy')

test('P2-1 行为不变:配置 token 时匹配/不匹配/空值', () => {
  assert.equal(ingestAuthMode({ configuredToken: 'abc123', providedToken: 'abc123' }), 'token')
  assert.equal(ingestAuthMode({ configuredToken: 'abc123', providedToken: 'abc124' }), 'token-mismatch')
  assert.equal(ingestAuthMode({ configuredToken: 'abc123', providedToken: '' }), 'token-mismatch')
  assert.equal(ingestAuthMode({ configuredToken: 'abc123' }), 'token-mismatch', '缺头必须拒绝')
  assert.equal(ingestAuthMode({}), 'session', '未配置 token 时回落会话授权')
})

test('P2-1 实现:使用 timingSafeEqual,不得保留 === 比较', () => {
  const src = read('server/services/workshop/daq/ingest-policy.ts')
  assert.match(src, /timingSafeEqual/)
  assert.ok(!src.includes('input.providedToken === input.configuredToken'), '不得保留非常量时间比较')
})

// ═══════════════ P2-11 bench 双 env 保险丝 ═══════════════

const { benchModeEnabled } = await import('../server/services/workshop/bench-mode')

test('P2-11 单 AW_BENCH_MODE=1 不生效;双 env 才生效', () => {
  process.env.AW_BENCH_MODE = '1'
  delete process.env.AW_BENCH_ACK
  assert.equal(benchModeEnabled(), false, '单 env 必须保持防线')
  process.env.AW_BENCH_ACK = '1'
  assert.equal(benchModeEnabled(), true, '双 env 确认后放行')
  delete process.env.AW_BENCH_MODE
  delete process.env.AW_BENCH_ACK
  assert.equal(benchModeEnabled(), false)
})

test('P2-11 全部消费点都走保险丝(不得残留裸 env 判断)', () => {
  for (const f of [
    'server/middleware/01-rate-guard.ts',
    'server/services/workshop/dcw/dcw-controller/write.ts',
    'server/services/workshop/dcw/dcw-controller/helpers.ts',
    'server/api/workshop/dcw/[id]/write.post.ts',
  ]) {
    const src = read(f)
    assert.ok(!src.includes('process.env.AW_BENCH_MODE'), `${f} 仍有裸 AW_BENCH_MODE 判断`)
    assert.match(src, /benchModeEnabled/, `${f} 未接入保险丝`)
  }
})
