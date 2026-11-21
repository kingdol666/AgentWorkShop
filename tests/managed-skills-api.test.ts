/**
 * 受管 Skill 存储回归：不可变导入、源变更拒绝、symlink/穿越/超限拒绝、
 * 启停状态持久化、删除，以及管理路由的鉴权契约。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverSkills } from '../server/services/workshop/skills/discovery'
import { createSkillService } from '../server/services/workshop/skills/service'
import {
  findManagedRevision,
  importManagedRevision,
  listManagedRevisions,
  readManagedRevisionFile,
  removeManagedRevision,
  setManagedRevisionEnabled,
} from '../server/services/workshop/skills/store'
import type { SkillRecord, SkillScanLimits } from '../server/services/workshop/skills/types'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function workspace(): { root: string, source: string, config: string } {
  const root = mkdtempSync(join(tmpdir(), 'aw-managed-skills-'))
  return { root, source: join(root, 'source'), config: join(root, 'config') }
}

function writeSkill(root: string, name: string, body = 'Body\n', extra: Record<string, string> = {}): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Skill ${name}\n---\n${body}`, 'utf8')
  for (const [rel, content] of Object.entries(extra)) {
    const file = join(dir, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content, 'utf8')
  }
}

async function recordOf(sourceRoot: string, name: string): Promise<SkillRecord> {
  const records = await discoverSkills([{ id: 'src', path: sourceRoot, source: 'global', managed: false }])
  const record = records.find(r => r.name === name)
  assert.ok(record, `missing discovered record ${name}`)
  return record
}

test('imports a revision atomically, disabled by default, with resources', async () => {
  const w = workspace()
  try {
    writeSkill(w.source, 'pdf-processing', '# PDF\n', { 'references/REFERENCE.md': 'reference\n' })
    const record = await recordOf(w.source, 'pdf-processing')
    const result = importManagedRevision({ configRoot: w.config, record, actorId: 'admin-1' })
    assert.equal(result.existing, false)
    assert.equal(result.revision.enabled, false)
    assert.equal(result.revision.name, 'pdf-processing')
    assert.match(result.revision.revision, /^[a-f0-9]{64}$/)
    assert.equal(readManagedRevisionFile(w.config, result.revision.id, 'references/REFERENCE.md'), 'reference\n')
    assert.equal(readFileSync(join(w.config, 'skills', 'pdf-processing', result.revision.revision, 'manifest.json'), 'utf8').includes('admin-1'), true)
    const again = importManagedRevision({ configRoot: w.config, record, actorId: 'admin-1' })
    assert.equal(again.existing, true)
    assert.equal(listManagedRevisions(w.config).length, 1)
  }
  finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('rejects source changed after discovery', async () => {
  const w = workspace()
  try {
    writeSkill(w.source, 'changing')
    const record = await recordOf(w.source, 'changing')
    writeFileSync(join(w.source, 'changing', 'SKILL.md'), readFileSync(join(w.source, 'changing', 'SKILL.md'), 'utf8') + '\nchanged\n')
    assert.throws(
      () => importManagedRevision({ configRoot: w.config, record, actorId: 'admin-1' }),
      (err: { code?: string }) => err.code === 'SKILL_SOURCE_CHANGED',
    )
    assert.equal(existsSync(join(w.config, 'skills', 'changing')), false)
  }
  finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('rejects symlinks inside a skill during import', async (t) => {
  const w = workspace()
  try {
    writeSkill(w.source, 'with-link')
    const outside = join(w.root, 'outside.txt')
    writeFileSync(outside, 'outside')
    try {
      symlinkSync(outside, join(w.source, 'with-link', 'link.txt'))
    }
    catch {
      t.skip('创建符号链接需要额外权限，跳过')
      return
    }
    const record = await recordOf(w.source, 'with-link')
    assert.throws(
      () => importManagedRevision({ configRoot: w.config, record, actorId: 'admin-1' }),
      (err: { code?: string }) => err.code === 'SKILL_SYMLINK_REJECTED',
    )
    assert.equal(existsSync(join(w.config, 'skills', 'with-link')), false)
    // 失败导入不留下 staging 半成品
    const staging = join(w.config, 'skills', '.staging')
    assert.equal(existsSync(staging) ? readdirSync(staging).length : 0, 0)
  }
  finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('enforces import size limits without leaving a revision', async () => {
  const w = workspace()
  try {
    writeSkill(w.source, 'large', 'x'.repeat(200))
    const record = await recordOf(w.source, 'large')
    const limits: SkillScanLimits = { maxSkills: 10, maxFilesPerSkill: 10, maxFileBytes: 50, maxTotalBytes: 10_000, maxDepth: 3 }
    assert.throws(
      () => importManagedRevision({ configRoot: w.config, record, actorId: 'admin-1', limits }),
      (err: { code?: string }) => err.code === 'SKILL_FILE_TOO_LARGE',
    )
    assert.equal(listManagedRevisions(w.config).length, 0)
  }
  finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('enable/disable persists and remove deletes only the managed copy', async () => {
  const w = workspace()
  try {
    writeSkill(w.source, 'toggle')
    const record = await recordOf(w.source, 'toggle')
    const imported = importManagedRevision({ configRoot: w.config, record, actorId: 'admin-1' }).revision
    assert.equal(imported.enabled, false)
    const enabled = setManagedRevisionEnabled(w.config, imported.id, true, 'admin-2')
    assert.equal(enabled.enabled, true)
    assert.equal(listManagedRevisions(w.config)[0]!.enabled, true)
    removeManagedRevision(w.config, imported.id)
    assert.equal(listManagedRevisions(w.config).length, 0)
    assert.equal(existsSync(join(w.source, 'toggle', 'SKILL.md')), true)
    assert.throws(() => findManagedRevision(w.config, imported.id), (err: { status?: number }) => err.status === 404)
  }
  finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('relative resource read rejects traversal and missing files', async () => {
  const w = workspace()
  try {
    writeSkill(w.source, 'safe-read', 'Body\n', { 'references/ok.md': 'ok\n' })
    const record = await recordOf(w.source, 'safe-read')
    const revision = importManagedRevision({ configRoot: w.config, record, actorId: 'admin-1' }).revision
    assert.equal(readManagedRevisionFile(w.config, revision.id, 'references/ok.md'), 'ok\n')
    assert.throws(
      () => readManagedRevisionFile(w.config, revision.id, '../SKILL.md'),
      (err: { code?: string }) => err.code === 'PATH_TRAVERSAL' || err.code === 'NOT_FOUND',
    )
    assert.throws(
      () => readManagedRevisionFile(w.config, revision.id, 'references/missing.md'),
      (err: { code?: string }) => err.code === 'NOT_FOUND',
    )
  }
  finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('service only imports discovered catalog IDs, never caller paths', async () => {
  const service = createSkillService({ configRoot: join(tmpdir(), `aw-skill-svc-${Date.now()}`), homeDir: join(tmpdir(), 'no-home'), packageRoot: ROOT, env: {} })
  await assert.rejects(
    () => service.importFromCatalog('../../etc/passwd', 'admin-1'),
    (err: { status?: number }) => err.status === 404,
  )
})

test('management routes require admin/editor and audit mutations', () => {
  const files = [
    'server/api/system/skills/index.get.ts',
    'server/api/system/skills/discover.get.ts',
    'server/api/system/skills/import.post.ts',
    'server/api/system/skills/[id].patch.ts',
    'server/api/system/skills/[id].delete.ts',
    'server/api/system/skills/[id]/file.get.ts',
  ]
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
  for (const file of files) {
    const src = read(file)
    assert.match(src, /requireRole\(event, \['admin'(?:, 'editor')?\]\)/, `${file} must use requireRole`)
  }
  for (const file of ['server/api/system/skills/import.post.ts', 'server/api/system/skills/[id].patch.ts', 'server/api/system/skills/[id].delete.ts']) {
    assert.match(read(file), /recordOps\(/, `${file} must audit mutations`)
  }
  assert.match(read('server/api/system/skills/import.post.ts'), /catalogId/, 'import must take catalogId, not a path')
})
