import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface MigrationRecord {
  version: number
  name: string
  fingerprint: string
}

export function ensureMigrationLedger(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS aw_migration_ledger (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
}

export function recordMigration(db: DatabaseSync, migration: MigrationRecord): void {
  ensureMigrationLedger(db)
  db.prepare(`INSERT INTO aw_migration_ledger(version, name, fingerprint, applied_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(version) DO NOTHING`).run(
    migration.version,
    migration.name,
    migration.fingerprint,
    new Date().toISOString(),
  )
}

export function currentSchemaVersion(db: DatabaseSync): number {
  ensureMigrationLedger(db)
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM aw_migration_ledger').get() as { version?: number } | undefined
  return Number(row?.version ?? 0)
}

export function assertMigrationFingerprint(db: DatabaseSync, version: number, fingerprint: string): void {
  ensureMigrationLedger(db)
  const row = db.prepare('SELECT fingerprint FROM aw_migration_ledger WHERE version = ?').get(version) as { fingerprint?: string } | undefined
  if (row && row.fingerprint !== fingerprint) {
    throw new Error(`migration fingerprint drift at version ${version}: stored=${row.fingerprint} current=${fingerprint}`)
  }
}

export function fingerprintMigration(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}
