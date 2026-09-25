/** 临时:把 0.7.48/0.7.49 实测行追加到 README 双语验收表(锚定 stage6c 行之后) */
import { readFileSync, writeFileSync } from 'node:fs'

const zhRows = [
  '| `_aw0748-failclosed-probe.mjs` | **7 / 0**（2026-09-25,v0.7.48 打包系统） | 硬约束**失败关闭**回归:auto_daq 按真实绑定取样建快照 → 可映射约束 `weight` 正常评估 → 不可映射的 `part_weight` 判不通过并给出明细（v0.7.47 会假通过）→ 空轨迹同样判不通过 | `AW_BASE=<base> node scripts/_aw0748-failclosed-probe.mjs` |',
  '| `_aw0748-mock-closedloop.mjs` | **11 / 0**（2026-09-25,v0.7.49 打包系统,进程内 `mock`,零额度） | 调度闭环回归:创建 mock Channel → 根任务被真实派发并收口 → `[mock:complex]` 强制委派出子任务 → 父任务汇总收口 → **第二个/第三个根任务同样被派发**（修复前:lead 空闲卸载后 `scheduler` 置空,后续根任务只落库、一直 SUBMITTED 直到 `ROOT_TIMEOUT`）→ mock 无 host tool 通道时工具桥显式拒绝 | `AW_BASE=<base> node scripts/_aw0748-mock-closedloop.mjs` |',
]
const enRows = [
  '| `_aw0748-failclosed-probe.mjs` | **7 / 0** (2026-09-25, v0.7.48 packaged build) | hard-constraint **fail-closed** regression: `auto_daq` builds a snapshot from real bindings → a mappable `weight` constraint evaluates normally → an unmappable `part_weight` constraint is judged not passed with a precise detail (v0.7.47 passed it falsely) → an empty trajectory is also judged not passed | `AW_BASE=<base> node scripts/_aw0748-failclosed-probe.mjs` |',
  '| `_aw0748-mock-closedloop.mjs` | **11 / 0** (2026-09-25, v0.7.49 packaged build, in-process `mock`, no quota) | scheduler closed-loop regression: create a mock channel → the root task is genuinely dispatched and closed → `[mock:complex]` forces delegation into child tasks → the parent closes after they finish → **the second and third root tasks are dispatched too** (before the fix the lead was unloaded while idle, `cr.scheduler` became null and later root tasks only landed in the DB, sitting in SUBMITTED until `ROOT_TIMEOUT`) → the tool bridge explicitly rejects host tools for mock | `AW_BASE=<base> node scripts/_aw0748-mock-closedloop.mjs` |',
]

for (const [file, anchor, rows] of [
  ['README-zh.md', '| `_aw0746-stage6c-jobsmoke.mjs` |', zhRows],
  ['README.md', '| `_aw0746-stage6c-jobsmoke.mjs` |', enRows],
]) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const i = lines.findIndex(l => l.startsWith(anchor))
  if (i < 0) throw new Error(`anchor not found in ${file}`)
  lines.splice(i + 1, 0, ...rows)
  writeFileSync(file, lines.join('\n'), 'utf8')
  console.log(`inserted ${rows.length} rows after line ${i + 1} in ${file}`)
}
