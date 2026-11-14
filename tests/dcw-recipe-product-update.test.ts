import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-recipe-product-update-'))
delete process.env.AW_BENCH_MODE

const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
const { getDcwNodeRepo } = await import('../server/services/workshop/dcw/dcw-node.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { DaqNode } = await import('../server/services/workshop/daq/daq-node')
const { getDaqNodeRepo } = await import('../server/services/workshop/daq/daq-node.repo')

function fixture(id: string) {
  const oldLineId = `ln-old-${id}`
  const targetLineId = `ln-target-${id}`
  const products = getDcwProductRepo()
  const recipes = getDcwRecipeRepo()
  const dcwNodes = getDcwNodeRepo()
  const daqNodes = getDaqNodeRepo()
  const oldProduct = products.create({ name: `Old product ${id}`, lineId: oldLineId })
  const targetProduct = products.create({ name: `Target product ${id}`, lineId: targetLineId })
  const targetDcwNode = new DcwNode({
    id: `dw-target-${id}`, templateRef: 'dcw-temp-sp', lineId: targetLineId,
    min: 0, max: 100,
  })
  const targetDaqNode = new DaqNode({
    id: `daq-target-${id}`, templateRef: 'daq-temp-tc', lineId: targetLineId,
  })
  dcwNodes.insert(targetDcwNode)
  daqNodes.insert(targetDaqNode)
  const recipe = recipes.create({ name: `Recipe ${id}`, productId: oldProduct.id })

  return {
    recipe,
    oldProduct,
    targetProduct,
    targetDcwNode,
    targetDaqNode,
    cleanup() {
      recipes.remove(recipe.id)
      products.remove(oldProduct.id)
      products.remove(targetProduct.id)
      dcwNodes.remove(targetDcwNode.id)
      daqNodes.remove(targetDaqNode.id)
    },
  }
}

test('update follows the selected product line and normalizes both binding sets', (t) => {
  const f = fixture('switch')
  t.after(f.cleanup)

  const updated = getDcwRecipeRepo().update(f.recipe.id, {
    productId: f.targetProduct.id,
    params: [{ nodeId: f.targetDcwNode.id, value: 50, min: 40, max: 60 }],
    daqWindows: [{ nodeId: f.targetDaqNode.id, min: 10, max: 30 }],
  })

  assert.equal(updated.productId, f.targetProduct.id)
  assert.equal(updated.lineId, f.targetProduct.lineId)
  assert.deepEqual(updated.params, [{
    nodeId: f.targetDcwNode.id,
    templateRef: f.targetDcwNode.templateRef,
    value: 50,
    min: 40,
    max: 60,
  }])
  assert.deepEqual(updated.daqWindows, [{ nodeId: f.targetDaqNode.id, min: 10, max: 30 }])
})

test('invalid target-line recipe limits reject a product switch without mutating the recipe', (t) => {
  const f = fixture('atomic')
  t.after(f.cleanup)
  const recipes = getDcwRecipeRepo()
  const before = structuredClone(f.recipe)

  assert.throws(() => recipes.update(f.recipe.id, {
    productId: f.targetProduct.id,
    params: [{ nodeId: f.targetDcwNode.id, value: 50, min: 70, max: 60 }],
  }))

  assert.deepEqual(recipes.byId(f.recipe.id), before)
})
