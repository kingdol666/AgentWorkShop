import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function source(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

test('settings PATCH rejects malformed override with a 400 AppError instead of HTTP 200 ok:false', () => {
  const src = source('server/api/system/settings/index.patch.ts')
  assert.match(src, /new AppError\(400, ['"]VALIDATION_ERROR['"]/, 'settings route must use the shared validation error')
  assert.doesNotMatch(src, /return \{ ok: false/, 'malformed settings must not be encoded as a successful HTTP response')
})

test('migration ledger records an ordered version and detects fingerprint drift', async () => {
  const { ensureMigrationLedger, recordMigration, assertMigrationFingerprint, currentSchemaVersion } = await import('../server/services/workshop/db/database/migration-ledger')
  const db = new DatabaseSync(':memory:')
  ensureMigrationLedger(db)
  recordMigration(db, { version: 1, name: 'baseline', fingerprint: 'abc123' })
  assert.equal(currentSchemaVersion(db), 1)
  assert.doesNotThrow(() => assertMigrationFingerprint(db, 1, 'abc123'))
  assert.throws(() => assertMigrationFingerprint(db, 1, 'different'), /fingerprint/i)
  db.close()
})

test('restore dry-run validates SQLite integrity without changing target', async () => {
  const { restoreBackup } = await import('../server/services/workshop/db/backup/restore')
  const dir = mkdtempSync(join(tmpdir(), 'aw-restore-'))
  const sourcePath = join(dir, 'source.sqlite')
  const targetPath = join(dir, 'target.sqlite')
  const sourceDb = new DatabaseSync(sourcePath)
  sourceDb.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample(value) VALUES (\'backup\')')
  sourceDb.close()
  writeFileSync(targetPath, 'existing')
  const report = await restoreBackup({ source: sourcePath, target: targetPath, dryRun: true })
  assert.equal(report.ok, true)
  assert.equal(report.applied, false)
  assert.equal(readFileSync(targetPath, 'utf8'), 'existing')
  rmSync(dir, { recursive: true, force: true })
})

test('restore refuses overwrite without explicit confirmation and rejects corrupt SQLite', async () => {
  const { restoreBackup } = await import('../server/services/workshop/db/backup/restore')
  const dir = mkdtempSync(join(tmpdir(), 'aw-restore-'))
  const sourcePath = join(dir, 'source.sqlite')
  const targetPath = join(dir, 'target.sqlite')
  const db = new DatabaseSync(sourcePath)
  db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)')
  db.close()
  writeFileSync(targetPath, 'existing')
  await assert.rejects(() => restoreBackup({ source: sourcePath, target: targetPath, dryRun: false }), /confirm/i)
  const corrupt = join(dir, 'corrupt.sqlite')
  writeFileSync(corrupt, 'not sqlite')
  await assert.rejects(() => restoreBackup({ source: corrupt, target: join(dir, 'new.sqlite'), dryRun: true }), /integrity|sqlite/i)
  rmSync(dir, { recursive: true, force: true })
})
