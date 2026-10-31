-- ============================================================
-- AgentWorkShop · TimescaleDB 可选物理隔离:按产线空间分区(部署期,可选)
--
-- 何时需要:
--   默认已经通过 `line_id` 前缀索引 + 逐产线保留期 + 压缩 segmentby('line_id,node_id')
--   实现逻辑隔离与物理段隔离。若还需要"每条产线的数据落在独立 chunk 文件"
--   (例如按产线单独迁移/清理/冷热分层),可在维护窗口执行本脚本开启 Timescale 空间分区。
--
-- 前提/影响:
--   1) 仅对**执行之后新建的 chunk** 生效;存量 chunk 保持原样(不做重写)。
--   2) `line_id` 必须先非空(脚本会把 NULL 规范为空串)并建立默认值。
--   3) `add_dimension` 在部分 Timescale 版本/已有数据的情况下会失败;脚本已用
--      EXCEPTION 包裹,失败只提示不中断(不影响现有读写)。
--   4) number_partitions 按产线数量规划:产线 ≤ 8 用 8;更多建议 16/32。
--   5) 执行后请观察 24h:chunk 数量 = 天数 × 分区数,过大会增加元数据开销。
--
-- 执行:
--   psql "$DAQ_TSDB_URL" -f deploy/timescale/002-daq-space-partition.sql
-- ============================================================

UPDATE daq_samples SET line_id = '' WHERE line_id IS NULL;
ALTER TABLE daq_samples ALTER COLUMN line_id SET DEFAULT '';
ALTER TABLE daq_samples ALTER COLUMN line_id SET NOT NULL;

DO $do$
BEGIN
  PERFORM add_dimension('daq_samples', 'line_id', number_partitions => 8, if_not_exists => TRUE);
  RAISE NOTICE 'daq_samples 已按 line_id 建立空间分区(仅影响新 chunk)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '空间分区未启用(不影响读写):%', SQLERRM;
END
$do$;

-- 压缩段键包含 line_id:每条产线在压缩块内连续,单线查询只解压自己的段。
ALTER TABLE daq_samples SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'line_id,node_id',
  timescaledb.compress_orderby = 'ts DESC'
);

-- 聚合表同样按 line_id 分段(它与 daq_samples 同键,便于跨保留期拼接)。
ALTER TABLE daq_rollup SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'line_id,node_id',
  timescaledb.compress_orderby = 'ts DESC'
);
