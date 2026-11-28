/**
 * 批次 C：本体产品域隔离（M7）。
 * - product_id='' = 产线通用；产品版本不隐式继承产线版本；
 * - latestPublishedForLine(line,'') 不取产品版；产品解析不回退 line；
 * - publishSnapshot 持久化 product_id。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-ont-product-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { getOntologyRepo } = await import('../server/services/workshop/ontology/repo')
const { emptyDraftDoc, parseDraftDoc, ONTOLOGY_SCHEMA_VERSION } = await import('../server/services/workshop/ontology/contracts')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'ontology-product.sqlite'))
configureAmlRuntime(db)
const repo = getOntologyRepo()

function publish(version: number, lineId: string, productId: string) {
  repo.publishSnapshot({
    version: {
      id: 'ont-p1', version, name: 'P1 本体', lineId, productId,
      parentVersion: null, contentHash: `hash-${version}`, compiledJson: '{}', changelogJson: '{}',
      status: 'published', ownerUserId: 'u1', publishedBy: 'u1',
      createdAt: '', updatedAt: '',
    },
    entities: [], relations: [], rules: [], bindings: [], traces: [], guards: [],
    createdBy: 'u1',
  })
}

test('product-scoped versions are isolated and never fall back to line-wide', () => {
  publish(1, 'L1', '')
  publish(2, 'L1', 'P1')
  publish(3, 'L1', 'P2')

  assert.equal(repo.latestPublishedForLine('L1')?.version, 1, '产线通用解析不得取产品版本')
  assert.equal(repo.latestPublishedForLine('L1', 'P1')?.productId, 'P1')
  assert.equal(repo.latestPublishedForLine('L1', 'P1')?.version, 2)
  assert.equal(repo.latestPublishedForLine('L1', 'P2')?.version, 3)
  assert.equal(repo.latestPublishedForLine('L1', 'P3'), undefined, '产品无版本不得回退到产线版本')

  const list = repo.listAllOntologyIds('L1')
  assert.equal(list.length, 1)
  assert.equal(list[0]!.productId, 'P2', '清单按最新版本归属展示')
  const scoped = repo.listAllOntologyIds('L1', 'P1')
  assert.equal(scoped[0]!.productId, 'P1')
})

test('draft schema carries productId (empty = line-wide)', () => {
  const doc = emptyDraftDoc('ont-p1', 'L1')
  assert.equal(doc.productId, '')
  const scoped = emptyDraftDoc('ont-p1', 'L1', 'P1')
  assert.equal(scoped.productId, 'P1')
  const parsed = parseDraftDoc({ schemaVersion: ONTOLOGY_SCHEMA_VERSION, name: 'x', lineId: 'L1', productId: 'P9' })
  assert.equal(parsed.productId, 'P9')
  const legacy = parseDraftDoc({ schemaVersion: ONTOLOGY_SCHEMA_VERSION, name: 'x', lineId: 'L1' })
  assert.equal(legacy.productId, '', '旧文档缺省 = 产线通用')
})
