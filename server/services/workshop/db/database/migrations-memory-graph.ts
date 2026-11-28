/**
 * 记忆知识网络（Memory Graph）持久化 — 2026-11-27。
 *
 * 只加表/索引，不改 `SCHEMA_SQL`、不 bump 契约版本。
 * 设计纪律：
 *  - 图谱是**派生索引**：记忆/经验/claim 是事实源，图谱可重建；
 *  - 每条 agent 边必须有 evidence（`memory_edge_evidence`），否则拒收；
 *  - 失效不删除：valid_from/valid_to/superseded_by 双时间轴；
 *  - 会话/对话行不入图；所有行仍归属 channel，避免跨频道读。
 *
 * 表分工：
 *  - memory_entities / memory_entity_aliases / memory_entity_mentions：实体与提及；
 *  - memory_edges / memory_edge_evidence：事实边与证据；
 *  - memory_communities / memory_community_members：社区与摘要；
 *  - memory_graph_runs / memory_graph_state：运行台账与增量水位；
 *  - memory_graph_revisions：人工修改快照；
 *  - memory_merge_candidates：模糊合并候选（人工裁决）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { migrateAddColumn } from './migrations'

const ENTITIES_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_entities (',
  '  id             TEXT PRIMARY KEY,',
  '  channel_id     TEXT NOT NULL,',
  '  owner_user_id  TEXT NOT NULL DEFAULT \'\',',
  '  scope_kind     TEXT NOT NULL DEFAULT \'channel\',',
  '  scope_key      TEXT NOT NULL DEFAULT \'\',',
  '  product_id     TEXT NOT NULL DEFAULT \'\',',
  '  entity_type    TEXT NOT NULL,',
  '  canonical_name TEXT NOT NULL,',
  '  canonical_key  TEXT NOT NULL,',
  '  aliases_json   TEXT NOT NULL DEFAULT \'[]\',',
  '  summary        TEXT NOT NULL DEFAULT \'\',',
  '  search_text    TEXT NOT NULL DEFAULT \'\',',
  '  confidence     REAL NOT NULL DEFAULT 0.5,',
  '  salience       REAL NOT NULL DEFAULT 0.5,',
  '  status         TEXT NOT NULL DEFAULT \'active\',',
  '  merged_into    TEXT,',
  '  locked         INTEGER NOT NULL DEFAULT 0,',
  '  author_kind    TEXT NOT NULL DEFAULT \'agent\',',
  '  author_id      TEXT NOT NULL DEFAULT \'\',',
  '  revision       INTEGER NOT NULL DEFAULT 1,',
  '  source_kind    TEXT NOT NULL DEFAULT \'memory\',',
  '  evidence_json  TEXT NOT NULL DEFAULT \'{}\',',
  '  memory_id      TEXT,',
  '  valid_from     TEXT,',
  '  valid_to       TEXT,',
  '  recorded_at    TEXT,',
  '  superseded_by  TEXT,',
  '  created_at     TEXT NOT NULL,',
  '  updated_at     TEXT NOT NULL,',
  '  deleted_at     TEXT',
  ')',
].join('\n')

const ALIASES_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_entity_aliases (',
  '  id         TEXT PRIMARY KEY,',
  '  entity_id  TEXT NOT NULL,',
  '  alias      TEXT NOT NULL,',
  '  alias_key  TEXT NOT NULL,',
  '  source     TEXT NOT NULL DEFAULT \'agent\',',
  '  confidence REAL NOT NULL DEFAULT 1,',
  '  created_at TEXT NOT NULL,',
  '  UNIQUE(entity_id, alias_key)',
  ')',
].join('\n')

const MENTIONS_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_entity_mentions (',
  '  id         TEXT PRIMARY KEY,',
  '  entity_id  TEXT NOT NULL,',
  '  memory_id  TEXT NOT NULL,',
  '  confidence REAL NOT NULL DEFAULT 0.5,',
  '  extractor  TEXT NOT NULL DEFAULT \'rule\',',
  '  created_at TEXT NOT NULL,',
  '  UNIQUE(entity_id, memory_id)',
  ')',
].join('\n')

const EDGES_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_edges (',
  '  id             TEXT PRIMARY KEY,',
  '  channel_id     TEXT NOT NULL,',
  '  owner_user_id  TEXT NOT NULL DEFAULT \'\',',
  '  scope_kind     TEXT NOT NULL DEFAULT \'channel\',',
  '  scope_key      TEXT NOT NULL DEFAULT \'\',',
  '  product_id     TEXT NOT NULL DEFAULT \'\',',
  '  src_id         TEXT NOT NULL,',
  '  dst_id         TEXT NOT NULL,',
  '  relation       TEXT NOT NULL,',
  '  relation_label TEXT NOT NULL DEFAULT \'\',',
  '  fact           TEXT NOT NULL DEFAULT \'\',',
  '  fact_key       TEXT NOT NULL DEFAULT \'\',',
  '  polarity       TEXT NOT NULL DEFAULT \'positive\',',
  '  confidence     REAL NOT NULL DEFAULT 0.5,',
  '  weight         REAL NOT NULL DEFAULT 1,',
  '  status         TEXT NOT NULL DEFAULT \'active\',',
  '  locked         INTEGER NOT NULL DEFAULT 0,',
  '  author_kind    TEXT NOT NULL DEFAULT \'agent\',',
  '  author_id      TEXT NOT NULL DEFAULT \'\',',
  '  revision       INTEGER NOT NULL DEFAULT 1,',
  '  source_kind    TEXT NOT NULL DEFAULT \'memory\',',
  '  evidence_json  TEXT NOT NULL DEFAULT \'[]\',',
  '  valid_from     TEXT,',
  '  valid_to       TEXT,',
  '  recorded_at    TEXT,',
  '  expired_at     TEXT,',
  '  superseded_by  TEXT,',
  '  created_at     TEXT NOT NULL,',
  '  updated_at     TEXT NOT NULL,',
  '  deleted_at     TEXT',
  ')',
].join('\n')

const EDGE_EVIDENCE_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_edge_evidence (',
  '  id              TEXT PRIMARY KEY,',
  '  edge_id         TEXT NOT NULL,',
  '  memory_id       TEXT NOT NULL,',
  '  claim_id        TEXT NOT NULL DEFAULT \'\',',
  '  intervention_id TEXT NOT NULL DEFAULT \'\',',
  '  quote           TEXT NOT NULL DEFAULT \'\',',
  '  confidence      REAL NOT NULL DEFAULT 0.5,',
  '  created_at      TEXT NOT NULL,',
  '  UNIQUE(edge_id, memory_id)',
  ')',
].join('\n')

const COMMUNITIES_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_communities (',
  '  id            TEXT PRIMARY KEY,',
  '  channel_id    TEXT NOT NULL,',
  '  scope_kind    TEXT NOT NULL DEFAULT \'channel\',',
  '  scope_key     TEXT NOT NULL DEFAULT \'\',',
  '  product_id    TEXT NOT NULL DEFAULT \'\',',
  '  level         INTEGER NOT NULL DEFAULT 0,',
  '  parent_id     TEXT,',
  '  title         TEXT NOT NULL DEFAULT \'\',',
  '  summary       TEXT NOT NULL DEFAULT \'\',',
  '  summary_hash  TEXT NOT NULL DEFAULT \'\',',
  '  member_count  INTEGER NOT NULL DEFAULT 0,',
  '  edge_count    INTEGER NOT NULL DEFAULT 0,',
  '  algorithm     TEXT NOT NULL DEFAULT \'label_propagation\',',
  '  revision      INTEGER NOT NULL DEFAULT 1,',
  '  status        TEXT NOT NULL DEFAULT \'active\',',
  '  author_kind   TEXT NOT NULL DEFAULT \'agent\',',
  '  author_id     TEXT NOT NULL DEFAULT \'\',',
  '  created_at    TEXT NOT NULL,',
  '  updated_at    TEXT NOT NULL,',
  '  deleted_at    TEXT',
  ')',
].join('\n')

const COMMUNITY_MEMBERS_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_community_members (',
  '  community_id TEXT NOT NULL,',
  '  entity_id    TEXT NOT NULL,',
  '  weight       REAL NOT NULL DEFAULT 1,',
  '  PRIMARY KEY(community_id, entity_id)',
  ')',
].join('\n')

const RUNS_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_graph_runs (',
  '  id                  TEXT PRIMARY KEY,',
  '  channel_id          TEXT NOT NULL,',
  '  scope_kind          TEXT NOT NULL DEFAULT \'channel\',',
  '  scope_key           TEXT NOT NULL DEFAULT \'\',',
  '  mode                TEXT NOT NULL DEFAULT \'incremental\',',
  '  status              TEXT NOT NULL DEFAULT \'running\',',
  '  scanned             INTEGER NOT NULL DEFAULT 0,',
  '  eligible            INTEGER NOT NULL DEFAULT 0,',
  '  entities_new        INTEGER NOT NULL DEFAULT 0,',
  '  entities_linked     INTEGER NOT NULL DEFAULT 0,',
  '  edges_new           INTEGER NOT NULL DEFAULT 0,',
  '  edges_invalidated   INTEGER NOT NULL DEFAULT 0,',
  '  communities         INTEGER NOT NULL DEFAULT 0,',
  '  llm_calls           INTEGER NOT NULL DEFAULT 0,',
  '  input_chars         INTEGER NOT NULL DEFAULT 0,',
  '  fallback_reason     TEXT NOT NULL DEFAULT \'\',',
  '  error               TEXT NOT NULL DEFAULT \'\',',
  '  started_at          TEXT NOT NULL,',
  '  finished_at         TEXT',
  ')',
].join('\n')

const STATE_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_graph_state (',
  '  id                  TEXT PRIMARY KEY,',
  '  channel_id          TEXT NOT NULL,',
  '  scope_kind          TEXT NOT NULL DEFAULT \'channel\',',
  '  scope_key           TEXT NOT NULL DEFAULT \'\',',
  '  enabled             INTEGER NOT NULL DEFAULT 1,',
  '  last_source_hash    TEXT NOT NULL DEFAULT \'\',',
  '  last_run_id         TEXT NOT NULL DEFAULT \'\',',
  '  last_run_at         TEXT,',
  '  last_full_rebuild_at TEXT,',
  '  last_ontology_hash  TEXT NOT NULL DEFAULT \'\',',
  '  last_claim_hash     TEXT NOT NULL DEFAULT \'\',',
  '  revision            INTEGER NOT NULL DEFAULT 0,',
  '  entity_count        INTEGER NOT NULL DEFAULT 0,',
  '  edge_count          INTEGER NOT NULL DEFAULT 0,',
  '  updated_at          TEXT NOT NULL,',
  '  UNIQUE(channel_id, scope_kind, scope_key)',
  ')',
].join('\n')

const REVISIONS_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_graph_revisions (',
  '  id            TEXT PRIMARY KEY,',
  '  subject_kind  TEXT NOT NULL,',
  '  subject_id    TEXT NOT NULL,',
  '  revision      INTEGER NOT NULL,',
  '  snapshot_json TEXT NOT NULL,',
  '  reason        TEXT NOT NULL DEFAULT \'\',',
  '  author_kind   TEXT NOT NULL DEFAULT \'human\',',
  '  author_id     TEXT NOT NULL DEFAULT \'\',',
  '  created_at    TEXT NOT NULL,',
  '  UNIQUE(subject_kind, subject_id, revision)',
  ')',
].join('\n')

const MERGE_CANDIDATES_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_merge_candidates (',
  '  id               TEXT PRIMARY KEY,',
  '  channel_id       TEXT NOT NULL,',
  '  source_entity_id TEXT NOT NULL,',
  '  target_entity_id TEXT NOT NULL,',
  '  score            REAL NOT NULL,',
  '  reason           TEXT NOT NULL DEFAULT \'\',',
  '  status           TEXT NOT NULL DEFAULT \'proposed\',',
  '  created_at       TEXT NOT NULL,',
  '  updated_at       TEXT NOT NULL,',
  '  UNIQUE(channel_id, source_entity_id, target_entity_id)',
  ')',
].join('\n')

const ENTITY_FTS_DDL = [
  'CREATE VIRTUAL TABLE IF NOT EXISTS memory_entities_fts USING fts5(',
  '  search_text,',
  '  channel_id UNINDEXED,',
  '  entity_rowid UNINDEXED',
  ')',
].join('\n')

const TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS trg_memory_entities_ai AFTER INSERT ON memory_entities BEGIN
     INSERT INTO memory_entities_fts(search_text, channel_id, entity_rowid)
     VALUES (new.search_text, new.channel_id, new.rowid);
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_memory_entities_au AFTER UPDATE OF search_text, channel_id ON memory_entities BEGIN
     DELETE FROM memory_entities_fts WHERE entity_rowid = old.rowid;
     INSERT INTO memory_entities_fts(search_text, channel_id, entity_rowid)
     VALUES (new.search_text, new.channel_id, new.rowid);
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_memory_entities_ad AFTER DELETE ON memory_entities BEGIN
     DELETE FROM memory_entities_fts WHERE entity_rowid = old.rowid;
   END`,
]

const INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_entities_key ON memory_entities(channel_id, scope_kind, scope_key, entity_type, canonical_key) WHERE merged_into IS NULL AND deleted_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_memory_entities_scope ON memory_entities(channel_id, scope_kind, scope_key, status)',
  'CREATE INDEX IF NOT EXISTS idx_memory_entities_owner ON memory_entities(channel_id, owner_user_id, scope_kind, scope_key, status)',
  'CREATE INDEX IF NOT EXISTS idx_memory_entities_type ON memory_entities(channel_id, entity_type, status)',
  'CREATE INDEX IF NOT EXISTS idx_memory_entities_memory ON memory_entities(memory_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_entities_merged ON memory_entities(merged_into)',
  'CREATE INDEX IF NOT EXISTS idx_memory_entities_valid ON memory_entities(channel_id, valid_to)',
  'CREATE INDEX IF NOT EXISTS idx_memory_entity_aliases_key ON memory_entity_aliases(alias_key)',
  'CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_memory ON memory_entity_mentions(memory_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_entity ON memory_entity_mentions(entity_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_edges_fact ON memory_edges(channel_id, src_id, dst_id, relation, fact_key) WHERE deleted_at IS NULL AND status IN (\'active\', \'provisional\')',
  'CREATE INDEX IF NOT EXISTS idx_memory_edges_src ON memory_edges(channel_id, src_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_memory_edges_dst ON memory_edges(channel_id, dst_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_memory_edges_scope ON memory_edges(channel_id, scope_kind, scope_key, status)',
  'CREATE INDEX IF NOT EXISTS idx_memory_edges_owner ON memory_edges(channel_id, owner_user_id, scope_kind, scope_key, status)',
  'CREATE INDEX IF NOT EXISTS idx_memory_edges_relation ON memory_edges(channel_id, relation, status)',
  'CREATE INDEX IF NOT EXISTS idx_memory_edges_valid ON memory_edges(channel_id, valid_to)',
  'CREATE INDEX IF NOT EXISTS idx_memory_edges_superseded ON memory_edges(superseded_by)',
  'CREATE INDEX IF NOT EXISTS idx_memory_edge_evidence_memory ON memory_edge_evidence(memory_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_edge_evidence_claim ON memory_edge_evidence(claim_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_edge_evidence_intervention ON memory_edge_evidence(intervention_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_communities_scope ON memory_communities(channel_id, level, status)',
  'CREATE INDEX IF NOT EXISTS idx_memory_communities_parent ON memory_communities(parent_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_community_members_entity ON memory_community_members(entity_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_graph_runs_scope ON memory_graph_runs(channel_id, started_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memory_graph_runs_status ON memory_graph_runs(status, started_at)',
  'CREATE INDEX IF NOT EXISTS idx_memory_graph_state_channel ON memory_graph_state(channel_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_graph_revisions_subject ON memory_graph_revisions(subject_kind, subject_id, revision DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memory_merge_candidates_scope ON memory_merge_candidates(channel_id, status)',
]

export function migrateMemoryGraph(db: DatabaseSync): void {
  db.prepare(ENTITIES_DDL).run()
  db.prepare(ALIASES_DDL).run()
  db.prepare(MENTIONS_DDL).run()
  db.prepare(EDGES_DDL).run()
  db.prepare(EDGE_EVIDENCE_DDL).run()
  db.prepare(COMMUNITIES_DDL).run()
  db.prepare(COMMUNITY_MEMBERS_DDL).run()
  db.prepare(RUNS_DDL).run()
  db.prepare(STATE_DDL).run()
  db.prepare(REVISIONS_DDL).run()
  db.prepare(MERGE_CANDIDATES_DDL).run()
  db.prepare(ENTITY_FTS_DDL).run()
  // 已存在的验收库补列（新库已含列；幂等）。
  migrateAddColumn(db, 'memory_entities', 'owner_user_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'memory_edges', 'owner_user_id', 'TEXT NOT NULL DEFAULT \'\'')
  for (const trigger of TRIGGERS) db.prepare(trigger).run()
  for (const sql of INDEXES) db.prepare(sql).run()
}
