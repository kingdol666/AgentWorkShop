import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const { postBuildArtifacts } = await import('../cli/core/post-build.mjs')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aw-post-build-'))
  const output = join(root, '.output')
  mkdirSync(join(output, 'server', 'chunks', '_'), { recursive: true })
  mkdirSync(join(output, 'server', 'chunks', 'virtual'), { recursive: true })
  mkdirSync(join(root, '.AgentWorkShop', 'prompts'), { recursive: true })
  mkdirSync(join(root, 'shared', 'config'), { recursive: true })
  mkdirSync(join(root, 'server', 'services', 'workshop', 'aml', 'python'), { recursive: true })
  for (const p of [join(output, 'server', 'chunks', '_', 'nitro.mjs'), join(output, 'server', 'chunks', 'virtual', 'entry.mjs')]) writeFileSync(p, 'export const url = import.meta.url')
  writeFileSync(join(root, '.AgentWorkShop', 'prompts', 'host-tools.json'), '{}')
  writeFileSync(join(root, 'shared', 'config', 'schema.json'), '{}')
  writeFileSync(join(root, 'server', 'services', 'workshop', 'aml', 'python', 'requirements.txt'), '')
  return root
}

test('postBuildArtifacts copies and validates all runtime assets', () => {
  const root = fixture()
  try {
    const result = postBuildArtifacts(root)
    assert.ok(result.assets.includes('prompts'))
    assert.ok(result.assets.includes('schema.json'))
    assert.ok(result.assets.includes('aml-python'))
    assert.ok(existsSync(join(root, '.output', '.AgentWorkShop', 'prompts', 'host-tools.json')))
    assert.equal(readFileSync(join(root, '.output', '.AgentWorkShop', 'schema.json'), 'utf8'), '{}')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('postBuildArtifacts fails when required runtime assets are missing', () => {
  for (const [label, relative] of [
    ['prompts', '.AgentWorkShop/prompts'],
    ['schema', 'shared/config/schema.json'],
    ['aml-python', 'server/services/workshop/aml/python'],
  ]) {
    const root = fixture()
    try {
      rmSync(join(root, relative), { recursive: true, force: true })
      assert.throws(() => postBuildArtifacts(root), new RegExp(label))
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  }
})
