/**
 * EDA 图表配置模板 repo 单测 —— CRUD/owner 隔离/校验/图型白名单。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-eda-tpl-test-'))

const { createTemplate, listTemplates, templateById, updateTemplate, deleteTemplate } = await import('../server/services/workshop/eda/template-repo')

const admin = { id: 'u-admin', name: '管理员', role: 'admin' } as never
const alice = { id: 'u-alice', name: 'Alice', role: 'user' } as never
const bob = { id: 'u-bob', name: 'Bob', role: 'user' } as never

test('创建模板:合法/空名/非法图型', async () => {
  const tp = createTemplate(alice, { name: '克重趋势', description: 'line · x=at', chartType: 'line', config: { xField: 'at', yFields: ['克重'], agg: 'avg' } })
  assert.match(tp.id, /^et-/)
  assert.equal(tp.chartType, 'line')
  assert.equal((tp.config as { yFields: string[] }).yFields[0], '克重')
  assert.throws(() => createTemplate(alice, { name: '', chartType: 'line', config: {} }), /模板名必填/)
  assert.throws(() => createTemplate(alice, { name: 'x', chartType: 'hologram', config: {} }), /不支持的图型/)
})

test('列表 owner 隔离:Bob 看不到 Alice 的,admin 全见', async () => {
  createTemplate(bob, { name: 'Bob 模板', chartType: 'bar', config: {} })
  const aliceList = listTemplates(alice)
  assert.equal(aliceList.length, 1)
  assert.equal(aliceList[0].name, '克重趋势')
  assert.equal(listTemplates(bob).length, 1)
  assert.equal(listTemplates(admin).length, 2)
})

test('跨 owner 读取被拒(非 admin)', async () => {
  const aliceId = listTemplates(alice)[0].id
  assert.throws(() => templateById(bob, aliceId), /仅 owner 或管理员/)
  assert.equal(templateById(admin, aliceId)?.id, aliceId)
})

test('更新:owner 可改,字段与 config 落库', async () => {
  const aliceId = listTemplates(alice)[0].id
  const updated = updateTemplate(alice, aliceId, { description: '改过', config: { xField: 'at', yFields: ['克重', '飞边率'], agg: 'max' } })
  assert.equal(updated.description, '改过')
  assert.equal((updated.config as { agg: string }).agg, 'max')
  assert.throws(() => updateTemplate(bob, aliceId, { name: '抢' }), /仅 owner 或管理员/)
  assert.throws(() => updateTemplate(alice, 'et-nothing', { name: 'x' }), /模板不存在/)
})

test('删除:owner 可删,admin 可删他人,删后不可读', async () => {
  const bobId = listTemplates(bob)[0].id
  deleteTemplate(bob, bobId)
  assert.equal(templateById(bob, bobId), undefined)
  const aliceId = listTemplates(alice)[0].id
  deleteTemplate(admin, aliceId)
  assert.equal(listTemplates(alice).length, 0)
  assert.throws(() => deleteTemplate(alice, 'et-nothing'), /模板不存在/)
})
