/**
 * B0 止血批验收(2026-10-30 安全审计 P0-1 / P0-2 / P0-5)。
 *
 * 单测环境无法加载走 `#imports` 的路由处理器(仓库既有约定:见
 * tests/ontology-tools-surface.test.ts 头注释),因此本文件采用双轨:
 *  - **结构断言**:路由源码必须调用 owner 守卫且顺序在写操作之前(防删除回归);
 *  - **行为断言**:限流中间件对伪造 X-Forwarded-For 的真实反应(直接调用中间件);
 *  - **卫生断言**:compose/config 无凭据字面量、端口只绑回环。
 * 真实 HTTP 403/429 矩阵见 scripts/e2e-security-b0.mjs。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = join(process.env.TEMP ?? '/tmp', `aw-b0-${process.pid}`)
delete process.env.AW_BENCH_MODE
delete process.env.AW_RATE_LIMIT_OFF

const REPO = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(REPO, p), 'utf8')

const { clientIp, trustProxyEnabled } = await import('../server/utils/request-ip')
const { default: rateGuard } = await import('../server/middleware/01-rate-guard')

// ════════════════════ P0-1:孪生配置 PATCH 必须 owner-only ════════════════════

test('P0-1 twin-profile PATCH 调用 requireChannelOwner,且在处理任何写之前', () => {
  const src = read('server/api/workshop/channels/[id]/twin-profile.patch.ts')
  const guard = src.indexOf('requireChannelOwner(')
  const write = src.indexOf('setHybridChannelProfile(')
  assert.ok(guard > 0, '缺少 requireChannelOwner 守卫 —— 任意注册用户可改他人治理档位(绕 HITL)')
  assert.ok(write > 0, '未找到 setHybridChannelProfile 写入点')
  assert.ok(guard < write, '守卫必须在写入之前执行(否则越权请求已先落库)')
  assert.match(src, /requireChannelOwner\(\s*id\s*,\s*user\s*,\s*'channel'\s*\)/, '守卫参数须为 (channelId, user, \'channel\')')
  assert.ok(!/getRequestIP/.test(src), '不应自行解析客户端 IP')
})

test('P0-1 同族频道管理端点守卫一致(index.patch / execution-mode.patch)', () => {
  for (const f of ['server/api/workshop/channels/[id]/index.patch.ts', 'server/api/workshop/channels/[id]/execution-mode.patch.ts']) {
    assert.match(read(f), /requireChannelOwner\(/, `${f} 应有属主守卫(同族一致性)`)
  }
})

test('P0-1 治理档位/模型绑定变更写入审计轨(recordOps)', () => {
  const src = read('server/api/workshop/channels/[id]/twin-profile.patch.ts')
  assert.match(src, /recordOps\(/, 'controlPolicy / boundModelId 变更必须留审计(MES 治理同口径)')
  assert.match(src, /channel\.twin_profile/)
})

// ════════════════════ P0-2:X-Forwarded-For 默认不采信 ════════════════════

function ipEvent(socket: string, xff?: string) {
  const headers = new Headers()
  if (xff) headers.set('x-forwarded-for', xff)
  return { req: Object.assign(new Request('http://127.0.0.1/api/x', { headers }), { context: { clientAddress: socket } }) } as never
}

test('P0-2 默认(AW_TRUST_PROXY 未设):伪造 XFF 被忽略,取 socket 地址', () => {
  delete process.env.AW_TRUST_PROXY
  assert.equal(trustProxyEnabled(), false)
  assert.equal(clientIp(ipEvent('10.0.0.9', '203.0.113.7')), '10.0.0.9')
  assert.equal(clientIp(ipEvent('10.0.0.9')), '10.0.0.9')
})

test('P0-2 AW_TRUST_PROXY=1(反代场景):按首跳 XFF 取真实 IP', () => {
  process.env.AW_TRUST_PROXY = '1'
  try {
    assert.equal(trustProxyEnabled(), true)
    assert.equal(clientIp(ipEvent('10.0.0.9', '203.0.113.7, 10.0.0.9')), '203.0.113.7')
  }
  finally {
    delete process.env.AW_TRUST_PROXY
  }
})

test('P0-2 登录与限流两处 IP 消费点统一走 clientIp(不得再出现 xForwardedFor 选项)', () => {
  for (const f of ['server/api/users/login.post.ts', 'server/middleware/01-rate-guard.ts']) {
    const src = read(f)
    assert.match(src, /clientIp\(/, `${f} 必须使用 clientIp()`)
    assert.ok(!/xForwardedFor/.test(src), `${f} 不得直接开启 xForwardedFor`)
  }
})

// 行为断言:限流中间件在默认模式下按 socket 地址分桶
function callRate(path = '/api/users/login'): { status: number } {
  const g = globalThis as { __awRateBuckets?: Map<string, unknown> }
  const url = `http://127.0.0.1${path}`
  const headers = new Headers({ 'user-agent': 'node-test' })
  const event = {
    req: Object.assign(new Request(url, { method: 'POST', headers }), { context: { clientAddress: '198.51.100.5' } }),
    res: { status: 200, statusText: '', headers: new Headers(), once: () => {} },
    context: {},
    url: new URL(url),
    node: { req: { method: 'POST' }, res: { statusCode: 200, once: () => {} } },
  }
  try {
    ;(rateGuard as unknown as (e: unknown) => void)(event)
    return { status: 200 }
  }
  catch (err) {
    void g
    return { status: (err as { statusCode?: number }).statusCode ?? 0 }
  }
}

test('P0-2 行为:同 socket 地址第 21 次认证面请求 → 429(伪造 XFF 无法换桶)', () => {
  const g = globalThis as { __awRateBuckets?: Map<string, unknown>, __awScanHits?: Map<string, unknown>, __awScanBlocked?: Map<string, unknown> }
  g.__awRateBuckets = new Map()
  g.__awScanHits = new Map()
  g.__awScanBlocked = new Map()
  for (let i = 0; i < 20; i++) assert.equal(callRate().status, 200, `第 ${i + 1} 次不应限流`)
  assert.equal(callRate().status, 429, '第 21 次必须限流(与是否携带 XFF 无关)')
})

// ════════════════════ P0-5:基础设施默认凭据与全网卡绑定 ════════════════════

test('P0-5 docker-compose:三个端口只绑 127.0.0.1,凭据来自环境变量', () => {
  const src = read('docker-compose.yml')
  for (const port of ['5432', '9000']) {
    assert.match(src, new RegExp(`"127\\.0\\.0\\.1:${port}:${port}"`), `${port} 必须只绑回环`)
    assert.ok(!new RegExp(`"${port}:${port}"`).test(src), `${port} 不得裸绑 0.0.0.0`)
  }
  assert.ok(!/"9001:9001"/.test(src), '9001 控制台不得默认 publish(调试用 docker-compose.debug.yml)')
  assert.match(read('docker-compose.debug.yml'), /"127\.0\.0\.1:9001:9001"/, '调试覆盖文件必须也绑回环')
  assert.match(src, /POSTGRES_PASSWORD: \$\{AW_DAQ_TIMESCALE_PASSWORD:\?/, 'Timescale 口令必须由环境变量强注入')
  assert.match(src, /MINIO_ROOT_PASSWORD: \$\{AW_DAQ_OBJECTSTORE_SECRETKEY:\?/, 'MinIO 密钥必须由环境变量强注入')
})

test('P0-5 仓库不再包含基础设施默认凭据字面量', () => {
  for (const f of ['docker-compose.yml', 'config.yml', 'docker-compose.debug.yml']) {
    const src = read(f)
    for (const lit of ['awshop-secret', 'POSTGRES_PASSWORD: awshop', 'MINIO_ROOT_PASSWORD: awshop']) {
      assert.ok(!src.includes(lit), `${f} 仍含默认凭据字面量:${lit}`)
    }
  }
  // config.yml 的 daq 凭据键必须留空(由 env / 本机凭据文件填充)
  const cfg = read('config.yml')
  assert.match(cfg, /password:\s*""/, 'config.yml daq.timescale.password 应留空')
  assert.match(cfg, /secretKey:\s*""/, 'config.yml daq.objectstore.secretKey 应留空')
})

test('P0-5 凭据引导:源码不写死凭据值,env 名由配置键派生', () => {
  const src = read('server/services/workshop/daq/infra-credentials.ts')
  assert.match(src, /randomBytes\(/, '随机凭据必须来自 crypto.randomBytes')
  assert.match(src, /adoptFromRunningContainers/, '存量部署需从运行中容器自省,避免升级断连')
  assert.match(src, /envNameOf/, 'env 名应由配置键派生,避免各处重复字面量')
  assert.ok(!/["']awshop["']\s*[,}]/.test(src), '不得回落到固定凭据值')
})
