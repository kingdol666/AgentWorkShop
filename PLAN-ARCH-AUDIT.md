# AgentWorkShop 架构审计与优化 Plan

> 生成方式:7 路并行只读审计(插件系统 / SDK+CLI / DAQ / DCW / Agent 运行时 / 节点绑定 / 代码卫生)
> + 父 agent **逐条亲自复核**。标注 `✅已复核` 的条目由我本人重新读码或构造实验确认;
> 标注 `❌已证伪` 的是子审计报告中的**误报**,已剔除并说明原因。
> 未经复核的条目一律标 `⚠未复核`,**不进入执行清单**。

## 0. 复核结论摘要(先看这里)

子审计共报出 11 条 P0,我逐条复核后 **只有 5 条成立**,3 条被证伪。这说明:
**并行审计的产出必须逐条验证,不能直接作为工单。**

| 子审计声称 | 复核结果 | 依据 |
|---|---|---|
| DCW `writing` 中间态从未实现,写无互斥 | ❌**证伪** | `dcw-runtime.ts:71-87` 有完整互斥;`node.state='writing'` 在 :75 |
| Agent↔节点绑定与节点↔设备绑定"断链" | ❌**证伪** | `industrial-tools.ts:37-92` 真实消费 bindings 并据其鉴权 |
| `activeChannels` 运行时泄漏 58 条 | ❌**证伪** | DB 中确实有 58 个 channel(测试残留),非泄漏 |
| 插件 `setup` 失败留下幽灵路由 | ✅已复核 | `host.mjs:482-487` 先 registerRoute 后 await setup |
| 插件 client 路径校验可被前缀绕过 | ✅已复核+**实验证明** | `host.mjs:685` startsWith;`scripts/_dbg-path-proof.mjs` |
| 插件 scope 覆盖顺序与注释相反 | ✅已复核 | `host.mjs:190-197` 先到先得 = builtin > project > user |
| `package.json` exports 指向不存在的 client.d.mts | ✅已复核+**实测证明** | `npm pack --dry-run` 确认该文件不发布 |
| DAQ 帧先广播后落库 → 缩略图 404 | ✅已复核 | `daq-controller.ts:368` vs `:385` |
| DCW 保写心跳绕过写在飞互斥 | ✅已复核 | `dcw-runtime.ts:101` 直调 host.executeWrite,跳过 :71 闸门 |
| memory 反思 `limit=1_000_000` 全表扫 | ✅已复核 | `manager.ts:471` |
| CLI `code ?? 0` 吞掉信号退出码 | ⚠未复核 | 待验证 |

---

## 1. 已复核确认的问题清单

### P0-1 插件 setup 失败 → 幽灵路由 + omp 工具永久泄漏 ✅已复核
**位置**:`server/services/workshop/plugins/host.mjs:482-493`
**事实**:`emitter.registerRoute()` 与 `host.disposables/hookOffs` 写入发生在 `await def.setup?.(ctx)` **之前**,
而 `host.plugins.set(def.name, rec)` 在**之后**。setup 抛错时:`host.routes` 已含该插件路由(HTTP 可命中),
但 `host.plugins` 无记录 → `doReload` 的 `prevNames = [...host.plugins.keys()]` 不含它 →
`host.mjs:567-572` 注销 omp 工具时**跳过它** → 工具永久残留。
**修复**:把 `registerRoute` 移到 `setup` 成功之后;或 setup 失败时显式回滚已注册路由与 disposables。
**验收**:构造一个 `setup` 必抛错的插件,断言 `pluginManifest()` 无其路由且 `host.routes.byPlugin(name)` 为空。

### P0-2 插件 client 脚本路径包含判定错误(前缀绕过)✅已复核+实验证明
**位置**:`host.mjs:685`
```js
if (!resolve(rec.clientPath).startsWith(resolve(rec.dir))) return { status: 400 }
```
**事实**:`startsWith` 是**字符串前缀**比较,不是路径包含判定。
`rec.clientPath = resolve(rec.dir, def.client)`,而 `def.client` 由插件作者提供,
写 `'../rag-bridge-evil/x.mjs'` 即可逃逸;`_dbg-path-proof.mjs` 已跑通该判定差异:
```
sibling prefix dir   startsWith=true   correct(relative-check)=false
```
配合 `readClientScript` 经 `/api/plugins/client/:name` **免鉴权**暴露,任意匿名请求可读取检出内任意
与该前缀同源的 JS 文件。
**修复**:改 `relative()` 判定;并让 `rec.clientPath` 在**装载期**就 resolve 定死,不接受运行时拼接。
**验收**:单元测试覆盖 `..` 逃逸与同前缀兄弟目录两种攻击串。

