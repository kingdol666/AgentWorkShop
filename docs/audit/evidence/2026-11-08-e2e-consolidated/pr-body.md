# 全功能验收战役入库（2026-11-08）

## 内容

### 1. Skill
- **新增 `aw-doc-to-project`**：三门 ask 门（意图澄清/蓝图审签/投用裁决）+ 四期递进档位（零写→HITL→训练→探索）+ 项目内治理写拓扑 + 割接七步；双副本同步
- `aw-line-onboarding` 增补交叉引用（多频道组 Project 由编排 skill 接管）
- 房规校验 **167/167**（`node scripts/test-aw-skills.mjs`）

### 2. 驱动脚本（`scripts/_audit/`，全部幂等可重跑）
| 脚本 | 覆盖 | 结果 |
| --- | --- | --- |
| `channel-template-multisession-live.mjs` | 模板实例化多会话+产线集成 | 20/20 |
| `instance-session-check.mjs` | 任务实例会话行（任务级多会话） | 3/3 |
| `doc-to-project-live.mjs` | CSL-2 涂布文档→Project 全链 | 48/48 |
| `cal3-staged-live.mjs` | CAL-3 退火炉四期递进（修正轮） | 78/78 |
| `wwtp-staged-live.mjs` | WWTP-4 污水全新产线 E2E | 78/78 |
| `e2e-consolidate.mjs` | 全战役汇整器 | 415/415 |

### 3. 证据（`docs/audit/evidence/2026-11-08-*`）
| 目录 | 内容 |
| --- | --- |
| `deep-env` | 深测环境档案（:4001 隔离 home） |
| `multisession-opt` | 92/92 + 独立审查 APPROVED 裁决 |
| `skill-docto-project` | 48/48 + 交接声明 |
| `skill-staged-cal3` | 78/78 修正轮 + **REJECTED 裁决存证** + 割接 diff |
| `e2e-wwtp` | 78/78 + 双文档 + 交接声明 |
| `e2e-consolidated` | 全战役汇整 415/415（SUMMARY.md） |

### 4. 其他
- `.gitignore` 增补 `.deep-home-*/`（运行时数据不入库）

## 验收口径（如实）
- CAL-3 初版 72/72 被独立审查 **REJECTED**（12 项成立，裁决全文存证）；修正轮 78/78 才是有效证据
- 全部断言为真实系统输出（治理闸/设备写入/审批链真实），编排为 mock 确定性档
- 已知缺口在 README/handover 如实列明（AML 档位实例不继承/工艺规则未内建/寄存器映射与文档不一致等）
