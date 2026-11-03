# bench/results — 有效结果索引(2026-11-02 收敛)

> 本目录只保留**可用于论文/审计的最新有效运行**。过时或无效运行已移出;历史 10 月结果在
> `paper/tii/_archive-submission-2026-11-02/`(提交归档)或 git 历史中。

## 论文证据(2026-11-01 最终批次,已进 S7 `01-paper-evidence/`)

| 组 | runId | 用途 |
| --- | --- | --- |
| 集成流水线 ×2 | `20261101103641-9j8`、`20261101104849-xu0` | 77/0/0 ×2;commit `da627d21`;`agentHarness=(none)` |
| E1 场景×协议探针 | `20261101121221-scenario-probes` | 220/220 受理、219/219 拒绝、216/216 回读(4 场景子集) |
| E1 被排除记录 | `20261101121700-scenario-probes` | cast-film 记录;manifest/端点不匹配,S7 明确排除,保留审计 |
| E2 C1 脚本策略 | `20261101110211…111330-optcontrol-c1`(5 个) | 5 seed,3 场景,15/15 入带 |
| E2 C0 不写对照 | `20261101111725…112947-optcontrol-c0`(5 个) | 5 seed,3 场景,0/15 入带 |
| E4 四臂消融 | `20261101103356-e1lite` | full/no-readback/no-interlock/ungated |
| E4 生产态五层 | `20261101113644-production-guards` | 间隔/步长/量程/配方窗/保持窗 |
| E3 审批 pilot | `20261101121436-approval-gate` | manual vs auto 配置级 |
| E4·L1 授权 | `20261101121415-authorization` | 未绑定拒/绑定放行/跨节点拒 |
| 静态/PLC 层 | `20261101113852-eeg`、`20261101103243-152k` | 静态 100/100;PLC 层 |
| 双跑复现 | `compare-pipeline-1793530926569.md` | REPRODUCIBLE |

## 2026-11-02 C3 活体 Agent pilot(负结果,已进 S7 `02-c3-pilot-negative/`)

| runId | 结果 |
| --- | --- |
| `20261102103306-agent-multiround` + `-1dj8-optloop` | 无 activate:任务 SUBMITTED,0 写 |
| `20261102103639-agent-multiround` + `-tkc-optloop` | activate+reassign:任务 COMPLETED,但 0 写、PV 31.28 g 未入带 |
| `20261102104327-agent-multiround` + `-19hc-optloop` | 任务书入 description:worker 报 `No such tool: xd://dcw_control` |
| `20261102105040-agent-multiround` + `-1c9c-optloop` | `rpcMode` 修复:有工具、完成取证,但 15 min 0 写,`BUDGET_TIMEOUT` |

**结论**:C3 不可用于论文阳性主张;平台侧阻塞见
`docs/audit/evidence/2026-11-02-experiment-pipeline-v2/REPORT.md`。

## 已移出

- `20261102103125-scenario-probes`:未知场景 `cast-film` 被静默过滤后 **0/0 假 PASS**;
  已移到 `docs/audit/evidence/2026-11-02-experiment-pipeline-v2/invalid-false-pass-run/`,
  并已修好 runner 的 fail-closed。
- 2026-10 及更早的历史运行:不在本目录;需要时从 git 历史取。
