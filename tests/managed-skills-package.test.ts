/**
 * Skills 打包/文档契约：npm files + standalone .output 复制 + VitePress 双语页面。
 * 结构性检查只防“资产漏打包/文档漏入口”，不替代真实安装 smoke。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

test('built-in skills are present and included in the npm file allowlist', () => {
  const skills = readdirSync(join(ROOT, 'skills'), { withFileTypes: true }).filter(d => d.isDirectory())
  assert.ok(skills.length >= 1)
  assert.ok(existsSync(join(ROOT, 'skills', 'aw-line-onboarding', 'SKILL.md')))
  const pkg = JSON.parse(read('package.json')) as { files: string[] }
  assert.ok(pkg.files.includes('skills'), 'package.json files must include skills/')
})

test('standalone post-build ships skills and requires them for cache reuse', () => {
  const src = read('cli/core/post-build.mjs')
  assert.match(src, /ship\(join\(root, 'skills'\), join\(outputRoot, 'skills'\), 'skills'/)
  assert.match(src, /existsSync\(join\(root, '\.output', 'skills'\)\)/)
})

test('bilingual AgentPrefab guide and sidebar entries exist', () => {
  assert.ok(existsSync(join(ROOT, 'docs/site/guide/agent-prefabs.md')))
  assert.ok(existsSync(join(ROOT, 'docs/site/en/guide/agent-prefabs.md')))
  const config = read('docs/site/.vitepress/config.mts')
  assert.match(config, /\/guide\/agent-prefabs/)
  assert.match(config, /\/en\/guide\/agent-prefabs/)
  const zh = read('docs/site/guide/agent-prefabs.md')
  const en = read('docs/site/en/guide/agent-prefabs.md')
  assert.match(zh, /shared-safe/)
  assert.match(en, /shared-safe/)
  assert.match(zh, /不可变|revision/)
  assert.match(en, /immutable|revision/)
})
