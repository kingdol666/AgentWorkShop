/**
 * 本体产品域增量迁移（2026-11-26，批次 4）。
 *
 * 背景：`ontology_versions.line_id` 只支持产线域。用户裁决「产品独立版本」：
 *  - `product_id=''` = 产线通用版本（既有语义不变）；
 *  - `product_id=<id>` = 该产品独立版本，不与产线版本隐式继承。
 *
 * 纪律（与 migrations-memory-admin.ts 同）：只加列/索引，不改 `SCHEMA_SQL`
 * （改模板会改契约指纹，存量库启动即 fingerprint drift）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { migrateAddColumn } from './migrations'

export function migrateOntologyProductScope(db: DatabaseSync): void {
  migrateAddColumn(db, 'ontology_versions', 'product_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'ontology_drafts', 'product_id', 'TEXT NOT NULL DEFAULT \'\'')
  db.exec('CREATE INDEX IF NOT EXISTS idx_ontology_product_scope ON ontology_versions(line_id, product_id, status)')
}
