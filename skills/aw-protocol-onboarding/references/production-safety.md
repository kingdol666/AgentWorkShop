# 生产安全与实例纪律

## 1. “生产”在本 skill 里的定义

**任何已经运行的实例,默认都按生产对待。** 不去猜它是不是演示/测试;只有用户明确说“这是可丢弃测试实例”,才允许 `--test-instance`。原因很直接:平台同时承载 DAQ 采集、DCW 写控、HITL 审批与 Channel 作业,一次误杀可能让真实产线停在半动作状态,事后无法从日志还原现场。

## 2. 预检读什么

`node scripts/onboarding/preflight.mjs --json` 只做只读检查:

| 来源 | 内容 |
| --- | --- |
| `<configRoot>/.runtime/aw.lock` | `aw start`/supervisor 的实例锁;`{pid, startedAt, mode, port}`。configRoot 在 home 模式 = `AW_HOME`,repo 模式 = `<repo>/.AgentWorkShop` |
| `<AW_HOME ?? cwd>/.runtime/data.lock` | 应用内单实例写者锁;直接 `node .output/server/index.mjs` 也受它约束 |
| `process.kill(pid,0)` | PID 是否存活(EPERM 视为存活) |
| TCP connect | 端口是否监听(不发 HTTP) |
| `--probe` | 额外 GET `/api/health`(仅 http,本机诊断,不跟随重定向) |

候选 home:`AW_HOME`、`--home`、`<repo>/.AgentWorkShop`、`~/.AgentWorkShop`、`process.cwd()`。非标准 cwd 的直接启动用 `--home <cwd>` 补齐。候选端口:锁文件里的 port、`--port`、3300、3001。

输出关键字段:

- `running`:任一 PID 存活或端口监听。
- `treatAsProduction`:默认 `running && !--test-instance`。
- `safeToStart`:没有运行中实例时为 true。
- `forbiddenActions`:生产模式下必须回避的动作清单。
- `instances[]`:每个实例的 home/mode/port/pid/pidAlive/portListening/stale。

## 3. 单实例守卫的真实行为

**两条不同的锁,行为不同:**

- `aw start` / `bin/aw.mjs start`:读 `<configRoot>/.runtime/aw.lock`;发现存活实例会**自动 `terminatePid` 后重启新实例**(`scripts/start.mjs` 的“自动顶替”)。在生产上运行 `aw start` 等于停掉当前实例。
- 直接 `node .output/server/index.mjs`:应用内 `01-instance-guard` 在 `<AW_HOME ?? cwd>/.runtime/data.lock` 做独占创建;同目录第二个写者 `EEXIST` + PID 存活 → **exit 1**,不会接管。
- 只有 PID 已死的崩溃残留才会被接管;`AW_SKIP_DATA_LOCK=1` 是测试豁免,生产禁止。

所以“再起一个实例试试”有两种结局:`aw start` 顶掉旧实例,或直接启动被 `data.lock` 拒绝。两者都不该在生产上试。

## 4. 禁止 / 允许

| 禁止 | 原因 |
| --- | --- |
| `aw start`、`aw stop`、`taskkill`、`Stop-Process`、`kill`、`pkill` | `aw start` 会顶掉既有实例;其余会中断在飞采样/写控/HITL |
| `docker compose down` / `docker stop awshop-*` | 同时打断 MQTT/Timescale/MinIO,影响所有 home |
| 同一 `AW_HOME` 或同一端口再启动 | `aw start` 会先顶掉旧实例;直接启动会被 `data.lock` 拒绝;两者都可能造成端口/锁争用 |
| 停止/重启 DAQ 采集总控 | 生产采样中断;需要用户明确批准 |
| 改删既有线/节点/配方/频道 | 影响真实作业面 |
| 为让插件生效而重启进程 | project/user 插件热加载足够;builtin 才需要维护窗口 |

| 允许 | 条件 |
| --- | --- |
| 只读 GET(`/api/health`、`/api/workshop/daq`、`/samples`、`/frames`) | 有该产线 readonly 权限 |
| 创建 `PROTO-<时间戳>` 前缀的测试线与节点 | 用户同意使用该实例做接入 |
| 只 PATCH 本次新建节点的 `driverConfig` | 割接时;不改配方/限界 |
| project/user 插件热加载 | `aw_plugin_toggle` 或触碰 `plugins-state.json` |
| 用 `verify-mirror.mjs` 做只读验收 | 窗口与节点 id 明确 |
| 用 `verify-line.mjs` 跑 V1-V6 | **V2/V3 会真实写入**;只在测试线或用户批准的割接窗执行 |

## 5. 需要用户明确批准的动作

以下动作即使技术上可做,也必须先问:

1. 在生产实例上启动/停止采集总控;
2. 创建 Channel(会拉起 Agent、工具面与可能的下发路径);
3. 对既有节点做 PATCH/DELETE;
4. 任何进程重启(包括 builtin 插件更新);
5. 把测试节点从模拟端点切到真实端点(割接);
6. 清理任何不是本次作业创建的资源。

## 6. 命名空间策略(不新起进程也能隔离)

- 测试线:`PROTO-<YYYYMMDD-HHmm>`;不要复用生产主线。
- 节点名:`PROTO-<tag>-<point>`;与既有节点明显区分。
- 记录本次创建的 `lineId / nodeIds[] / recipeIds[] / channelIds[]`,收尾按逆序删除。
- 验收窗口用 `from/to` 明确指定,不扫全库。
- 不修改全局 controller 节拍/保留期/限界设置。

## 7. 影子实例(仅在用户要求隔离时)

```bash
# 不同端口 + 不同 home;不要复用生产 home
PORT=3310 AW_MODE=home AW_HOME=D:/tmp/aw-proto-shadow-<ts> \
  NUXT_SESSION_PASSWORD=<32+字符> node .output/server/index.mjs
```

注意:MQTT/Timescale/MinIO 默认仍指向同一套基础设施。需要真正隔离时,额外覆盖:

```bash
DAQ_TSDB_URL=postgres://user:pass@127.0.0.1:55432/awshop_shadow
DAQ_MQTT_URL=mqtt://127.0.0.1:18830
DAQ_OS_URL=http://access:secret@127.0.0.1:9100/daq-shadow
```

即使影子实例,也不得停止/重启生产进程;它只是另一组端口与 home。

## 8. 事故处置

1. 立即停止当前作业脚本(不要停平台)。
2. 记录已创建的 id、时间窗、最后一条 API 回包。
3. 不要删除/覆盖证据(节点、样本、日志、HITL 卡)。
4. 向用户报告:影响了哪些资源、是否有写入、是否需要人工回退。
5. 只有在用户确认后,才按 id 清理本次创建的资源。

## 9. 热加载边界

| 插件位置 | 生效方式 | 生产可用 |
| --- | --- | --- |
| `.AgentWorkShop/plugins/<name>/`(project) | 触碰 `plugins-state.json`,~1s 全量重载 | 是 |
| `~/.AgentWorkShop/plugins/<name>/`(user) | 同上 | 是 |
| `server/plugins-builtin/`(builtin) | entry 会随状态文件重载;内部 helper 模块可能被 ESM 缓存,且 builtin 优先级遮蔽 project 同名副本 | 验证后仍不确定 → 维护窗口 |
| 核心 `server/` / `shared/` 代码 | 需要重启 | 移交维护窗口 |

热加载后必须用 `aw_plugin_list` 确认插件存在、`failures` 为空,并实测其路由/钩子/驱动出现在目录里;不要把“文件已保存”当成“已生效”。
