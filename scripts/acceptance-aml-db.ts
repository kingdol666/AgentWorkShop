import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkshopDb } from '../server/services/workshop/db/database/open'
import { requestCalibration, DEFAULT_TWIN_CALIBRATION_POLICY } from '../server/services/workshop/aml/twin/calibration-scheduler'

const dbPath = join(tmpdir(), `aw-aml-twin-${process.pid}-${Date.now()}.sqlite`)
const db = openWorkshopDb(dbPath)
const required = ['aml_channel_profiles', 'twin_scenes', 'twin_snapshots', 'twin_models', 'twin_trials', 'twin_recommendations', 'twin_update_runs']
const tables = new Set((db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all() as Array<{ name: string }>).map(x => x.name))
const missing = required.filter(x => !tables.has(x))
const calibration1 = requestCalibration(db, { sceneId: 'injection-hold-control', lineId: 'line-injection-01', recipeId: 'recipe-injection-a', newRuns: 3, newRows: 600, reason: 'acceptance' }, DEFAULT_TWIN_CALIBRATION_POLICY, 'acceptance')
const calibration2 = requestCalibration(db, { sceneId: 'injection-hold-control', lineId: 'line-injection-01', recipeId: 'recipe-injection-a', newRuns: 3, newRows: 600, reason: 'acceptance-duplicate' }, DEFAULT_TWIN_CALIBRATION_POLICY, 'acceptance')
const template = db.prepare('SELECT id FROM channel_templates WHERE id=\'chtpl-hybrid-twin-mpc-default\'').get() as { id?: string } | undefined
console.log(JSON.stringify({ dbPath, requiredTables: required.length, missing, hybridTemplateSeeded: template?.id === 'chtpl-hybrid-twin-mpc-default', calibration1Accepted: calibration1.accepted, calibration2Deduped: !calibration2.accepted }, null, 2))
db.close()
try {
  unlinkSync(dbPath)
}
catch {
  // temp cleanup best effort
}
if (missing.length || template?.id !== 'chtpl-hybrid-twin-mpc-default' || !calibration1.accepted || calibration2.accepted) process.exit(1)
