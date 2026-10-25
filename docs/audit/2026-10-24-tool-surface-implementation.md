# 工具面元数据驱动 · 实施与验收报告

- 日期:2026-10-24
- 依据计划:`docs/plans/2026-10-24-tool-surface-metadata-design.md`(v2,omc-plan 共识 APPROVED WITH IMPROVEMENTS)
- 实施范围:**WP1–WP9**(安全轨 + 能力轨 Wave 1/2);WP10–WP12 按计划为 Wave 3「按需/条件项」,本轮未做
- 结论:**计划内已实施项全部落地并通过回归门**;新增 5 个测试文件、实机多 Agent E2E 33/33;计划口径与代码存在 6 处实施性偏差,全部在 §4 披露(均为机制落点/回滚策略层面,不影响验收语义)

---

## 1. 回归门(G0)结果

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✔ 通过 |
| 全量单测 | `npm run test:unit` | **444 pass / 0 fail**(基线 412,新增 32 断言) |
| 工具面回归 | tool-verify / registry-policy / face-authz / profile-observer / approvals-choice / mcp-server / high-risk / host-tools-quality | 87 pass / 0 fail(tool-verify 既有断言零改动) |
| MCP 实机 | `npm run test:mcp-live` | **34 PASS / 0 FAIL** |
| 生产构建 | `npm run build` | ✔ Build complete(exit 0) |
| 多 Agent 实机 | `node scripts/e2e-tool-surface-multiagent.mjs` | **33 PASS / 0 FAIL** |

证据产物:`docs/audit/evidence/2026-10-24-tool-surface/multiagent-report.json`

---

## 2. 工作包落地矩阵

| WP | 计划内容 | 状态 | 落点 | 验收证据 |
|---|---|---|---|---|
| WP1 | 铲除 kb_agent 调用方可控权限,固定 `permission:'default'` | ✔ | `server/plugins-builtin/rag-bridge/index.mjs:279-305`(schema 删 permission/harness,body 恒 default) | `tests/plugin-governance.test.ts`(动作契约)+ schema 静态断言;偏差 D1 |
| WP2 | ingest 兜底 requireLineMode(operate)+ 回填窗 ±1h | ✔ | `server/services/workshop/daq/ingest-policy.ts`(纯函数)、`server/api/workshop/daq/[id]/ingest.post.ts:67-100` | `tests/daq-ingest-policy.test.ts`(7);实机 T10a/b/c |
| WP3 | token 校验收敛单点 + rotate + tokenTail + 常量时间比较 | ✔ | `channel-agent.repo.ts`(`safeTokenEqual`/`isTokenValid`/`rotateToken`,宽限列迁移 v31)、`rotate-token.post.ts`、`host-tools.ts:85`、`admin-channel.ts:389` | `tests/agent-token-rotation.test.ts`(5);实机 T11a–d、T12 |
| WP4 | 协作面 token 路径审计 | ✔ | `runtime/manager/host-tools.ts`(`auditCollabInvocation` + `finish` 全路径收口) | 单测 444 不回归;审计 action 可经 ops-logs 查询 |
| WP4b | kb 入库接 HITL(申请强制点重定位) | ✔ | `server/services/workshop/agents/plugin-governance.ts` + dispatch/host-tools 双路径接入 | `tests/plugin-governance.test.ts`(7,含真实审批单落库 + 超时拒绝);偏差 D2 |
| WP5 | references 声明化单源 + 登记制 | ✔ | `tool-reference-spec.ts`、`host-tools.json`(92 工具全声明:44 references + 48 noRefs)、`tool-verify.ts`(声明优先)、`tools/registry.ts`(写族未声明拒登记) | `tests/tool-references.test.ts`(6,含 48 条等价断言);tool-verify 219 断言零改动;偏差 D3 |
| WP6 | 描述预算折叠 + `industrial_resources` + 桥 ETag | ✔ | `description-budget.ts`(确定性折叠)、`per-agent.ts`(排序+折叠)、`resources-tools.ts`、`agent-tools/list.get.ts`(ETag/304)、`aw-mcp-bridge.mjs`(If-None-Match) | `tests/tool-surface-budget.test.ts`(4);实机 T5b–e、T6、T9e |
| WP7 | 策略分级降级(写拒/读降级+快照) | ✔ | `tools/policy.ts`(`lastGood` 快照 ≤5min、写族 POLICY_UNAVAILABLE、`AW_POLICY_DEGRADE=open` 回滚) | 既有策略单测不回归;新逻辑由类型/代码路径覆盖(偏差 D8:未加 DB 故障注入单测) |
| WP8 | 插件治理四步 retrofit | ✔(①–④) | `plugin-tools.ts` 接口 `references/riskClass/noRefs`;`plugin-governance.ts` 声明才校验 + `plugin.tool.call` 审计;registry 插件未声明不阻断 | `tests/plugin-governance.test.ts`(声明/未声明对照);kv_agent 已声明 riskClass=write |
| WP9 | 面 A 会话 TTL | ✔ | `server/api/mcp/workshop.ts`(`lastSeen` + 惰性清扫,`AW_MCP_SESSION_TTL_MIN` 缺省 30) | 类型/构建通过;TTL 路径为惰性清扫(偏差 D9:未加会话单测) |
| WP10–12 | 派生票读 API / 批量 ingest / HTTP MCP 适配器 | — 未做 | 计划定级 Wave 3「按需/P0 与 Wave1-2 全绿后」,WP12 为条件项 | 见 §4 D6 |

