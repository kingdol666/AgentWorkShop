/**
 * EDA 模块统一 schema(workshop.sqlite)。
 *
 * 承载《data-studio plan》与《eda-enterprise plan》的全部新表;一次建全(additive,
 * CREATE TABLE IF NOT EXISTS),后续模块只加方法不再动 schema。设计依据:
 * docs/plans/2026-10-21-eda-enterprise-plan.md §3。
 *
 * 惯例(与 tool-registry.repo/channel_plugins.repo 同源):
 *  - 自持连接、无外键(跨 JSON 存储的关联只存 id 快照,允许孤儿、呈现侧标 stale);
 *  - 所有外部输入一律 prepared 占位符绑定;动态 IN 只拼占位符;
 *  - owner_user_id 可空(对齐 agents/scheduled_tasks 命名惯例)。
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'

const DB_PATH = join(ensureDataDir(), 'workshop.sqlite')

let db: DatabaseSync | null = null

/** 全部 EDA 表(语句为静态字面量,零外部输入) */
const SCHEMA: readonly string[] = [
  // E1 run 台账:runs.json(dcw-runs.json RUNS_CAP=200 环形)的持久镜像,EDA 查询主键面
  `CREATE TABLE IF NOT EXISTS eda_runs (
    id              TEXT PRIMARY KEY,
    line_id         TEXT NOT NULL,
    product_id      TEXT NOT NULL DEFAULT '',
    recipe_id       TEXT NOT NULL DEFAULT '',
    recipe_name     TEXT NOT NULL DEFAULT '',
    recipe_version  INTEGER,
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    sample_count    INTEGER,
    outcome         TEXT NOT NULL DEFAULT 'open',
    labels_json     TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_eda_runs_line ON eda_runs(line_id, started_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_eda_runs_recipe ON eda_runs(recipe_id, started_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_eda_runs_outcome ON eda_runs(line_id, outcome)',

  // plan1-M1 用户面导出/派生集异步 job 账本(mes_fetch_jobs 同款;跨进程 running 由 bootedAt 判死)
  `CREATE TABLE IF NOT EXISTS eda_export_jobs (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL DEFAULT 'daq-export',
    spec_json    TEXT NOT NULL DEFAULT '{}',
    status       TEXT NOT NULL DEFAULT 'running',
    result_json  TEXT NOT NULL DEFAULT '{}',
    error        TEXT,
    created_by   TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_eda_export_jobs_status ON eda_export_jobs(status, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_eda_export_jobs_creator ON eda_export_jobs(created_by, created_at DESC)',

  // plan1-M2 图表(按用户保存的绘制结果)
  `CREATE TABLE IF NOT EXISTS eda_charts (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    viz_type        TEXT NOT NULL,
    datasource_json TEXT NOT NULL DEFAULT '{}',
    encoding_json   TEXT NOT NULL DEFAULT '{}',
    transform_json  TEXT NOT NULL DEFAULT '{}',
    options_json    TEXT NOT NULL DEFAULT '{}',
    annotations_json TEXT NOT NULL DEFAULT '[]',
    owner_user_id   TEXT NOT NULL,
    line_id         TEXT,
    visibility      TEXT NOT NULL DEFAULT 'private',
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_eda_charts_owner ON eda_charts(owner_user_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_eda_charts_line ON eda_charts(line_id, visibility)',

  // EDA 管道:图表配置模板(用户把「图型+编码字段+后处理代码」存成命名模板,换数据快速复绘)
  `CREATE TABLE IF NOT EXISTS eda_chart_templates (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    chart_type    TEXT NOT NULL,
    config_json   TEXT NOT NULL DEFAULT '{}',
    owner_user_id TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_eda_chart_templates_owner ON eda_chart_templates(owner_user_id, updated_at DESC)',

  // plan1-M3 看板 + 关联(Metabase report_dashboardcard 式)
  `CREATE TABLE IF NOT EXISTS eda_dashboards (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    filters_json TEXT NOT NULL DEFAULT '{}',
    layout_json  TEXT NOT NULL DEFAULT '[]',
    owner_user_id TEXT NOT NULL,
    line_id      TEXT,
    visibility   TEXT NOT NULL DEFAULT 'private',
    version      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS eda_dashboard_charts (
    dashboard_id   TEXT NOT NULL,
    chart_id       TEXT NOT NULL,
    grid_pos_json  TEXT NOT NULL DEFAULT '{}',
    overrides_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (dashboard_id, chart_id)
  )`,

  // E2 golden 参考轨迹
  `CREATE TABLE IF NOT EXISTS eda_golden_traces (
    id             TEXT PRIMARY KEY,
    recipe_id      TEXT NOT NULL,
    node_id        TEXT NOT NULL,
    source_run_id  TEXT NOT NULL DEFAULT '',
    n_bins         INTEGER NOT NULL DEFAULT 100,
    profile_json   TEXT NOT NULL DEFAULT '[]',
    fingerprint_json TEXT NOT NULL DEFAULT '{}',
    created_by     TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    UNIQUE(recipe_id, node_id)
  )`,

  // E3 per-run per-node 特征仓库(FDC/SPC/Commonality/VM 共同数据源,raw 的降压层)
  `CREATE TABLE IF NOT EXISTS eda_run_features (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    node_id     TEXT NOT NULL,
    metric      TEXT NOT NULL DEFAULT '',
    segment     TEXT NOT NULL DEFAULT '',
    cnt         INTEGER,
    mean        REAL,
    std         REAL,
    min         REAL,
    max         REAL,
    slope       REAL,
    breach_cnt  INTEGER NOT NULL DEFAULT 0,
    ref_mean    REAL,
    ref_std     REAL,
    k           REAL,
    z_score     REAL,
    violated    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    UNIQUE(run_id, node_id, metric, segment)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_eda_feat_node ON eda_run_features(node_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_eda_feat_run ON eda_run_features(run_id)',
  'CREATE INDEX IF NOT EXISTS idx_eda_feat_violated ON eda_run_features(violated, created_at DESC)',

  // E3 特征重建 job 账本(mes_fetch_jobs 同款 + bootedAt 跨进程判死)
  `CREATE TABLE IF NOT EXISTS eda_feature_jobs (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'running',
    features    INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_eda_feature_jobs_run ON eda_feature_jobs(run_id)',

  // E4 SPC 控制图注册 + 判定点
  `CREATE TABLE IF NOT EXISTS eda_spc_charts (
    id           TEXT PRIMARY KEY,
    line_id      TEXT NOT NULL,
    node_id      TEXT NOT NULL,
    metric       TEXT NOT NULL DEFAULT '',
    kind         TEXT NOT NULL,
    params_json  TEXT NOT NULL DEFAULT '{}',
    cl           REAL,
    ucl          REAL,
    lcl          REAL,
    sigma        REAL,
    n_points     INTEGER NOT NULL DEFAULT 0,
    enabled      INTEGER NOT NULL DEFAULT 0,
    owner_user_id TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    UNIQUE(line_id, node_id, metric, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS eda_spc_points (
    id        TEXT PRIMARY KEY,
    chart_id  TEXT NOT NULL,
    run_id    TEXT NOT NULL,
    value     REAL,
    stat      REAL,
    rule_hits TEXT NOT NULL DEFAULT '[]',
    violated  INTEGER NOT NULL DEFAULT 0,
    at        TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_eda_spc_points_chart ON eda_spc_points(chart_id, at DESC)',

  // E7 OCAP 记录(弱关联 optimization_explorations / rollback anchor)
  `CREATE TABLE IF NOT EXISTS eda_ocap_records (
    id           TEXT PRIMARY KEY,
    alarm_id     TEXT NOT NULL,
    run_id       TEXT,
    node_id      TEXT,
    title        TEXT NOT NULL,
    steps_json   TEXT NOT NULL DEFAULT '[]',
    status       TEXT NOT NULL DEFAULT 'open',
    closed_by    TEXT,
    closed_at    TEXT,
    linked_exploration_id TEXT,
    linked_rollback_anchor TEXT,
    owner_user_id TEXT,
    created_at   TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_eda_ocap_alarm ON eda_ocap_records(alarm_id)',

  // E8 run 内 step/相位段定义(FDC 按段特征 + 相位对齐共用)
  `CREATE TABLE IF NOT EXISTS run_segments (
    id         TEXT PRIMARY KEY,
    recipe_id  TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    phase_from REAL NOT NULL,
    phase_to   REAL NOT NULL,
    UNIQUE(recipe_id, seq)
  )`,
]

function ensureSchema(d: DatabaseSync): void {
  for (const ddl of SCHEMA) d.prepare(ddl).run()
}

export function edaDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(DB_PATH)
    db.prepare('PRAGMA busy_timeout=4000').run()
    ensureSchema(db)
  }
  return db
}
