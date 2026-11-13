import { existsSync, copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface RestoreOptions {
  source: string
  target: string
  dryRun: boolean
  confirm?: string
}

export interface RestoreReport {
  ok: true
  applied: boolean
  source: string
  target: string
  integrity: 'ok'
}

const CONFIRM = 'RESTORE_DATABASE'

function assertSafePath(path: string): string {
  const value = resolve(path)
  if (!value || value === resolve(dirname(value))) throw new Error('invalid restore path')
  return value
}

function assertIntegrity(source: string): void {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(source, { readOnly: true })
  }
  catch (error) {
    throw new Error(`SQLite integrity check failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
    if (row?.integrity_check !== 'ok') throw new Error(`SQLite integrity check failed: ${row?.integrity_check ?? 'unknown'}`)
  }
  catch (error) {
    throw new Error(`SQLite integrity check failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  finally {
    db.close()
  }
}

export async function restoreBackup(options: RestoreOptions): Promise<RestoreReport> {
  const source = assertSafePath(options.source)
  const target = assertSafePath(options.target)
  if (!existsSync(source)) throw new Error('backup source does not exist')
  assertIntegrity(source)
  if (!options.dryRun) {
    if (options.confirm !== CONFIRM) throw new Error(`restore requires confirm=${CONFIRM}`)
    if (existsSync(target)) throw new Error('restore refuses to overwrite an existing target')
    mkdirSync(dirname(target), { recursive: true })
    const temp = `${target}.restore-${process.pid}-${Date.now()}.tmp`
    copyFileSync(source, temp)
    try {
      renameSync(temp, target)
    }
    catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }
  return { ok: true, applied: !options.dryRun, source, target, integrity: 'ok' }
}

export { CONFIRM as RESTORE_CONFIRMATION }
