/**
 * 2026-10-30 回归(真 Timescale 契约测试,独立临时库):
 *  运行期新建的产线(实例启动后才产生样本)必须被 rollup/sweep 发现 ——
 *  修复前 knownLines 只在 init() backfill 一次,新线不产 1m/1h 聚合,
 *  且有任一保留期覆写时不进逐线裁剪名单(旧 raw 永不回收)。
 *  修复后 runRollup()/sweepNow() 每轮 refreshKnownLines()。
 *
 * 判据:
 *  A. init 后插入「新线」样本 → 不重启,直接 runRollup() → 新线出现 1m 聚合行且水位推进;
 *  B. 给既有线设保留期覆写(hasOverride=true)→ 新线 30 天前样本在新一轮 sweep 后被裁,
 *     长保留覆写线的同窗样本保留(互不误删)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const DB = `aw_rollup_regress_${Date.now().toString(36)}`
const C = 'awshop-daq-timescale'

function sh(sql: string, db = DB): string {
  return execFileSync('docker', ['exec', C, 'psql', '-U', 'postgres', '-d', db, '-tAc', sql], { encoding: 'utf8' }).trim()
}

test('运行期新建产线:无需重启即进入聚合与逐线裁剪', async () => {
  const pw = execFileSync('docker', ['exec', C, 'printenv', 'POSTGRES_PASSWORD'], { encoding: 'utf8' }).trim()
  execFileSync('docker', ['exec', C, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', `CREATE DATABASE ${DB}`], { encoding: 'utf8' })
  const url = `postgres://postgres:${encodeURIComponent(pw)}@127.0.0.1:5432/${DB}`
  try {
    const { TimescaleRollupStore } = await import('../server/services/workshop/daq/storage/timescale-rollup')
    // daq_samples 由主 TimescaleAdapter 建表;契约测试自建最小形态(rollup store 只读它)
    sh(`CREATE TABLE IF NOT EXISTS daq_samples (
         node_id text NOT NULL, ts timestamptz NOT NULL, value double precision NOT NULL,
         state text NOT NULL DEFAULT 'ok', line_id text, product_id text, recipe_id text, run_id text,
         ingested_at bigint)`)
    sh(`SELECT create_hypertable('daq_samples', 'ts', if_not_exists => TRUE, migrate_data => TRUE)`)
    const store = new TimescaleRollupStore(url, {
      retentionH: 720, frameRetentionH: 720,
      minuteRetentionH: 8760, hourRetentionH: 0,
      enabled: true, lagMs: 60_000, windowMs: 3_600_000, maxWindowsPerRun: 24, poolMax: 2,
    })
    await store.init()

    // 模拟「启动后运行期才开线」:init 时库里没有 LN-NEW,现在注入 40 分钟前样本
    const t40m = Date.now() - 40 * 60_000
    sh(`INSERT INTO daq_samples (node_id, ts, value, state, line_id)
        SELECT 'dn-new', to_timestamp(${Math.floor(t40m / 1000)}) + (i * interval '30 seconds'), 100 + i, 'ok', 'ln-new'
        FROM generate_series(0, 40) AS i`)
    sh(`INSERT INTO daq_samples (node_id, ts, value, state, line_id)
        SELECT 'dn-keep', now() - interval '35 days' + (i * interval '1 minute'), 200 + i, 'ok', 'ln-keep'
        FROM generate_series(0, 8) AS i`)

    // A: 不重启 → 直接 rollup,新线必须被聚合
    const r = await store.runRollup()
    const newMin = Number(sh(`SELECT count(*) FROM daq_rollup WHERE line_id='ln-new' AND res_ms=60000`))
    const wm = sh(`SELECT watermark_ms FROM daq_rollup_watermark WHERE line_id='ln-new' AND res_ms=60000`)
    assert.ok(newMin > 0, `新线 1m 聚合行应 >0,实得 ${newMin}(notes=${r.notes.join(';')})`)
    assert.ok(Number(wm) > 0, `新线水位应推进,实得 ${wm}`)

    // B: 逐线覆写(长保留线)→ sweep 后新线按全局 30 天裁、长保留线保留
    await store.setLineRetention('ln-keep', { rawRetentionH: 1000 })
    await store.sweepNow()
    const keepOld = Number(sh(`SELECT count(*) FROM daq_samples WHERE line_id='ln-keep'`))
    const newRows = Number(sh(`SELECT count(*) FROM daq_samples WHERE line_id='ln-new'`))
    assert.equal(keepOld, 9, `长保留线 35 天前样本应保留 9 行,实得 ${keepOld}`)
    assert.equal(newRows, 41, `新线近期样本(40 分钟前)不应被 30 天窗口裁掉,实得 ${newRows}`)

    // C: 压缩 chunk 上的逐线裁剪(2026-10-30 回归,生产 DDL 同构):
    // 生产对 daq_samples/daq_rollup 挂 1 天列存压缩策略;旧实现 ctid 批删在压缩
    // chunk 上必报「transparent decompression only supports tableoid system column」
    // → sweep 整体失效、数据无限增长。测试表必须同样开压缩,否则与生产环境偏离。
    sh(`ALTER TABLE daq_samples SET (timescaledb.compress, timescaledb.compress_segmentby = 'node_id', timescaledb.compress_orderby = 'ts DESC')`)
    sh(`SELECT add_compression_policy('daq_samples', INTERVAL '1 day', if_not_exists => TRUE)`)
    sh(`INSERT INTO daq_samples (node_id, ts, value, state, line_id)
        SELECT 'dn-old', now() - interval '35 days' + (i * interval '1 hour'), 5 + i, 'ok', 'ln-old' FROM generate_series(0, 23) i`)
    await store.runRollup() // ln-old 先聚合出 1m 水位(F4 契约:未聚合不裁 raw)
    sh(`SELECT compress_chunk(i) FROM show_chunks('daq_samples', older_than => now() - interval '3 days') i`)
    sh(`INSERT INTO daq_rollup (line_id, node_id, res_ms, ts, product_id, recipe_id, run_id, avg, min, max, cnt)
        SELECT 'ln-old', 'dn-old', 60000, now() - interval '35 days', 'p', 'r', 'run-old', 5, 5, 5, 1`)
    sh(`SELECT compress_chunk(i) FROM show_chunks('daq_rollup', older_than => now() - interval '3 days') i`)
    const compressedChunks = Number(sh(
      `SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name IN ('daq_samples','daq_rollup') AND is_compressed`))
    assert.ok(compressedChunks >= 2, `前置:两个 hypertable 都应有已压缩 chunk,实得 ${compressedChunks}`)
    await store.setLineRetention('ln-old', { rawRetentionH: 720, minuteRetentionH: 24 })
    await store.sweepNow()
    const oldSamples = Number(sh(`SELECT count(*) FROM daq_samples WHERE line_id='ln-old'`))
    assert.equal(oldSamples, 0, `压缩 chunk 上 35 天前样本应被裁光(修复前 ctid 批删在此抛错),实得 ${oldSamples}`)
    const oldRollupMinute = Number(sh(`SELECT count(*) FROM daq_rollup WHERE line_id='ln-old' AND res_ms=60000`))
    assert.equal(oldRollupMinute, 0, `压缩 chunk 上过期 1m 聚合行应被裁光,实得 ${oldRollupMinute}`)
    const oldRollupHour = Number(sh(`SELECT count(*) FROM daq_rollup WHERE line_id='ln-old' AND res_ms=3600000`))
    assert.ok(oldRollupHour > 0, `1h 聚合(hourRetentionH=0 永久)不应被 minute 覆写误删,实得 ${oldRollupHour}`)
    // 长保留线不受误伤(压缩 + 裁剪并存语义)
    const keepAfter = Number(sh(`SELECT count(*) FROM daq_samples WHERE line_id='ln-keep'`))
    assert.equal(keepAfter, 9, `长保留线 35 天前样本在压缩后仍应保留 9 行,实得 ${keepAfter}`)

    await store.close()
  }
  finally {
    // 断开残留连接再删库(连接池 close 是异步收敛,直接 DROP 会撞 "being accessed")
    try {
      execFileSync('docker', ['exec', C, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc',
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}'`], { encoding: 'utf8' })
      execFileSync('docker', ['exec', C, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', `DROP DATABASE IF EXISTS ${DB}`], { encoding: 'utf8' })
    }
    catch { /* 清理失败不影响判定 */ }
  }
}, { timeout: 120_000 })
