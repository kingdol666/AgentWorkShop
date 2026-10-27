/**
 * MES 运行时凭据仓单测:CRUD(不回明文)/ ref 校验 / 解析顺序 env > 仓 / 删除后断开。
 * 凭据值全部运行时随机生成(测试不写可用凭据字面量)。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-mes-secrets-'))

const { createMesSecretsRepo, getMesSecretsRepo, isValidSecretRef } = await import('../server/services/workshop/mes/mes-secrets.repo')
const { resolveMesSecret } = await import('../server/services/workshop/dcw/drivers/mes-rest')

describe('mes-secrets.repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-mes-secrets-file-'))
  const file = join(dir, 'mes-secrets.json')
  const repo = createMesSecretsRepo(file)

  after(() => rmSync(dir, { recursive: true, force: true }))

  it('set/get/list/delete:listRefs 不回 value', () => {
    const value = randomUUID()
    const entry = repo.setSecret('line1.mes', value, 'admin-1')
    assert.ok(entry.updatedAt)
    assert.equal(repo.getSecret('line1.mes'), value)
    const refs = repo.listRefs()
    assert.equal(refs.length, 1)
    assert.equal(refs[0]!.ref, 'line1.mes')
    assert.equal((refs[0] as unknown as Record<string, unknown>).value, undefined)
    assert.ok(!JSON.stringify(refs).includes(value))
    assert.equal(repo.deleteSecret('line1.mes'), true)
    assert.equal(repo.getSecret('line1.mes'), null)
    assert.equal(repo.deleteSecret('line1.mes'), false)
  })

  it('落盘后可被新实例读回(原子写 + 重启不丢)', () => {
    const value = randomUUID()
    repo.setSecret('persist.ref', value, 'admin-1')
    const reopened = createMesSecretsRepo(file)
    assert.equal(reopened.getSecret('persist.ref'), value)
  })

  it('ref 校验:拒绝空白/路径分隔符/超长', () => {
    assert.equal(isValidSecretRef('line1-mes'), true)
    assert.equal(isValidSecretRef('../etc/passwd'), false)
    assert.equal(isValidSecretRef('a b'), false)
    assert.equal(isValidSecretRef(''), false)
    assert.equal(isValidSecretRef('x'.repeat(65)), false)
    assert.throws(() => repo.setSecret('../evil', randomUUID(), 'admin'))
  })

  it('空值拒绝且不覆盖已有值', () => {
    const value = randomUUID()
    repo.setSecret('keep.me', value, 'admin')
    assert.throws(() => repo.setSecret('keep.me', '  ', 'admin'))
    assert.equal(repo.getSecret('keep.me'), value)
  })
})

describe('resolveMesSecret 解析顺序', () => {
  const ref = 'order.test'
  const envKey = `AW_MES_${ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`
  const repo = getMesSecretsRepo()

  before(() => {
    process.env.AGENTWORKSHOP_TEST = '1'
    process.env.AW_MODE = 'home'
  })

  after(() => {
    Reflect.deleteProperty(process.env, envKey)
    repo.deleteSecret(ref)
    repo.deleteSecret('repo.only')
  })

  it('env 优先于仓(运维应急覆盖)', async () => {
    const envValue = randomUUID()
    process.env[envKey] = envValue
    repo.setSecret(ref, randomUUID(), 'admin')
    assert.equal(await resolveMesSecret(ref), envValue)
  })

  it('env 缺失 → 仓回退', async () => {
    Reflect.deleteProperty(process.env, envKey)
    const repoValue = randomUUID()
    repo.setSecret(ref, repoValue, 'admin')
    assert.equal(await resolveMesSecret(ref), repoValue)
  })

  it('删除后 → null(无凭据,请求头省略)', async () => {
    repo.deleteSecret(ref)
    assert.equal(await resolveMesSecret(ref), null)
  })

  it('空 ref/未知 ref → null', async () => {
    assert.equal(await resolveMesSecret(''), null)
    assert.equal(await resolveMesSecret('no-such-ref'), null)
  })
})