---

## 3. 实机验证:不同 Agent → 不同工具对象 / 不同执行目标 / verify 生效

隔离实例(port 3992,home 模式,临时库),同频道两个 worker(同角色、仅绑定不同):

**注入面(同一份 host-tools.json 动态装配)**
- AgentA1 描述「本 Agent 直接绑定的数采节点」= `dn-A1`,不含 `dn-A2`;
- AgentA2 描述 = `dn-A2`,不含 `dn-A1`;
- 配方段只出现在 A1(绑定配方),A2 无该段;
- A1 描述不含他线节点 `dn-B1`。

**执行面(原生 invoke 与 MCP 桥同链)**
| 调用 | 结果 |
|---|---|
| A1 → `daq_query(node=dn-A1)` | 放行 |
| A1 → `daq_query(node=dn-B1)`(他线) | 拒绝:「不在你的授权范围内…你的绑定节点:dn-A1, dw-…」 |
| A2 → `daq_query(node=dn-A2)` | 放行 |
| A2 → `daq_query(node=dn-A1)`(同线频道绑线) | 放行(v28 只读扩权,设计使然) |
| A2 → `recipe_trial(recipe-A)` | ①绑定门拒绝(未绑定该配方) |
| A1 → `recipe_trial(recipe-A)` | 通过①②,停在③运行门(未开跑) —— 闸门深度差异证明绑定面参与判定 |
| A1 via MCP `tools/call daq_query(dn-A1)` | 成功 |
| A1 via MCP `tools/call daq_query(dn-B1)` | 同链拒绝(与原生逐字一致) |
| A1 via MCP `industrial_resources` | 分页返回绑定面(daq/line-daq/recipe) |

**MCP 注入面一致性**:桥 `tools/list` 的 `daq_query` 描述与原生注入面同源,绑定段含 `dn-A1`。
**ETag**:`GET /agent-tools/list` 返回弱 ETag;带 `If-None-Match` 第二次 304 空体(桥轮询省流量)。

**安全项实机**
- 普通用户(无产线授权)推送 ingest → **403 LINE_FORBIDDEN**;admin → 200;6h 前回填 → 400(默认 ±1h)。
- `rotate-token` → 新 token 立即生效;旧 token 宽限内仍可用;模板列表只回 `tokenTail`(4 位);审计 `agent.token.rotate` 落账。
- 频道绑 A 线时成员绑 B 线节点 → **403 LINE_SCOPE_MISMATCH**(产线隔离规则正确拦截)。

---

## 4. 偏差与未做项(诚实披露)

