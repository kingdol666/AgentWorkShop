/**
 * Agent Skills 发现/解析回归：标准 frontmatter、目录名、同名冲突、symlink/深度/大小上限，
 * 以及“扫描不执行脚本”。全部使用临时目录，不触碰用户 home、不启动服务。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSkillMarkdown, SkillValidationError } from '../server/services/workshop/skills/frontmatter'
import { buildDefaultSkillRoots, discoverSkills } from '../server/services/workshop/skills/discovery'
import type { SkillScanLimits } from '../server/services/workshop/skills/types'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'aw-skills-'))
}

function writeSkill(root: string, name: string, frontmatter: string, body = 'Use the skill.\n', extraFiles: Record<string, string> = {}): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`, 'utf8')
  for (const [rel, content] of Object.entries(extraFiles)) {
    const file = join(dir, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content, 'utf8')
  }
  return dir
}

const minimal = (name: string): string => `name: ${name}\ndescription: A test skill for ${name}`

test('parses required fields, optional metadata and allowed-tools warning', () => {
  const parsed = parseSkillMarkdown(
    `---\n${minimal('pdf-processing')}\nlicense: Apache-2.0\ncompatibility: Requires node 20\nmetadata:\n  author: test\n  version: "1.0"\nallowed-tools: Bash(git:*)\n---\n# Body\n`,
    'pdf-processing',
  )
  assert.equal(parsed.name, 'pdf-processing')
  assert.equal(parsed.description, 'A test skill for pdf-processing')
  assert.equal(parsed.license, 'Apache-2.0')
  assert.equal(parsed.compatibility, 'Requires node 20')
  assert.equal(parsed.metadata.author, 'test')
  assert.equal(parsed.body, '# Body')
  assert.match(parsed.contentHash, /^[a-f0-9]{64}$/)
  assert.ok(parsed.diagnostics.some(d => d.code === 'ALLOWED_TOOLS_INFORMATIONAL'))
})

test('rejects bad name and directory mismatch', () => {
  assert.throws(
    () => parseSkillMarkdown(`---\nname: PDF-Processing\ndescription: bad name\n---\n`, 'PDF-Processing'),
    (err: unknown) => err instanceof SkillValidationError && err.diagnostics.some(d => d.code === 'NAME_INVALID'),
  )
  assert.throws(
    () => parseSkillMarkdown(`---\nname: good-name\ndescription: mismatch\n---\n`, 'other-dir'),
    (err: unknown) => err instanceof SkillValidationError && err.diagnostics.some(d => d.code === 'NAME_DIRECTORY_MISMATCH'),
  )
  // 发现阶段允许目录名不一致（只告警），导入时会严格拒绝
  const lenient = parseSkillMarkdown(`---\nname: good-name\ndescription: mismatch\n---\n`, 'other-dir', { strictDirectory: false })
  assert.ok(lenient.diagnostics.some(d => d.code === 'NAME_DIRECTORY_MISMATCH' && d.level === 'warn'))
})

test('handles unquoted colon in description', () => {
  const parsed = parseSkillMarkdown(
    `---\nname: colon-skill\ndescription: Use this skill when: the user asks about PDFs\n---\n`,
    'colon-skill',
  )
  assert.equal(parsed.description, 'Use this skill when: the user asks about PDFs')
  assert.ok(parsed.diagnostics.some(d => d.code === 'YAML_REPAIRED'))
})

test('reports invalid or missing frontmatter', () => {
  assert.throws(
    () => parseSkillMarkdown('# no frontmatter\n', 'no-frontmatter'),
    (err: unknown) => err instanceof SkillValidationError && err.diagnostics.some(d => d.code === 'FRONTMATTER_MISSING'),
  )
  assert.throws(
    () => parseSkillMarkdown(`---\nname: broken\ndescription: [unclosed\n---\n`, 'broken'),
    (err: unknown) => err instanceof SkillValidationError && err.diagnostics.some(d => d.code === 'YAML_INVALID'),
  )
})

test('hashes exact source content', () => {
  const markdown = `---\n${minimal('hash-skill')}\n---\nbody\n`
  const first = parseSkillMarkdown(markdown, 'hash-skill')
  const second = parseSkillMarkdown(`${markdown} `, 'hash-skill')
  assert.notEqual(first.contentHash, second.contentHash)
})

test('discovers service-user agent/agents/xdg roots without using browser home', async () => {
  const root = tempRoot()
  try {
    mkdirSync(join(root, 'pkg', 'skills'), { recursive: true })
    writeSkill(join(root, 'pkg', 'skills'), 'builtin-skill', minimal('builtin-skill'))
    writeSkill(join(root, 'home', '.agent', 'skills'), 'agent-compat', minimal('agent-compat'))
    writeSkill(join(root, 'home', '.agents', 'skills'), 'agents-standard', minimal('agents-standard'))
    writeSkill(join(root, 'home', '.config', 'agents', 'skills'), 'xdg-skill', minimal('xdg-skill'))
    const roots = buildDefaultSkillRoots({ configRoot: join(root, 'cfg'), homeDir: join(root, 'home'), packageRoot: join(root, 'pkg'), env: {} })
    const records = await discoverSkills(roots)
    const names = records.map(r => r.name).sort()
    assert.deepEqual(names, ['agent-compat', 'agents-standard', 'builtin-skill', 'xdg-skill'])
    assert.equal(records.find(r => r.name === 'agent-compat')?.source, 'global')
    assert.equal(records.find(r => r.name === 'builtin-skill')?.source, 'builtin')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('records name conflict without shadowing', async () => {
  const root = tempRoot()
  try {
    const a = join(root, 'a')
    const b = join(root, 'b')
    writeSkill(a, 'same-name', minimal('same-name'))
    writeSkill(b, 'same-name', minimal('same-name'))
    const records = await discoverSkills([
      { id: 'a', path: a, source: 'global', managed: false },
      { id: 'b', path: b, source: 'configured', managed: false },
    ])
    assert.equal(records.length, 2)
    assert.ok(records.every(r => r.diagnostics.some(d => d.code === 'NAME_CONFLICT')))
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deduplicates same realpath and rejects symlink skill dir', async (t) => {
  const root = tempRoot()
  try {
    const a = join(root, 'a')
    writeSkill(a, 'real-skill', minimal('real-skill'))
    const dup = await discoverSkills([
      { id: 'a1', path: a, source: 'global', managed: false },
      { id: 'a2', path: a, source: 'configured', managed: false },
    ])
    assert.equal(dup.length, 1)

    const target = join(root, 'outside')
    writeSkill(root, 'outside', minimal('outside'))
    const link = join(a, 'linked-skill')
    try {
      symlinkSync(target, link, 'dir')
    }
    catch {
      t.skip('创建目录符号链接需要额外权限，跳过 symlink 子用例')
      return
    }
    const withLink = await discoverSkills([{ id: 'a', path: a, source: 'global', managed: false }])
    assert.ok(withLink.some(r => r.name === 'linked-skill' && r.diagnostics.some(d => d.code === 'SYMLINK_SKILL_DIR')))
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('caps file count, total bytes and depth', async () => {
  const root = tempRoot()
  try {
    writeSkill(root, 'big', minimal('big'), 'body\n', {
      'references/a.md': 'a'.repeat(40),
      'references/b.md': 'b'.repeat(40),
    })
    const limits: SkillScanLimits = { maxSkills: 10, maxFilesPerSkill: 2, maxFileBytes: 1024, maxTotalBytes: 10_000, maxDepth: 2 }
    const records = await discoverSkills([{ id: 'big', path: root, source: 'global', managed: false }], limits)
    assert.equal(records.length, 1)
    assert.ok(records[0]!.diagnostics.some(d => d.code === 'FILE_COUNT_LIMIT' || d.code === 'TOTAL_SIZE_LIMIT' || d.code === 'DEPTH_LIMIT'))
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('never executes skill scripts during discovery', async () => {
  const root = tempRoot()
  const marker = join(root, 'executed.txt')
  try {
    writeSkill(root, 'script-skill', minimal('script-skill'), 'body\n', {
      'scripts/evil.mjs': `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'executed')\n`,
    })
    await discoverSkills([{ id: 'root', path: root, source: 'global', managed: false }])
    assert.equal(existsSync(marker), false)
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})
