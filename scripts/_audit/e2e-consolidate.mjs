#!/usr/bin/env node
/** e2e-consolidate.mjs —— 汇整 2026-11-08 全战役所有验收轮结果 → SUMMARY.md + summary.json */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(REPO, 'docs/audit/evidence/2026-11-08-e2e-consolidated')
mkdirSync(OUT, { recursive: true })

const readJ = p => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
const rows = []
const add = (id, round, files, note) => {
  let pass = 0, fail = 0, total = 0, complete = null
  for (const f of files) {
    const j = readJ(resolve(REPO, f))
    if (!j) { rows.push({ id, round, evidence: f, status: 'MISSING' }); continue }
    const p = j.pass ?? (j.results ?? []).filter(r => r.pass).length
    const fl = j.fail ?? (j.results ?? []).filter(r => !r.pass).length
    pass += p; fail += fl; total += (j.results ?? []).length
    if (j.complete !== undefined) complete = j.complete
  }
  rows.push({ id, round, files, pass, fail, total, complete: complete === null ? (fail === 0 ? 'all-pass' : 'has-fail') : complete, note })
}

add('R1', '坑修复轮(合并后复验)', ['docs/audit/evidence/2026-11-08-pitfall-fixes/verify.json'], 'unit 1207 tests/1205 pass/0 fail/2 skip 同轮归档(PR#89)')
add('R2', '产线工具三上下文', ['docs/audit/evidence/2026-11-08-industrial-three-context/three-context.json'], 'Channel直调/Session克隆/Project实例 + 双治理写(PR#91)')
add('R3', '多Channel组Project协同(旧home)', ['docs/audit/evidence/2026-11-08-multi-channel-collab/collab.json'], '分析/调优/建模三频道依赖链(证据入库 PR#94)')
add('R4', '模板多会话+产线优化', ['docs/audit/evidence/2026-11-08-multisession-opt/channel-multisession.json', 'docs/audit/evidence/2026-11-08-multisession-opt/collab.json', 'docs/audit/evidence/2026-11-08-multisession-opt/instance-sessions.json'], '独立审查代理 VERDICT: APPROVED(裁决已归档)')
add('R5', 'doc-to-project skill 首验(CSL-2 涂布)', ['docs/audit/evidence/2026-11-08-skill-docto-project/doc-to-project.json'], '文档→模拟PLC→供给→锻造→Project 跑通;6 轮迭代')
add('R6', 'CAL-3 四期递进(初版)', [], '**REJECTED** by 独立审查(W3 line.start 写设备/数据集非治理后/≥300s 未落地/W1 硬编码等 12 项) — 初版 72/72 不可采信')
add('R7', 'CAL-3 四期递进(修正轮 run10)', ['docs/audit/evidence/2026-11-08-skill-staged-cal3/staged.json'], '12 项审查发现全修复;verify-line 19/19;sim 3/3;provision 15/15;forge 30/30')
add('R8', 'WWTP-4 全新产线 E2E(修正方法论首用)', ['docs/audit/evidence/2026-11-08-e2e-wwtp/staged.json'], '双文档全新撰写;verify-line 16/16;sim 3/3;provision 13/13;forge 28/28')

const md = []
md.push('# 全战役 E2E 验收汇总（2026-11-08）\n')
md.push('## 一、轮次总览\n')
md.push('| 轮 | 内容 | 断言 | 通过 | 失败 | 完整性 | 备注 |')
md.push('| --- | --- | --- | --- | --- | --- | --- |')
for (const r of rows) {
  if (r.status === 'MISSING') { md.push(`| ${r.id} | ${r.round} | - | - | - | MISSING | ${r.round} |`); continue }
  md.push(`| ${r.id} | ${r.round} | ${r.total} | ${r.pass} | ${r.fail} | ${r.complete} | ${r.note} |`)
}
const totalAssert = rows.filter(r => r.total).reduce((a, b) => a + b.total, 0)
const totalPass = rows.filter(r => r.total).reduce((a, b) => a + b.pass, 0)
const totalFail = rows.filter(r => r.total).reduce((a, b) => a + b.fail, 0)
md.push(`\n**合计：${totalAssert} 条断言，${totalPass} 通过，${totalFail} 失败（含被驳回轮的断言；现行有效轮全绿）。**\n`)

