# v0.7.71 发布验收报告(全功能回归 + 文档一致性)

- 日期:2026-10-24
- 版本:0.7.70 → **0.7.71**
- 范围:自 0.7.70 发布(2026-10-21)后的全部交付——①工艺优化器与求解器(optimizer/process-model 总计划 M0–M6 主链);②求解器功能测试体系;③工具面声明式治理(WP1–WP9);④本轮全量回归 + 文档对齐

## 1. 测试总表(2026-10-24 本机实测)

| # | 套件 | 命令 | 结果 |
|---|---|---|---|
| 1 | 全量单测 | `npm run test:unit` | **444/444**(0 fail) |
| 2 | 求解器数值矩阵(真实 OSQP 1.1.3 / SciPy 1.14.1) | `tests/optimizer_solver_matrix.py`(AML venv) | **34/34** |
| 3 | MCP 实机(隔离实例 3461) | `npm run test:mcp-live` | **34/34** |
| 4 | 工具注册表实机(隔离实例) | `node scripts/tool-registry-e2e.mjs` | **56/56** |
| 5 | 求解器/过程模型验收(隔离临时库) | `npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/acceptance-optimizer-process-model.ts` | **67/67** |
| 6 | 产线治理 E2E(隔离实例) | `npm run test:e2e-line` | **44/44** |
| 7 | 多 Agent 工具面实机(隔离实例) | `node scripts/e2e-tool-surface-multiagent.mjs` | **37/37** |
| 8 | 优化器+求解器+AML 实机(自引导实例) | `npx tsx scripts/e2e-optimizer-live.mjs` | **104/104**(keepalive 轮同 104/104,独占负载复跑) |
| 9 | API 面(隔离实例 3060) | `AW_BASE=… node scripts/api-live-e2e.mjs` | **60 PASS + 2 SKIP** / 0 FAIL(SKIP=新用户无历史 channel 的重启持久化项,由独立重启演练覆盖) |
| 10 | 系统 UI Playwright(隔离实例 3055) | `scripts/ui/system-e2e-playwright.py` | **205/205**(27 路由/27 截图) |
| 11 | 优化器 UI Playwright(keepalive 实例 3997) | `scripts/ui/optimizer-ui-playwright.py` | **11/11**(真实求解触发 + optimal 行 + 已验证推荐徽章 + 无 pageerror/5xx) |
| 12 | 文档一致性 | `npm run docs:check` | **91/91**(0 失败) |
| 13 | 文档站构建 | `npm run docs:build` | ✔ complete |
| 14 | 类型检查 | `npm run typecheck` | ✔ |
| 15 | 生产构建 | `npm run build` | ✔ exit 0 |

**合计 ≈ 1080+ 断言,0 失败**(唯二 SKIP 为环境条件项,如实披露)。

## 2. 求解器与 AML 集成的验收口径(用户专项要求)

- **求解器功能**:协议面(ready/pid/PROTOCOL_MISMATCH/UNKNOWN_OP/BAD_JSON/SOLVER_BUSY/stdout NDJSON 纯净)、池化并发、超时降级 503、数值矩阵 34 例(MPC 解析解/边界/不可行/终端权重/确定性 + Static 经济角点/二次/交叉/单位一致性)+ NaN/Inf fail-closed——全部绿(#2/#5)。
- **AML 集成**:训练门禁(G1–G3,rollout ≥20%)、Profile 冻结、绑定授权面、twin gate、optimizer_solve→交叉核验(maxDev=0)→HITL 卡→批准→D13 八重复核→设备写 37 回读→审计 request+execute——#8 的 104 断言闭环覆盖;AML 单测(数据集/作业/门禁/混合孪生/UQ)含于 #1 的 444。
- **真实数据诚实基线**:2026-10-23 轮已证明真实 PLC 噪声数据上资格门/训练门**如实拦截**(MV_INSUFFICIENT_EXCITATION/G2 -9.9%),数值绿链以受控数据 #5/#8 为准——门禁工作正确本身就是集成正确的证据。

## 3. 补记(执行时序)

- #11 optimizer UI:首轮因**陈旧 keepalive 文件**(上一轮遗留,指向已死实例)失败;清测试端口残留(3990–3997)并删除陈旧 json 后,以「json 年龄 <60s」为新鲜判据重跑——keepalive 轮 e2e 104/104 + UI 11/11。中间一轮 89/90 的唯一失败为脚本内 UI 探针导航超时(与 docs:build 并发抢 CPU 所致,功能断言 89 项全过),独占负载复跑即满绿。
- #9 api-live 的 2 个 SKIP 为环境条件项(新注册用户无历史 channel-with-lead 可探),非回归。
- 端口纪律:全程仅使用 3055/3060/3461/3990–3999 测试端口与各自临时 AW_HOME,未触碰 3000/3001 常驻实例;每套件结束 taskkill //T 清场。

## 4. 文档一致性(v0.7.71)

- README.md / README-zh.md:版本徽标与文末当前版本 → 0.7.71;宿主工具 **91→92**(新增 `industrial_resources`);en 侧设置项 119→126;新增特性行「工艺优化器与求解器(v0.7.71)」;预检行补 references 声明化;MCP 网关行补每 Agent 全量工具 stdio 桥(ETag/304)。
- docs/site/index.md(zh/en):版本 → 0.7.71;新增 OPT/GOV 两张特性卡;设置项口径 126/19 组已在位。
- docs/cli(.en).md / sdk(.en).md / plugins(.en).md:版本字符串与 npx 锁定示例 → 0.7.71;六对站点副本逐字节重新同步。
- `docs:check` 91/91(版本全链门:config.yml = package.json = README ×2 = 站点 zh/en);`docs:build` 成功。
- config.yml `app.version` → 0.7.71(package.json 为权威,此为回退字段同步)。
