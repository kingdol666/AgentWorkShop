/**
 * 模拟器归属证明(nonce 绑定)契约测试 —— scripts/onboarding/lib.mjs。
 * 链条:nonce 由拉起方注入 → 模拟器 /api/attestation 出示 → bundle 落盘 →
 * assertOnboardingOwnership 当场复核(nonce/环回/pid/端点绑定)。
 * 任何一环不成立都必须拒绝,且未证明时不发任何平台 API 请求。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { assertOnboardingOwnership, assertDriverEndpointsAttested, newAttestationNonce, ATTESTATION_REJECTION } = await import('../scripts/onboarding/lib.mjs')

async function withBundle(t, bundle, handler) {
  const sim = createServer((req, res) => {
    if (req.url === '/api/attestation') {
      handler(res)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => sim.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => sim.close(resolve)))
  const dir = await mkdtemp(join(tmpdir(), 'aw-attest-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // simBase 必须指向真实监听地址(端口是临时端口),bundle 在 listen 后落盘
  const bundlePath = join(dir, 'attestation.json')
  await writeFile(bundlePath, JSON.stringify({ ...bundle, simBase: `http://127.0.0.1:${sim.address().port}` }))
  return bundlePath
}

test('nonce 链成立 + 端点绑定在证明端口集内 → 通过并返回 bundle', async (t) => {
  const nonce = newAttestationNonce()
  const bundle = { version: 1, nonce, simBase: 'http://127.0.0.1:1', simPort: 4058, brokerPort: 48000, pid: process.pid, endpoints: [{ kind: 'modbus-tcp', port: 4502 }] }
  const bundlePath = await withBundle(t, bundle, (res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, data: { nonce, pid: process.pid } }))
  })
  process.env.AW_ONBOARD_ATTESTATION = bundlePath
  t.after(() => {
    delete process.env.AW_ONBOARD_ATTESTATION
  })
  const out = await assertOnboardingOwnership()
  assert.equal(out.nonce, nonce)
  // 端点绑定:证明端口集内的 modbus 端点可证明
  assertDriverEndpointsAttested({ host: '127.0.0.1', port: 4502, unitId: 1 }, '节点 n1')
})

test('端口上的进程无法出示 nonce(抢占者/旧实例)→ 拒绝', async (t) => {
  const nonce = newAttestationNonce()
  const bundle = { version: 1, nonce, simBase: 'http://127.0.0.1:1', simPort: 4058, pid: process.pid, endpoints: [] }
  const bundlePath = await withBundle(t, bundle, (res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, data: { nonce: 'attacker-guessed-wrong', pid: process.pid } }))
  })
  process.env.AW_ONBOARD_ATTESTATION = bundlePath
  t.after(() => {
    delete process.env.AW_ONBOARD_ATTESTATION
  })
  await assert.rejects(() => assertOnboardingOwnership(), /无法证明驱动实现及其端点属于本次隔离模拟器/)
})

test('未注入 AW_ONBOARD_ATTESTATION → 不发任何请求直接拒绝(原始口径)', async () => {
  delete process.env.AW_ONBOARD_ATTESTATION
  await assert.rejects(() => assertOnboardingOwnership(), new RegExp(ATTESTATION_REJECTION.slice(0, 30)))
})

test('simBase 非环回 → 拒绝(不发起请求)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'aw-attest-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bundlePath = join(dir, 'attestation.json')
  await writeFile(bundlePath, JSON.stringify({ version: 1, nonce: 'x', simBase: 'http://10.1.2.3:4058', simPort: 4058, pid: process.pid, endpoints: [] }))
  process.env.AW_ONBOARD_ATTESTATION = bundlePath
  t.after(() => {
    delete process.env.AW_ONBOARD_ATTESTATION
  })
  await assert.rejects(() => assertOnboardingOwnership(), /环回/)
})

test('host 无绑定端口 → 端点不可证明(modbus 只配 host 不放行)', async (t) => {
  const nonce = newAttestationNonce()
  const bundle = { version: 1, nonce, simBase: 'http://127.0.0.1:1', simPort: 4058, pid: process.pid, endpoints: [{ kind: 'modbus-tcp', port: 4502 }] }
  const bundlePath = await withBundle(t, bundle, (res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, data: { nonce, pid: process.pid } }))
  })
  process.env.AW_ONBOARD_ATTESTATION = bundlePath
  t.after(() => {
    delete process.env.AW_ONBOARD_ATTESTATION
  })
  await assertOnboardingOwnership()
  assert.throws(() => assertDriverEndpointsAttested({ host: '127.0.0.1' }, '节点 n1'), /不可证明/)
})

test('端口不在证明集内 / 非环回 host → 拒绝', async (t) => {
  const nonce = newAttestationNonce()
  const bundle = { version: 1, nonce, simBase: 'http://127.0.0.1:1', simPort: 4058, pid: process.pid, endpoints: [{ kind: 'modbus-tcp', port: 4502 }] }
  const bundlePath = await withBundle(t, bundle, (res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, data: { nonce, pid: process.pid } }))
  })
  process.env.AW_ONBOARD_ATTESTATION = bundlePath
  t.after(() => {
    delete process.env.AW_ONBOARD_ATTESTATION
  })
  await assertOnboardingOwnership()
  assert.throws(() => assertDriverEndpointsAttested({ host: '127.0.0.1', port: 502 }, '节点 n1'), /不在归属证明的端口集内/)
  // 任何拒绝都会使端口集失效(fail-closed):重建证明后再测非环回 host
  await assertOnboardingOwnership()
  assert.throws(() => assertDriverEndpointsAttested({ host: '192.168.1.50', port: 4502 }, '节点 n2'), /非环回地址/)
})
