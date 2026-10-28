# 镜像数采 × 自定义 MES API 在线抓取验收

- 日期:2026-10-29
- 结论:**17/17 PASS**。自定义 MES API v1 的直连取数与镜像数采两条路径都真实可用；API 宕机时镜像历史不断供、恢复后自动续采；Qwen 通过 `daq_query` 在线抓到镜像样本。

## 一、拓扑

- 自建 MES API v1(`scripts/dev-mes-simulator.mjs`,15071,`x-api-token` 鉴权):`/api/v1/params/melt_pressure/current|history`。
- 平台隔离实例 3422(`AW_HOME=D:/tmp/aw-mesmirror-20261029`),凭据零明文:
  - 直连 `mes-rest` 节点:`readMap`/`historyMap` 声明式映射,`secretRef=E2E`(`AW_MES_E2E_TOKEN`);
  - 镜像 `http` DAQ 节点:每秒轮询同一当前值接口(`secretRef=E2E`,`AW_SECRET_E2E`),入 TSDB。

## 二、结果

| # | 断言 | 证据 |
|---|---|---|
| M3 | `mes_catalog` 可见自定义点位 | 目录 1 条,MES熔体压力 |
| M4 | `mes_fetch` 直连历史 | 200 行,统计 min 8.225 / max 8.805 / mean 8.493,字段字典含单位 |
| M5 | 镜像样本落库 | 19 点,尾部 8.392/8.527/8.562 |
| M6 | 镜像=API 当前值 | 8.562 vs 8.492(差 0.07 MPa) |
| M7 | Agent `daq_query` 取镜像 | 「样本 13~173 点 \| 最新 8.429~8.562」 |
| M8 | API 宕机 `mes_fetch` 如实失败 | `isError=true`,「取数失败:fetch failed」 |
| M9 | API 宕机镜像历史不断供 | 宕机 12s 后仍可查 21 点 |
| M10 | 新样本停止 | 最新样本仅前进 1s(停机瞬间在飞样本) |
| M11/M12 | 恢复后续采 | 最新样本时间 17:23:59Z → 17:24:25Z,计数继续增长 |
| Q1 | Qwen 在线抓镜像 | 模型自主 `daq_query` 成功,读到 13 点/最新 8.432；任务由平台在证据收口后取消 |

## 三、本轮修复的鲁棒性缺陷

**`mes_fetch` 全点位失败时未置 `isError`**：内联模式逐点 catch 后只把「取数失败」写进文本，工具仍返回成功。对 Agent 来说，失败被当成成功，可能继续基于空结果决策。

修复(`mes-controller.ts`)：快照与内联两种模式统计失败点位，**全部失败时 `isError=true`**（部分失败仍返回部分结果，文本逐点标注）。M8 即在修复前失败、修复后通过。

## 四、边界

- MES API 为本地模拟器（真实 HTTP/鉴权/分页/历史），不是现场 MES；现场需核对路径、字段路径、鉴权头与分页游标。
- 镜像的“不断供”指历史样本仍可查；停机期间不产生新样本。
- Qwen 单工具任务由平台在证据收口后取消（模型未发 complete_task），不影响抓数结论。