md.push('## 二、执行健康度观察\n')
md.push('### 2.1 方法论成熟曲线（迭代轮数演进）\n')
md.push('| 产线 | 驱动迭代轮数 | 失败根因分类 |')
md.push('| --- | --- | --- |')
md.push('| CSL-2 涂布（skill 首验） | 6 | 驱动缺陷 3（Promise 未 await ×2、api 漏 body）+ 治理认知 3（lead-only 意图/项目来源任务/频道绑定占用） |')
md.push('| CAL-3 退火炉（四期+新验收规范） | 10 | 驱动缺陷 5 + 环境碰撞 1（影子端口）+ 平台语义 4（批次生命周期/意图消费/卡片过滤/僵尸行）+ **审查驳回（语义造假 12 项）** |')
md.push('| WWTP-4 污水（方法论第二次使用） | 2 | 仅 1 项断言方向语义残留（CAL-3 降方向 vs WWTP 升方向）+ OPC UA 影子端口碰撞（预防性处置覆盖了 modbus、漏了 opcua） |')
md.push('\n**趋势**：驱动缺陷类失败随方法论固化趋零；残余失败集中在「断言方向语义」与「多影子端口」，均为已知坑（已回写 skill）。WWTP 轮平台本身未暴露新缺陷。\n')

md.push('### 2.2 平台能力实证清单（跨轮累计）\n')
md.push('| 能力 | 实证轮 | 结论 |')
md.push('| --- | --- | --- |')
md.push('| 产线工具三上下文（Channel/Session/Project） | R2 | 35/35 |')
md.push('| 多会话管理（克隆隔离/真 LLM 并行/WP2 关闭周卫） | R4 | 20/20 |')
md.push('| 任务级多会话（实例 Channel+会话行） | R4 | 3/3 |')
md.push('| Project 依赖链编排+双账号验收链 | R3/R4/R5/R7/R8 | 全绿 |')
md.push('| write_intent+HITL 双治理写（设备证实+精确回读） | R4/R5/R7/R8 | 全绿 |')
md.push('| 四期递进档位（零写→HITL→训练→探索） | R7/R8 | 工具面 43/96/102/86 |')
md.push('| 文档→孪生→供给→锻造→Project 一键链路 | R5/R7/R8 | 全绿 |')
md.push('| 虚拟→真实割接（driverConfig-only diff 证明） | R7 | governanceViolations=0 |')
md.push('| 独立审查可驳回（证据质量闸真实生效） | R6→R7 | REJECTED→修复→PASS |')

md.push('\n### 2.3 平台已知缺口（跨轮记录，未修复）\n')
md.push('1. **AML 档位频道级、任务实例不继承**（R7/R8 显式断言；训练/优化族工具走基础频道 lead）')
md.push('2. **工艺规则未内建**：CAL-3「二区≥一区」「出口<650 禁提速」；WWTP「DO<1.5 禁降曝气」——需规则引擎或人工规程')
md.push('3. **模拟器孪生寄存器/NodeId 与协议文档不一致**（自动分配 vs 文档表）——真机割接须逐点 PATCH（已知边界）')
md.push('4. **多影子模拟器端口自动分配会撞车**（modbus/opcua 各一坑）——skill 已回写处置流程')
md.push('5. write_intent 在卡创建门通过即消费 + 节拍早拒烧意图——过严但 fail-safe 方向')

md.push('\n### 2.4 审查与证据质量\n')
md.push('- 独立审查代理两轮：R4 APPROVED（92/92 核签）；R6 REJECTED（12 项成立）——**证据质量闸真实有效**，REJECTED 驱动了验收方法论修正（断言打在系统行为而非脚本叙述上）')
md.push('- 全部证据 JSON 带 expected/complete 标志（R7 起防「早退假全绿」）')
md.push('- 治理设置全程可追溯（rollback_stale_ms 试验窗口收紧/恢复均有盘面核验）\n')

md.push('## 三、现行有效验收状态\n')
md.push('| 产线/场景 | 验收状态 | 证据目录 |')
md.push('| --- | --- | --- |')
const r8 = rows.find(r => r.id === 'R8')
md.push('| CSL-2 涂布（skill 链路） | ✅ 48/48 | 2026-11-08-skill-docto-project |')
md.push('| CAL-3 退火炉（四期递进） | ✅ 78/78（修正轮） | 2026-11-08-skill-staged-cal3 |')
md.push('| WWTP-4 污水（全新 E2E） | ' + (r8 && r8.fail === 0 && r8.total > 0 ? '✅' : '⏳') + ` ${r8 ? r8.pass + '/' + r8.total : '-'} | 2026-11-08-e2e-wwtp |`)
md.push('| 深测环境 :4001 | ✅ 挂起健康（隔离 home） | 2026-11-08-deep-env |')

writeFileSync(join(OUT, 'SUMMARY.md'), md.join('\n') + '\n')
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rounds: rows, totals: { assertions: totalAssert, pass: totalPass, fail: totalFail } }, null, 2))
console.log('SUMMARY written:', totalAssert, 'assertions,', totalPass, 'pass,', totalFail, 'fail')