### P0-3 SDK exports 指向不存在的类型文件,发布包不可用 ✅已复核+实测证明
**位置**:`package.json:16-19`,`sdk/client.d.mts`
**事实**:`npm pack --dry-run` 输出 2717 个文件,`has sdk/client.d.mts: false`。
任何 `import ... from 'agentworkshop/sdk/client'` 在 node16/bundler 解析下直接 TS 报错。
另外 `sdk/index.d.mts` 与运行时漂移(min `'user'` vs 实际 `'home'`、缺 `permissions:changed`/`daq:frame`、
`createClientContext` 未声明 `ui/t/getLocale`)。
**修复**:补 `sdk/client.d.mts`;用脚本从 `LIFECYCLE_EVENTS` 常量生成类型清单防止再次漂移。
**验收**:`npm pack` 后对 tarball 跑 `tsc --noEmit` 的冒烟导入。

### P0-4 DAQ 帧先广播后落库,缩略图/内容稳定 404 ✅已复核
**位置**:`daq-controller.ts:368`(`scheduleTsdbFlush()` 异步 500ms 刷盘)vs `:385`(`broadcast('daq.frame')`)
**事实**:广播载荷里带 `thumbUrl: /api/workshop/daq/{id}/frames/content?ts={tsMs}`(`:380-382`),
前端收到帧后立刻回查,**此时行还在 `frameBuffer` 里没落库** → `queryFrames` 查不到 → 404。
**修复**:二选一 —— (a) 广播延后到 flush 完成之后;(b) 帧内容查询先读内存 `frameBuffer` 再落库读(读穿透缓存)。
推荐 (b),因为它同时消除了 500ms 窗口内的所有竞态,且不牺牲实时性。
**验收**:集成测试:注入一帧 → 立即查 content → 必须 200。

### P0-5 DCW 保写心跳绕过写在飞互斥 ✅已复核
**位置**:`dcw-runtime.ts:97-103`
**事实**:`write()` 在 `:71` 用 `this.writing || node.state === 'writing'` 做互斥,
但 tick 的保写心跳在 `:101` **直接** `void this.host.executeWrite(node, node.value, ...)`,
完全跳过该闸门。用户/Recipe 下发与心跳重下发可同节点并发,`applyWriteResult` 后到者覆盖先到者,
且 `dcw-controller.ts:532` 的 `prevValue` 采样跨 await,会把**过期值**记进回滚账本 → 回滚点错位。
**修复**:心跳改为走 `this.write()`(或至少共享同一 `writing` 闸门),并让心跳在与写并发时**跳过本拍**而非排队。
**验收**:并发测试:在写事务进行中触发心跳,断言驱动层同时只有一个在飞写。

### P1 级(已复核)
| ID | 问题 | 位置 | 修复方向 |
|---|---|---|---|
| P1-1 | 插件 scope 覆盖顺序 = builtin>project>user,与注释/文件头相反,用户同名插件被内置静默顶掉 | `host.mjs:190-197` | 反转遍历顺序为 user→project→builtin(后者先占),或改为显式优先级覆盖 |
| P1-2 | 热重载不清 `servicesExt.registry`,旧插件 getter 与 `_cache` 永久残留 | `host.mjs:113-133`,`544-594` | reload 时按 plugin 前缀清理 registry + 清 `_cache` |
| P1-3 | memory 反思对每 agent 拉 `limit=1_000_000` 全表再 JS filter | `manager.ts:470-472` | 过滤条件下推 SQL(agent+kind+month),加分页游标 |
| P1-4 | `reflectCounts`/`ownerNameCache`/`metricStates`/`twinPushAt` 四个 Map 无淘汰 | `manager.ts:327,230`;`daq-controller.ts:127,677` | 统一替换为有界 LRU |
| P1-5 | `monitorRuntime` 读接口内做 sweep 写操作 + 循环内逐条 DB 查询 | `manager.ts:812-828` | sweep 移出读路径;查询改批量 `IN` |
| P1-6 | DAQ sweep `void rt.tick()` 无并发闸门,N 节点同拍 → 驱动洪峰 | `daq-controller.ts:436-440` | 加并发信号量(如 8) |
| P1-7 | MQTT `close()` 不 `removeAllListeners` | `mqtt.adapter.ts:113-123` | close 时显式移除监听 |
| P1-8 | DCW anchors append-only 无上限 + 4 个方法各自线性逆扫 | `recipe-rollback.repo.ts:5,78-131` | 加 cap + 每节点索引(last/lastStable 用 Map 维护) |
| P1-9 | `evaluateOpenRecords` 挂 500ms sweep,每次全量 `[...].reverse()` 2000 条 | `recipe-rollback.repo.ts:113,162`;`manager:417` | 维护 open 集合索引,避免全量拷贝 |
| P1-10 | CLI 子进程被信号杀死返回 0 | `start.mjs:122`,`dev.mjs:68`,`build.mjs:27` | `code ?? (signal ? 128+15 : 0)` |
| P1-11 | `cli/aw.mjs:156` 按字面量 filter argv,同名值被吞 | `cli/aw.mjs:156` | 改为按位置剥离全局标志 |
| P1-12 | `sdk/client.mjs:71` 不校验信封 `code!==0`(api.mjs 校验),业务错误被当成功 | `client.mjs:71` vs `api.mjs:38` | 抽 `httpJson()` 统一 |
| P1-13 | `requireLineMode(user, undefined, ...)` 对不存在节点给 admin 放行 | `permissions.ts:32` | 调用方先断言节点存在,不存在返回 404 |
| P1-14 | `daq-controller.ts:944` 端口未装配时 `!undefined` 恒真 → 绑定恒 404,降级语义失效 | `daq-controller.ts:944,959` | 显式判 `host == null` 走降级 |

