/**
 * 参数建议台账（批次 M2，2026-11-27）。
 * 只建表/索引，不改 SCHEMA_SQL。
 */
import type { DatabaseSync } from 'node:sqlite'

const DDL = [
  'CREATE TABLE IF NOT EXISTS parameter_proposals (',
  '  id                    TEXT PRIMARY KEY,',
  '  channel_id            TEXT NOT NULL,',
  '  line_id               TEXT NOT NULL DEFAULT \'\',',
  '  product_id            TEXT NOT NULL DEFAULT \'\',',
  '  recipe_id             TEXT NOT NULL DEFAULT \'\',',
  '  recipe_revision       TEXT NOT NULL DEFAULT \'\',',
  '  node_id               TEXT NOT NULL,',
  '  node_name             TEXT NOT NULL DEFAULT \'\',',
  '  variable              TEXT NOT NULL DEFAULT \'\',',
  '  from_value            REAL,',
  '  to_value              REAL,',
  '  expected_effect       REAL,',
  '  ci_low                REAL,',
  '  ci_high               REAL,',
  '  target_direction      TEXT NOT NULL DEFAULT \'unknown\',',
  '  confidence            REAL NOT NULL DEFAULT 0,',
  '  mode                  TEXT NOT NULL DEFAULT \'exploit\',',
  '  evidence_json         TEXT NOT NULL DEFAULT \'[]\',',
  '  constraints_json      TEXT NOT NULL DEFAULT \'{}\',',
  '  status                TEXT NOT NULL DEFAULT \'proposed\',',
  '  applied_recipe_revision TEXT NOT NULL DEFAULT \'\',',
  '  proposal_id_origin    TEXT NOT NULL DEFAULT \'\',',
  '  feedback_json         TEXT NOT NULL DEFAULT \'{}\',',
  '  created_by            TEXT NOT NULL,',
  '  created_at            TEXT NOT NULL,',
  '  updated_at            TEXT NOT NULL',
  ')',
].join('\n')

export function migrateParameterProposals(db: DatabaseSync): void {
  db.prepare(DDL).run()
  db.prepare('CREATE INDEX IF NOT EXISTS idx_param_proposals_scope ON parameter_proposals(line_id, status, created_at DESC)').run()
  db.prepare('CREATE INDEX IF NOT EXISTS idx_param_proposals_channel ON parameter_proposals(channel_id, status)').run()
}