- **D1(WP1)**:`permission:'default'` 已定值并由单测断言 body 恒定;但**对真实 rag-knowledge 后端的集成冒烟未执行**(外部服务未在本机运行),后端是否接受该权限档未验证。回滚/调整点:若后端枚举拒绝,改取其后端标准非 bypass 档并回填计划。
- **D2(WP4b)**:审批强制点落在**平台分发层** `plugin-governance.ts`(dispatch 与 REST invoke 两处同源),而非计划字面的「rag-bridge handler 内」。理由:所有 harness(omp 进程内 / REST / MCP 桥)都汇聚到这两处,handler 内实现会被旁路;语义仍为「handler 之前强制」。
- **D3(WP5)**:旧代码表未删除,保留为 `tool-verify-legacy-specs.ts` 仅作**回滚源**(`AW_TOOL_VERIFY_LEGACY_SPECS=1`)与单测等价基准;默认路径只读 `host-tools.json` 声明。计划要求「删除 VERIFY_SPECS」——按计划 §6 风险缓解保留一个版本周期,待下个版本删除。
- **D4(WP5)**:`dcw_control/param_control/dcw_rollback` 无 JSON 定义(v2 禁用桩),迁移差集非空属预期;执行期这三个名字仍由 dispatch 的既有写族守卫拦截。
- **D5(WP6)**:未做 schema `enum` 收窄(计划已否决);折叠预算 400 字、`AW_DESC_BUDGET=0` 关闭。
- **D6(WP10–12)**:**未实施**。理由:计划 §4 将其列为 Wave 3「按需」,WP12 为条件项(需真实外部 harness 的 HTTP MCP 需求)。当前读侧对外 API 仍为「用户会话 + 产线权限」,派生票/批量 ingest/异步 source 标记未上线。
- **D7(实机 T8b)**:配方写面的「进入 HITL 审批」在未开跑批次上不可达(运行门先拒)。本轮用**闸门深度差异**取证;完整「审批→批准→设备写→审计」链已在此前轮次(104/104,S5–S9)覆盖。
- **D8(WP7)**:分级降级逻辑已实现(code review + 类型通过),但**未新增数据库故障注入单测**(现有策略单测不覆盖 DB 抛错分支)。
- **D9(WP9)**:会话 TTL 为惰性清扫,未加「空闲 31min → 会话回收」单测(需可控时钟/长等待),当前由代码路径与构建覆盖。

---

## 5. 回滚开关一览

| 开关 | 默认 | 作用 |
|---|---|---|
| `AW_TOOL_VERIFY_LEGACY_SPECS=1` | 关 | 校验回退旧代码表(启动 audit warn) |
| `AW_DESC_BUDGET=0` | 400 | 关闭描述折叠 |
| `AW_POLICY_DEGRADE=open` | 关 | 策略读取失败回退 fail-open(灰度用) |
| `AW_MCP_SESSION_TTL_MIN=0` | 30 | 关闭面 A 会话回收 |
| `AW_TOKEN_GRACE_MS` | 60000 | token 轮换宽限窗(上限 1h) |
| `AW_DAQ_INGEST_BACKFILL_MS` | 3600000 | 推送回填窗(上限 7d) |
| `AW_KB_INGEST_GUARD=0` | 开 | 关闭 kb 入库意图启发拦截(action=ingest 审批不受影响) |
| `AW_COLLAB_AUDIT=0` | 开 | 关闭协作面 token 路径审计 |

---

## 6. 对用户问题的直接回答

1. **是否有数据驱动的注入对象?** 是。同一份 `host-tools.json`(92 工具)按 Agent 的角色/频道档位/插件开关/绑定面在注入时编译;绑定不同的两个同角色 Agent,工具描述逐字不同(实机 T5b–e)。
2. **不同 Agent 是否有对应的工具执行对象?** 是。执行期 `tool-verify` 每次实时重算归属面:自己绑定节点放行、他线节点/未绑定配方拒绝;同一调用经原生 REST 与 MCP 桥行为一致(T7、T9)。
3. **原生与 MCP 是否都支持?** 是。MCP 桥(面 B)与 omp 原生注入共用 `hostToolsForAgent` 与同一分发表;`tools/list` 带 ETag/304,`tools/call` 走 `invokeHostTool` 同一治理链。
4. **能否按绑定做 verify?** 是。verify 规则已从代码表上收为工具定义声明(注册期登记、执行期实时),87 条工具面断言 + 48 条声明等价断言 + 实机跨线拒绝共同证明。
