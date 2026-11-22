import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const { postBuildArtifacts, outputAssetsReady } = await import('../cli/core/post-build.mjs')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aw-post-build-'))
  const output = join(root, '.output')
  mkdirSync(join(output, 'server', 'chunks', '_'), { recursive: true })
  mkdirSync(join(output, 'server', 'chunks', 'virtual'), { recursive: true })
  mkdirSync(join(root, '.AgentWorkShop', 'prompts'), { recursive: true })
  mkdirSync(join(root, 'shared', 'config'), { recursive: true })
  mkdirSync(join(root, 'server', 'services', 'workshop', 'aml', 'python'), { recursive: true })
  mkdirSync(join(root, 'server', 'services', 'workshop', 'optimization', 'python'), { recursive: true })
  for (const name of ['worker.py', 'problems.py', 'probe.py']) {
    writeFileSync(join(root, 'server', 'services', 'workshop', 'optimization', 'python', name), `# ${name}`)
  }
  mkdirSync(join(root, 'skills', 'demo-skill'), { recursive: true })
  writeFileSync(join(root, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\n')
  mkdirSync(join(root, 'node_modules', 'zod'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'zod', 'index.js'), 'export const version = "direct-zod"')
  mkdirSync(join(output, 'server', 'node_modules', 'zod'), { recursive: true })
  writeFileSync(join(output, 'server', 'node_modules', 'zod', 'index.js'), 'export const version = "transitive-zod"')
  for (const p of [join(output, 'server', 'chunks', '_', 'nitro.mjs'), join(output, 'server', 'chunks', 'virtual', 'entry.mjs')]) writeFileSync(p, 'export const url = import.meta.url')
  writeFileSync(join(root, '.AgentWorkShop', 'prompts', 'host-tools.json'), '{}')
  writeFileSync(join(root, 'shared', 'config', 'schema.json'), '{}')
  for (const name of ['amlkit.py', 'aml_eval.py', 'requirements.txt', 'train-example.py', 'train-hybrid-example.py']) {
    writeFileSync(join(root, 'server', 'services', 'workshop', 'aml', 'python', name), '')
  }
  return root
}

test('postBuildArtifacts copies and validates all runtime assets', () => {
  const root = fixture()
  try {
    const result = postBuildArtifacts(root)
    assert.ok(result.assets.includes('prompts'))
    assert.ok(result.assets.includes('schema.json'))
    assert.ok(result.assets.includes('aml-python'))
    assert.ok(result.assets.includes('optimizer-python'))
    assert.ok(result.assets.includes('skills'))
    assert.ok(existsSync(join(root, '.output', '.AgentWorkShop', 'optimizer-python', 'worker.py')))
    assert.ok(existsSync(join(root, '.output', 'skills', 'demo-skill', 'SKILL.md')))
    assert.ok(result.assets.includes('zod-direct'))
    assert.match(readFileSync(join(root, '.output', 'server', 'node_modules', 'zod', 'index.js'), 'utf8'), /direct-zod/)
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
    ['optimizer-python', 'server/services/workshop/optimization/python'],
    ['skills', 'skills'],
  ]) {
    const root = fixture()
    try {
      rmSync(join(root, relative), { recursive: true, force: true })
      assert.throws(() => postBuildArtifacts(root), new RegExp(label))
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('outputAssetsReady requires the server entry plus every runtime asset', () => {
  const root = fixture()
  try {
    writeFileSync(join(root, '.output', 'server', 'index.mjs'), '')
    // 入口存在但资产尚未随产物分发 → 不可启动(旧实现只看 index.mjs 会误判就绪)
    assert.equal(outputAssetsReady(root), false)
    postBuildArtifacts(root)
    assert.equal(outputAssetsReady(root), true)
    rmSync(join(root, '.output', '.AgentWorkShop', 'optimizer-python', 'probe.py'))
    assert.equal(outputAssetsReady(root), false, 'a missing worker file must invalidate the build')
    postBuildArtifacts(root)
    assert.equal(outputAssetsReady(root), true)
    rmSync(join(root, '.output', '.AgentWorkShop', 'aml-python', 'aml_eval.py'))
    assert.equal(outputAssetsReady(root), false, 'a missing evaluator must invalidate the build')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
