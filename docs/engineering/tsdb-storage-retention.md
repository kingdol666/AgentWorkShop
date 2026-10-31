# 时序存储模型与分层保留(DAQ / TimescaleDB)

> 适用版本:v0.8.7+。生产后端 = TimescaleDB(PostgreSQL + timescaledb 扩展);SQLite 仅为开发仿真。
> 相关代码:
> - 适配器(热路径):`server/services/workshop/daq/storage/timescale.adapter.ts`
> - 保留/聚合旁路:`server/services/workshop/daq/storage/timescale-rollup.ts`
> - 策略纯函数:`server/services/workshop/daq/storage/retention.ts`
> - 统一门面:`server/services/workshop/daq/storage/index.ts`
> - 部署期可选迁移:`deploy/timescale/002-daq-space-partition.sql`

## 1. 为什么不是"一条产线一张表"

SQL 标识符**不能参数绑定**。运行期为每条产线建表/查表必须拼接标识符,这与本仓库
"禁止任何 SQL 字符串拼接"的安全门禁直接冲突(门禁会把 `format('%I', …)`、
`query(变量)` 一律按 SQL 注入拦截)。因此在生产上采用**等价隔离**:

| 目标 | 实现 |
|---|---|
| 按产线检索只扫描本线数据 | `line_id` 前缀索引 `(line_id, ts)` / `(line_id, node_id, ts)` + 时间 chunk 剪枝 |
| 产线数据物理分离 | 压缩 `segmentby = 'line_id,node_id'`(压缩段按线连续);可选空间分区 `deploy/timescale/002` 让每个新 chunk 只含一条产线 |
| 按产线不同保留期 | `daq_line_storage` 覆写 + 逐线分片 `DELETE`(不再使用全局 `drop_chunks` 删样本) |
| 不因保留期丢历史 | 1 分钟聚合保留 1 年、1 小时聚合默认永久;跨保留期查询自动拼接 |
| 无表爆炸 / 无 DDL 竞态 | 单 hypertable + 聚合表;建表由部署期迁移完成,不在请求路径 |

> 如确实需要"每线独立物理表",需要先为该需求走一次安全例外评审(动态 DDL 豁免),
> 不建议在现有门禁下绕行。

## 2. 表与职责

| 表 | 内容 | 保留 |
|---|---|---|
| `daq_samples` | 原始样本(一行 = 一节点一时刻);列含 `line_id/product_id/recipe_id/run_id/ingested_at` | `daq.tsRetentionH`,缺省 **720h(30 天)** |
| `daq_frames` | 向量/图像帧元数据(像素在对象存储) | `daq.frameRetentionH`,缺省 720h |
| `daq_rollup` | 1m/1h 聚合;主键含 `(line_id, node_id, res_ms, ts, product_id, recipe_id, run_id)` | 1m:`daq.rollup.minuteRetentionH`(缺省 8760h);1h:`hourRetentionH`(0=永久) |
| `daq_line_storage` | 逐产线保留期覆写(NULL = 继承全局) | 元数据,不清理 |
| `daq_rollup_watermark` | 聚合水位 `(line_id, res_ms) → watermark_ms` | 元数据,不清理 |

写路径(采集 → 入队 → 消费 → 攒批)本身不变;新增的只有"写入时登记产线"
(`daq_line_storage` 首次出现该线时插入一行,幂等)。

## 3. 保留期与历史查询语义

默认三级:

```
0 ─────────────── 30d ───────────────── 1y ──────────────────▶ now
   原始样本(raw)      1 分钟聚合(1m)        1 小时聚合(1h,永久)
```

- 查询窗口完全落在 raw 保留期内 → **原始样本**(精确);
- 窗口早于 raw 保留期 → 自动改走聚合;桶宽 ≥ 1h 且 1h 聚合可用 → 1h,否则 1m;
- 窗口跨越 raw 边界 → **mixed**:老段聚合 + 新段原始,按桶起点合并,同点 raw 优先;
- 聚合聚合了批次标签(产品/配方/批次进主键),不会把不同配方的数据混在一个桶里;
- 1h 聚合由 1m 聚合加权(`sum(avg*cnt)/sum(cnt)`),不做二次采样。

**不会静默丢历史**:返回结果带 `coverage`(请求窗口、实际最早可查时刻、raw 边界、是否截断、说明)。
超出所有保留期的窗口会明确返回"该段不可查",不是空数组。

### 逐产线覆写

```bash
# raw 保留 90 天;1m 保留 2 年;1h 永久
curl -X PUT "$AW_BASE/api/workshop/daq/storage/retention" \
  -H 'content-type: application/json' \
  -d '{"line_id":"ln-xxxx","raw_retention_h":2160,"minute_retention_h":17520,"hour_retention_h":0}'
```

- 有任一覆写时,**全局 `drop_chunks` 停止删除样本**,改为逐线分片 `DELETE`
  (否则"保留更久"的产线会被全局保留期误删);