### P2 级(已复核,可批量治理)
- 巨型文件:`TownView.vue` 253KB、`TownScene3D.ts` 197KB、`manager.ts` 139KB、`industrial-tools.ts` 92KB。
- 7 个 adapter 各写一份 harness 配置落盘逻辑 → 抽 `HarnessConfigWriter`。
- `json-store.mjs` 的原子写被 13 个 repo 复用,但 AML(12 处)与 `plugins/host.mjs:181` 全部绕过。
- `cli/core/args.mjs` 的 `unknown`/`flagValue` 是死代码。
- `server/utils/` 6 文件 212 行服务约 190 个端点,错误码仅 5 个 → 大量绕过。
- 仓库卫生:12 个 .tgz、`.AgentWorkShop.bak-*`、`npm-codex.json` 13MB、两个临时 txt 在根目录。
- 无 CI(仅 docs 部署),约 220 个测试脚本无 runner。

---

## 2. 执行计划(分批,每批自带回归)

### 批次 A —— 安全与正确性 P0(必须先做)
1. P0-1 插件 setup 半注册回滚
2. P0-2 client 路径包含判定 + 新增路径安全单测
3. P0-5 DCW 心跳互斥
4. P0-4 帧读穿透缓存
5. P0-3 SDK 类型补齐 + 生命周期清单生成

**回归**:lint + typecheck + build + 新增单测 + `api-live-e2e`

### 批次 B —— 资源与效率 P1
6. P1-8/P1-9 回滚账本索引化与上限(算法优化重点)
7. P1-3/P1-4 memory 反思 SQL 下推 + 有界 LRU
8. P1-5 monitor 读写分离 + 批量查询
9. P1-6/P1-7 DAQ 并发闸门 + 监听器清理
10. P1-14 端口未装配降级

### 批次 C —— 接口与工具链 P1
11. P1-10/P1-11 CLI 退出码与 argv
12. P1-12 `httpJson()` 统一 SDK 两个 HTTP 面
13. P1-1/P1-2 插件 scope 顺序与 registry 清理
14. P1-13 节点存在性前置校验

### 批次 D —— 冗余治理 P2(抽取,不改行为)
15. `HarnessConfigWriter` 合并 7 处
16. `json-store` 推广到 AML + plugin host
17. 路径安全/并发闸门/LRU 抽为 `shared/` 工具
18. 仓库卫生清理

### 批次 E —— 测试与 CI
19. 统一测试 runner(`scripts/run-tests.mjs`),把关键 e2e 纳入
20. GitHub Actions:lint + typecheck + build + unit

---

## 3. 验收标准
- 每个 P0/P1 修复都带**可复现的失败→通过**证据(单测或脚本)。
- `pnpm lint`、`nuxt typecheck`、`aw build` 全绿。
- `scripts/api-live-e2e.mjs` 全 PASS(含修复其自身的 `persisted[0].id` 崩溃)。
- 新增针对性回归脚本全部 PASS。
