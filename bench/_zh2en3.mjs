import { readFileSync, writeFileSync } from 'node:fs'

const f = 'bench/lib/governance.mjs'
let t = readFileSync(f, 'utf8')
const before = (t.match(/[一-龥]/g) || []).length
const MAP = [
  ['(1) 初始版本数 ${v0.length}，当前参数值 ${v0val}', '(1) initial versions ${v0.length}, current param value ${v0val}'],
  ['(2) 编辑后版本 ${v1.length}（+1），参数值 ${v1val}（期望 ${v2}）', '(2) versions after edit ${v1.length} (+1), param value ${v1val} (expected ${v2})'],
  ['bench 回退验证', 'bench rollback verification'],
  ['(4) 回退到 v1 后版本 ${v2list.length}（+1，非破坏），参数值 ${v2val}（期望回到 ${v0val}）', '(4) versions after revert-to-v1 ${v2list.length} (+1, non-destructive), param value ${v2val} (expected back to ${v0val})'],
  ['(5) 基准恢复 rollback-good → 下发 ${outcomes.length} 个参数（status ${rbGood.status}）', '(5) baseline restore rollback-good → applied ${outcomes.length} params (status ${rbGood.status})'],
  ['rollback-good 失败: ', 'rollback-good failed: '],
  ['apply → new batch ${newRunId ?? \'（无）\'}（status ${apply.status}）', 'apply → new batch ${newRunId ?? \'(none)\'} (status ${apply.status})'],
  ['配方一键下发失败: ', 'recipe one-click apply failed: '],
  ['写 ${target} 生效（回读 ${mid}，写前 ${before}）', 'write ${target} effective (readback ${mid}, before ${before})'],
  ['回退后回读 ${after}（应回到 ${before}，容差 0.75）', 'readback after rollback ${after} (expected back to ${before}, tolerance 0.75)'],
  ['优化记录\\s+([A-Za-z0-9._:-]+)\\s+已开窗', 'optimization record\\s+([A-Za-z0-9._:-]+)\\s+opened'],
  ['当前值 ${cur} → 记录 A 写 ${up}（上行）、记录 B 写 ${down}（下行），方向相反以规避回退冷却', 'current ${cur} → record A writes ${up} (up), record B writes ${down} (down); opposite directions to dodge the rollback cooldown'],
  ['(keep 路径) 记录 ${recA} 判定 keep → ', '(keep path) record ${recA} verdict keep → '],
  ['(keep 路径) 未取得 record_id；回执：', '(keep path) no record_id; receipt: '],
  ['(rollback 路径) 记录 ${recB} 判定 rollback（仅入册，PLC 值仍 ${beforeRollback}）', '(rollback path) record ${recB} verdict rollback (recorded only; PLC still ${beforeRollback})'],
  ['执行回退（status ${ex.status}）→ 回读 ${afterRollback}（应回到记录 B 的 from=${up}）', 'rollback executed (status ${ex.status}) → readback ${afterRollback} (expected record B from=${up})'],
  ['(rollback 路径) 未取得 record_id；回执：', '(rollback path) no record_id; receipt: '],
  ['裁决 approved（status ${d.status}）→ 挂起的下发**解阻塞**：', 'verdict approved (status ${d.status}) → pending write **unblocked**: '],
  ['批准后 PLC 实际生效：回读 ${got}（期望 ${target}）', 'post-approval PLC effect: readback ${got} (expected ${target})'],
  ['审计 audit：全局 ${entries.length} 条', 'audit: ${entries.length} entries'],
  ['运维日志 ops-logs：全局 ${logs.length} 条', 'ops-logs: ${logs.length} entries'],
  ['取某产线当前活动批次（endedAt 为空）', 'active batch of a line (endedAt empty)'],
  ['治理只读面：journal 账本 + audit 审计 + ops-logs 运维日志', 'governance read surfaces: journal + audit + ops-logs'],
]
for (const [a, b] of MAP) t = t.split(a).join(b)
writeFileSync(f, t)
console.log('governance zh chars:', before, '→', (t.match(/[一-龥]/g) || []).length)