- 单次删除 5 万行/批,循环到清空,避免长事务;压缩 chunk 的 `DELETE` 需要 Timescale ≥ 2.11;
- 覆写立即生效(下一轮清理),不需要重启。

## 4. 聚合任务

- 调度:daq 启动插件,`daq.rollup.intervalMs`(缺省 10 分钟),启动 15s 后先跑一轮;
- 只处理 `now - lagMs` 之前的**闭合窗口**(缺省 lag 5 分钟,远大于采集乱序窗口);
- 幂等:`ON CONFLICT DO NOTHING` + 水位表;按 `windowMs`(缺省 1h)逐窗推进,
  单轮最多 `maxWindowsPerRun`(缺省 24)个窗口,积压多轮追平;
- 1h 只聚合已完整的 1m 桶,且不越过 1m 水位(避免半个小时的错误聚合);
- 失败只告警,不影响采集;原始样本仍可写可查。

运维入口:

```bash
GET  /api/workshop/daq/storage           # 布局/保留期/水位/体积
POST /api/workshop/daq/storage/rollup    # 手动补跑一轮(admin/editor)
PUT  /api/workshop/daq/storage/retention # 逐产线保留期(admin/editor)
```

## 5. Agent 取数(字段 + 起止时间)

`daq_query` 支持:

- `node_id` 或 `node_ids`(逗号分隔/数组,≤20),`line_id` 过滤;
- `from` / `to`:**ISO 8601**(`2026-10-01T08:00:00+08:00`)或 epoch 毫秒;
  仍兼容 `from_ms` / `to_ms`;`last_minutes` 作为相对快捷方式;
- `bucket_ms`、`agg`(avg/min/max)、`limit`;
- 窗口早于 raw 保留期时自动走聚合,并在输出里打印
  `数据分辨率=1 分钟聚合|1 小时聚合|聚合+原始拼接` 与实际最早可查时刻。

示例:

```json
{ "node_ids": ["dn-aaa", "dn-bbb"], "from": "2026-09-01T00:00:00+08:00",
  "to": "2026-09-30T23:59:59+08:00", "bucket_ms": 3600000, "agg": "avg" }
```

## 6. 上线/回滚

**数据库权限**:历史治理旁路会创建 `daq_rollup` / `daq_line_storage` / `daq_rollup_watermark`
三张表与索引,并对 `daq_samples` 执行 `DELETE` / `drop_chunks`。外部托管 PostgreSQL 请预先授权
(`CREATE` on schema public + 上述表的读写);旁路初始化失败会在日志打印
`[daq-tsdb] 保留期/rollup 旁路初始化失败`,此时采集不受影响,但**保留期不会自动执行**,
`GET /api/workshop/daq/storage` 会显示 `rollup.enabled=false`,需运维修复后重启。

**升级(已有数据)**:直接部署新版本即可。

- 新表(`daq_rollup`/`daq_line_storage`/`daq_rollup_watermark`)由旁路在启动时幂等创建;
- 已有 `daq_samples` 不动;后台会一次性把出现过的 `line_id` 回填到 `daq_line_storage`;
- 旧的全局 `drop_chunks('daq_samples', …)` 已从适配器移除,样本删除改由旁路按线执行;
- 首次启动后聚合从每条线**最早样本**开始追赶,积压大时多轮追平(raw 30 天仍在,不会先丢数据)。

**可选物理隔离**(仅新 chunk):

```bash
psql "$DAQ_TSDB_URL" -f deploy/timescale/002-daq-space-partition.sql
```

**回滚**:

- 关闭聚合:`daq.rollup.enabled=false`(历史查询退回纯 raw;`daq_rollup` 数据保留可再打开);
- 保留期改回 7 天:`daq.tsRetentionH=168`(逐线覆写仍优先;如需彻底恢复全局策略,
  把 `daq_line_storage` 的覆写列置 NULL)。

## 7. 容量估算(单线,1s 采样)

- 原始:86400 行/天/节点;压缩后典型 10–25 B/行(取决于基线与列存);
- 1m 聚合:1440 行/天/节点;1h:24 行/天/节点(标签维度会成倍增加,按实际配方切换频率计);
- 规划公式:`行数 ≈ 节点数 × (86400×rawDays + 1440×minuteDays + 24×hourDays)`。

## 8. 已知边界

- 聚合滞后 `lagMs` 内(默认 5 分钟)的数据仍走 raw;把 `from` 设在 lag 之内不会命中聚合,
  这是正确行为(聚合尚未闭合该窗口);
- 1h 聚合以 1m 为源,若 1m 段被过早清理(把 `minuteRetentionH` 调到小于 1h),
  1h 只能聚合已存在的那部分;建议 `minuteRetentionH ≥ 24`;
- SQLite 仿真后端没有聚合表:`queryHistory` 退化为 raw,并在 `coverage.note` 明确说明;
- 空间分区只影响新 chunk,存量 chunk 不重写。
