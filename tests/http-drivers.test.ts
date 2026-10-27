/**
 * F4 HTTP 驱动增强单测(本地随机端口 node:http,绝不触真实设备):
 *  - DAQ:GET 向后兼容 / POST 模板 / 凭据头插值 / 认证头 / SSRF / 协议白名单
 *  - DCW:POST 写入 + 回读三态 / test 只 GET / 凭据头 / SSRF
 *  - 超时钳位纯函数
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-http-drivers-'))

const { httpDaqDriver } = await import('../server/services/workshop/daq/drivers/http')
const { httpDcwDriver } = await import('../server/services/workshop/dcw/drivers/http')
const { getMesSecretsRepo } = await import('../server/services/workshop/mes/mes-secrets.repo')
const { clampTimeoutMs } = await import('../server/services/workshop/net/secret-auth')

let server: Server
let base = ''
const seen: Array<{ method: string, url: string, headers: Record<string, string | string[] | undefined>, body: string }> = []
const SECRET_REF = 'http-driver-test'
const SECRET_VALUE = randomUUID()

before(async () => {
  getMesSecretsRepo().setSecret(SECRET_REF, SECRET_VALUE, 'test')
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw })
      const url = new URL(req.url ?? '/', 'http://mock')
      if (url.pathname === '/scalar') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: { value: 42.5 } }))
        return
      }
      if (url.pathname === '/write') {
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ setpoint: body.setpoint ?? body.value }))
        return
      }
      if (url.pathname === '/write-zero') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ value: 0 }))
        return
      }
      res.writeHead(404).end('nope')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  getMesSecretsRepo().deleteSecret(SECRET_REF)
})

test('DAQ GET 向后兼容:旧配置(url+jsonPath)行为不变', async () => {
  seen.length = 0
  const v = await httpDaqDriver.sample({ driverConfig: { url: `${base}/scalar`, jsonPath: 'data.value', allowPrivateHost: 'true' }, signalKind: 'scalar' })
  assert.equal(v, 42.5)
  assert.equal(seen[0]!.method, 'GET')
  assert.equal(seen[0]!.body, '')
})

test('DAQ POST:bodyTemplate + {{SECRET:REF}} 头插值 + bearer 认证', async () => {
  seen.length = 0
  const v = await httpDaqDriver.sample({
    driverConfig: {
      url: `${base}/scalar`,
      method: 'POST',
      jsonPath: 'data.value',
      bodyTemplate: JSON.stringify({ query: 'temp', token: '{{SECRET:http-driver-test}}' }),
      headersJSON: JSON.stringify({ 'X-API-Token': '{{SECRET:http-driver-test}}', 'X-Plain': 'v' }),
      authType: 'bearer',
      secretRef: SECRET_REF,
      allowPrivateHost: 'true',
    },
    signalKind: 'scalar',
  })
  assert.equal(v, 42.5)
  assert.equal(seen[0]!.method, 'POST')
  assert.equal(seen[0]!.headers['x-api-token'], SECRET_VALUE)
  assert.equal(seen[0]!.headers.authorization, `Bearer ${SECRET_VALUE}`)
  assert.equal(seen[0]!.headers['x-plain'], 'v')
  assert.deepEqual(JSON.parse(seen[0]!.body), { query: 'temp', token: SECRET_VALUE })
})

test('DAQ 未解析的 {{SECRET:}} 头整条省略,不把占位符发出去', async () => {
  seen.length = 0
  await httpDaqDriver.sample({
    driverConfig: {
      url: `${base}/scalar`,
      jsonPath: 'data.value',
      headersJSON: JSON.stringify({ 'X-Doomed': '{{SECRET:no-such-ref}}', 'X-Ok': 'yes' }),
      allowPrivateHost: 'true',
    },
    signalKind: 'scalar',
  })
  assert.equal(seen[0]!.headers['x-doomed'], undefined)
  assert.equal(seen[0]!.headers['x-ok'], 'yes')
})

test('DAQ SSRF:旧配置(无 allowPrivateHost)保持历史行为;显式 false 拒绝,true 放行', async () => {
  // 存量配置没有该字段 → 不因升级中断采样(向后兼容)
  const legacy = await httpDaqDriver.sample({ driverConfig: { url: `${base}/scalar`, jsonPath: 'data.value' }, signalKind: 'scalar' })
  assert.equal(legacy, 42.5)
  await assert.rejects(
    () => httpDaqDriver.sample({ driverConfig: { url: `${base}/scalar`, jsonPath: 'data.value', allowPrivateHost: 'false' }, signalKind: 'scalar' }),
    (e: unknown) => /内网\/环回|SSRF/.test((e as Error).message),
  )
  await httpDaqDriver.sample({ driverConfig: { url: `${base}/scalar`, jsonPath: 'data.value', allowPrivateHost: 'true' }, signalKind: 'scalar' })
})

test('DAQ 协议白名单:ftp:// 拒绝', async () => {
  await assert.rejects(
    () => httpDaqDriver.sample({ driverConfig: { url: 'ftp://127.0.0.1/x', allowPrivateHost: 'true' }, signalKind: 'scalar' }),
    (e: unknown) => /http\/https/.test((e as Error).message),
  )
})

test('DCW 写入:bodyKey + secret 头 + 回读书面值', async () => {
  seen.length = 0
  const r = await httpDcwDriver.write({
    eng: 12.5,
    tolerance: 0.01,
    driverConfig: {
      url: `${base}/write`,
      bodyKey: 'setpoint',
      headersJSON: JSON.stringify({ 'X-API-Token': '{{SECRET:http-driver-test}}' }),
      allowPrivateHost: 'true',
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.ack, 'readback-verified')
  assert.equal(r.readback, 12.5)
  assert.equal(seen[0]!.headers['x-api-token'], SECRET_VALUE)
  assert.deepEqual(JSON.parse(seen[0]!.body), { setpoint: 12.5 })
})

test('DCW 回读不一致 → 不得报设备证实(ok=false)', async () => {
  const r = await httpDcwDriver.write({
    eng: 42,
    tolerance: 0.5,
    driverConfig: { url: `${base}/write-zero`, allowPrivateHost: 'true' },
  })
  assert.equal(r.ok, false)
  assert.equal(r.ack, 'unverified')
  assert.match(r.message, /回读不一致|回读偏差/)
})

test('DCW test 仅 GET 探测,不触发 POST 写入', async () => {
  seen.length = 0
  const r = await httpDcwDriver.test({ url: `${base}/scalar`, allowPrivateHost: 'true' })
  assert.equal(r.ok, true)
  assert.equal(seen[0]!.method, 'GET')
})

test('DCW SSRF:显式 false 拒绝环回;旧配置(无字段)保持历史行为', async () => {
  await assert.rejects(
    () => httpDcwDriver.write({ eng: 1, tolerance: 0.1, driverConfig: { url: `${base}/write`, allowPrivateHost: 'false' } }),
    (e: unknown) => /内网\/环回|SSRF/.test((e as Error).message),
  )
  const legacy = await httpDcwDriver.write({ eng: 1, tolerance: 0.1, driverConfig: { url: `${base}/write` } })
  assert.equal(legacy.ok, true)
})

test('超时钳位:1s–60s,非法值回落缺省', () => {
  assert.equal(clampTimeoutMs(undefined, 5000), 5000)
  assert.equal(clampTimeoutMs(0, 5000), 5000)
  assert.equal(clampTimeoutMs('abc', 5000), 5000)
  assert.equal(clampTimeoutMs(10, 5000), 1000)
  assert.equal(clampTimeoutMs(999_999, 5000), 60_000)
  assert.equal(clampTimeoutMs(7500, 5000), 7500)
})
