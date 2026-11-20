# TSA4 live acceptance round report (v0.14.0)

- Generated: 2026-11-20T11:24:54.022Z
- Evidence dir: docs/audit/evidence/2026-11-20-tsa4-v0140-round (64 JSON files)
- Build: v0.14.0 (origin/main a18c7576) on persisted home D:/tmp/aw-liv2-1119/home

## L1 stack & bridges
- AW version: 0.14.0; experience-stats rows: 3; anon read: see phase-s-experience-anon.json
- Bench run recorded: yes; host-provenance gate: ["BENCH_NOT_HOST_PROVENANCED: 客户端自报评测只读展示,不得作为 active 晋级证据"]
- Write-attempt ledger before/after restart: {"verified":217} → {"verified":217} (must be identical; no auto-resend)
- RTU probe after-state: [{"id":"dw-b4fd1365","name":"冷却流量SP","value":15},{"id":"dw-a197071e","name":"冷却流量SP","value":null}]

## Capability answers
- 产线数采数控: see c1/c2/c3 evidence + smoke readback (this report links files, does not re-judge them)
- Project 编排: see dispatch-result.json / projects-watch.json / per-item terminal evidence
- Channel 内部/间通讯: see xch-*.json
- 经验记忆管理: see c4-*.json / phase-s-experience-*.json

## Defect regression table
| Defect | Last known | This round | Fixed? |
| --- | --- | --- | --- |
| DEF-20261120-RTU-POOL-PENDING | silent offline | see rtu-*.json | from evidence |
| plan-card visibility gap | pending card invisible | see projects-watch.json planProgress.pendingApprovalId | from evidence |
| artifact resubmission gap | blocked legacy item | new-item route exercised (dispatch-result.json) | route OK, legacy items stay blocked |

> 裁决口径:每条结论引用本轮证据文件;NOT_RUN/PARTIAL 如实标注,不复制历史基线。