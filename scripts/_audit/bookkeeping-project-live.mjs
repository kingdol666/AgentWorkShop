#!/usr/bin/env node
/**
 * bookkeeping-project-live.mjs —— 终验B:Project 通用开发场景(非产线域)。
 *
 * 场景:以「开发一个记账软件」为案例,验证 Project 的通用任务编排能力:
 *   需求频道(W1 规格) → 开发频道(W2 源码) → 测试频道(W3 测试报告),dependsOn 依赖链,
 *   technical 路由 + 双账号 L1/L2 验收,最终项目 completed。
 *
 * 真实性口径(如实):
 *   - 编排骨架/mock lead 与治理链(HITL 无关,本场景无设备写)是真实的;
 *   - **源码由本驱动经真实文件写入 workspace 产生**(不是 LLM 自主编码)——本驱动替代 mock worker
 *     承担"开发者"角色,产物是可运行的 Python 记账 CLI,并由真实 `python` 执行验证;
 *   - 产物以工件形式收口 root,进入 Project 成果/验收链。
 *
 * 用法:node scripts/_audit/bookkeeping-project-live.mjs --base http://127.0.0.1:4001
 * 证据:docs/audit/evidence/2026-11-08-final-acceptance/bookkeeping.json
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = (arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:4001')).replace(/\/$/, '')
const EVID = resolve(arg('out', join(REPO, 'docs/audit/evidence/2026-11-08-final-acceptance')))
mkdirSync(EVID, { recursive: true })
const APP = resolve(EVID, 'artifacts', 'ledger-app')
mkdirSync(APP, { recursive: true })

let tokenA = ''
let tokenB = ''
const results = []
const step = (id, name, ok, detail = '') => {
  results.push({ id, name, pass: Boolean(ok), detail: String(detail ?? '').slice(0, 700) })
  console.log(`${ok ? '✔' : '✖'} [${id}] ${name}${ok ? '' : ` — ${String(detail ?? '').slice(0, 220)}`}`)
  return Boolean(ok)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, opts = {}) {
  const t = opts.user === 'B' ? tokenB : tokenA
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const j = await res.json().catch(() => null)
  return { status: res.status, data: j?.data, code: j?.code, message: j?.message ?? '' }
}
async function invoke(agentId, tool, argsTool = {}, timeoutMs = 180_000) {
  const res = await fetch(`${base}/api/workshop/agent-tools/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ agentId, tool, args: argsTool }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const okHttp = res.ok && String(res.headers.get('content-type') ?? '').includes('json')
  if (!okHttp) return { status: res.status, isError: true, text: `HTTP ${res.status}` }
  const j = await res.json().catch(() => null)
  return { status: res.status, isError: Boolean(j?.data?.result?.isError), text: String(j?.data?.result?.text ?? '') }
}
async function poll(fn, timeoutMs = 60_000, interval = 1500) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(interval) }
  return null
}
async function acceptanceChain(pid, wid, summary, tag) {
  const draft = await poll(async () => {
    const rows = (await api('GET', `/api/workshop/projects/${pid}/results`)).data ?? []
    return rows.find(r => r.workItemId === wid && r.status === 'draft') ?? null
  }, 30_000)
  if (!step(`${tag}-s1`, `${tag} draft 物化(交付物=真实工件)`, Boolean(draft?.id), JSON.stringify(draft ?? {}).slice(0, 110))) return null
  const sub = await api('POST', `/api/workshop/projects/${pid}/results/${draft.id}/submit`, { summary: summary.slice(0, 4000) })
  if (!step(`${tag}-s2`, `${tag} owner 提交`, sub.status === 200, sub.message)) return null
  const rev = await api('POST', `/api/workshop/projects/${pid}/results/${draft.id}/review`, { decision: 'reviewed', reason: `${tag} L1 技术评审(独立评审)` }, { user: 'B' })
  if (!step(`${tag}-s3`, `${tag} L1 技术评审`, rev.status === 200, rev.message)) return null
  const req = await api('POST', `/api/workshop/projects/${pid}/results/${draft.id}/request-acceptance`, {})
  if (!step(`${tag}-s4`, `${tag} L2 申请`, req.status === 200, req.message)) return null
  const dec = req.data?.id ? await api('POST', `/api/workshop/projects/${pid}/approvals/${req.data.id}/decide`, { approve: true }, { user: 'B' }) : { status: 400 }
  if (!step(`${tag}-s5`, `${tag} L2 签核 → approved`, dec.status === 200, dec.message ?? '')) return null
  return draft
}
async function dispatchAndWaitInstance(pid, wid, tag) {
  const disp = await api('POST', `/api/workshop/projects/${pid}/work-items/${wid}/dispatch`, {})
  if (!step(`${tag}-d1`, `${tag} 派发(实例创建)`, disp.status === 200, disp.message)) return null
  const instCh = disp.data?.instanceChannelId
  const info = await poll(async () => {
    const det = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`)).data
    return det?.attempts?.[0]?.channelTaskId ? det : null
  }, 40_000)
  if (!step(`${tag}-d2`, `${tag} 实例 Channel+root 在飞`, Boolean(instCh && info), `inst=${String(instCh ?? '').slice(0, 8)}`)) return null
  const ags = (await api('GET', `/api/workshop/channels/${instCh}/agents`)).data ?? []
  const lead = ags.find(a => a.role === 'lead' && (a.enabled ?? 1) === 1)
  step(`${tag}-d3`, `${tag} 实例 lead 启用`, Boolean(lead?.id), `lead=${String(lead?.id ?? '').slice(0, 8)}`)
  return { instCh, rootId: info.attempts[0].channelTaskId, leadId: lead?.id }
}
async function closeRoot(pid, wid, ctx, text, tag) {
  // 引擎约束:父任务收口要求子任务 COMPLETED 或 superseded(mock lead 会拆子任务)。
  // 取消在飞子任务 → 自派替代分支(assignee=lead) → supersede 显式替代 → 收替代分支 → 收 root。
  const det = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`)).data
  const openChild = (det?.attempts?.[0]?.workers ?? []).find(w => !['COMPLETED', 'FAILED', 'CANCELED'].includes(w.state))
  if (openChild) {
    const c = await invoke(ctx.leadId, 'cancel_task', { task_id: openChild.id })
    step(`${tag}-x1`, `${tag} 取消 mock 子任务`, !c.isError, c.text.replace(/\s+/g, ' ').slice(0, 100))
    const rep = await invoke(ctx.leadId, 'dispatch_task', {
      parent_task_id: ctx.rootId, assignee_id: ctx.leadId,
      title: `${tag} 收口分支`, description: '替代被取消的 mock 分支(本分支承载真实交付)',
    })
    const newId = (rep.text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ?? [])[0]
      ?? rep.data?.task?.id ?? null
    step(`${tag}-x2`, `${tag} 自派替代分支`, !rep.isError && Boolean(newId), String(newId ?? '').slice(0, 8))
    if (newId) {
      const sup = await invoke(ctx.leadId, 'supersede_task', { task_id: openChild.id, replacement_task_id: newId, reason: `${tag} mock 分支由收口分支替代` })
      step(`${tag}-x3`, `${tag} supersede 显式替代`, !sup.isError, sup.text.replace(/\s+/g, ' ').slice(0, 90))
      const rep2 = await invoke(ctx.leadId, 'complete_task', { task_id: newId, summary: `${tag} 分支收口:真实交付见 root 摘要。` })
      step(`${tag}-x4`, `${tag} 收替代分支`, !rep2.isError, rep2.text.replace(/\s+/g, ' ').slice(0, 90))
    }
  }
  const done = await invoke(ctx.leadId, 'complete_task', { task_id: ctx.rootId, summary: text })
  step(`${tag}-c1`, `${tag} 实例 lead 收口(真实工件摘要)`, !done.isError, done.text.replace(/\s+/g, ' ').slice(0, 140))
  const st = await poll(async () => {
    const d = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`)).data
    return d?.workItem?.state === 'COMPLETED' ? 'COMPLETED' : null
  }, 30_000)
  step(`${tag}-c2`, `${tag} 工作项 COMPLETED`, st === 'COMPLETED', `state=${st}`)
}

/* ── 真实产物:可运行的 Python 记账 CLI ── */
const LEDGER_PY = `#!/usr/bin/env python3
"""简易记账 CLI(Project 终验产物):记账/汇总/按分类统计。数据存 JSON 文件。"""
import json
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

DB = Path(__file__).with_name("ledger.json")


def load():
    if not DB.exists():
        return []
    return json.loads(DB.read_text(encoding="utf-8"))


def save(rows):
    DB.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


def add(amount, category, note=""):
    rows = load()
    rows.append({"date": date.today().isoformat(), "amount": float(amount),
                 "category": category, "note": note})
    save(rows)
    return len(rows)


def summary():
    rows = load()
    income = sum(r["amount"] for r in rows if r["amount"] > 0)
    expense = sum(-r["amount"] for r in rows if r["amount"] < 0)
    return {"count": len(rows), "income": round(income, 2),
            "expense": round(expense, 2), "balance": round(income - expense, 2)}


def by_category():
    agg = defaultdict(float)
    for r in load():
        agg[r["category"]] += r["amount"]
    return {k: round(v, 2) for k, v in sorted(agg.items())}


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "summary"
    if cmd == "add":
        n = add(argv[2], argv[3], argv[4] if len(argv) > 4 else "")
        print(f"已记账,当前 {n} 笔")
    elif cmd == "summary":
        print(json.dumps(summary(), ensure_ascii=False))
    elif cmd == "by-category":
        print(json.dumps(by_category(), ensure_ascii=False))
    else:
        print("用法: ledger.py [add <金额> <分类> [备注] | summary | by-category]")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
`
const TEST_PY = `#!/usr/bin/env python3
"""记账 CLI 测试(终验产物):覆盖 记账/汇总/分类统计 三条主路径。"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
LEDGER = HERE / "ledger.py"
DB = HERE / "ledger.json"


def run(*args):
    out = subprocess.run([sys.executable, str(LEDGER), *args],
                         capture_output=True, text=True)
    return out.returncode, out.stdout.strip()


def main():
    if DB.exists():
        DB.unlink()
    failures = []
    rc, _ = run("add", "5000", "工资", "月薪")
    if rc != 0: failures.append("add 收入失败")
    rc, _ = run("add", "-35.5", "餐饮", "午餐")
    if rc != 0: failures.append("add 支出失败")
    rc, out = run("summary")
    got = json.loads(out) if rc == 0 else {}
    if got.get("count") != 2: failures.append(f"count 期望 2 实得 {got.get('count')}")
    if got.get("balance") != 4964.5: failures.append(f"balance 期望 4964.5 实得 {got.get('balance')}")
    rc, out = run("by-category")
    cats = json.loads(out) if rc == 0 else {}
    if cats.get("工资") != 5000.0: failures.append(f"分类工资期望 5000 实得 {cats.get('工资')}")
    if cats.get("餐饮") != -35.5: failures.append(f"分类餐饮期望 -35.5 实得 {cats.get('餐饮')}")
    print("PASS" if not failures else "FAIL: " + "; ".join(failures))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
`

async function main() {
  tokenA = (await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data?.token ?? ''
  tokenB = (await api('POST', '/api/users/login', { email: 'verify-pitfall@aw.local', password: 'Verify#2026' })).data?.token ?? ''
  if (!step('S0-1', '双账号登录(owner / 独立评审)', Boolean(tokenA && tokenB), 'A=admin B=verify-pitfall')) return finish()

  // ═══ S1 三频道 + Project(通用开发域,非产线)═══
  const mkChannel = async (name, leadName) => {
    const ch = await api('POST', '/api/workshop/channels', { name })
    const cid = ch.data?.channelId ?? ch.data?.id
    const lead = await api('POST', `/api/workshop/channels/${cid}/agents`, { name: leadName, harness: 'mock', role: 'lead' })
    await api('POST', `/api/workshop/channels/${cid}/agents`, { name: `${leadName}·worker`, harness: 'mock', role: 'worker', config: { delayMs: 600000 } })
    await api('POST', `/api/workshop/channels/${cid}/activate`, {})
    return { cid, leadId: lead.data?.id }
  }
  const req = await mkChannel(`记账软件-需求-${Date.now() % 100000}`, '需求Lead')
  const dev = await mkChannel(`记账软件-开发-${Date.now() % 100000}`, '开发Lead')
  const qa = await mkChannel(`记账软件-测试-${Date.now() % 100000}`, '测试Lead')
  step('S1-1', '三频道建立(需求/开发/测试;非产线域)', Boolean(req.cid && dev.cid && qa.cid),
    `req=${String(req.cid).slice(0, 8)} dev=${String(dev.cid).slice(0, 8)} qa=${String(qa.cid).slice(0, 8)}`)

  // leaderHarness 必填(P2 去默认后)
  const proj = await api('POST', '/api/workshop/projects', {
    name: `记账软件开发 ${Date.now()}`,
    objective: '开发一个可运行的记账软件:需求规格 → 源码实现 → 自动化测试,三频道协同交付',
    leaderHarness: 'mock', mode: 'supervised', routingPolicy: 'technical',
  })
  const pid = proj.data?.id
  step('S1-2', 'Project 创建(显式 leaderHarness;通用开发域)', Boolean(pid), `pid=${String(pid ?? '').slice(0, 8)} ${proj.message}`)
  if (!pid) return finish()
  // 反证:P2 后缺 leaderHarness 必须 400
  const noHarness = await api('POST', '/api/workshop/projects', { name: '缺引擎负面用例', objective: 'xx' })
  step('S1-3', '负面用例:缺 leaderHarness → 400(P2 去默认生效)', noHarness.status === 400, `status=${noHarness.status} code=${noHarness.code ?? ''}`)

  for (const c of [req, dev, qa]) await api('POST', `/api/workshop/projects/${pid}/channels`, { channelId: c.cid, charter: '开发协同' })
  const d1 = (await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: 'spec', required: true, ownerChannelId: req.cid, acceptanceCriteria: ['artifact_present'] })).data?.id
  const d2 = (await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: 'source', required: true, ownerChannelId: dev.cid, acceptanceCriteria: ['artifact_present'] })).data?.id
  const d3 = (await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: 'test-report', required: true, ownerChannelId: qa.cid, acceptanceCriteria: ['artifact_present'] })).data?.id
  step('S1-4', '三交付物注册', Boolean(d1 && d2 && d3), `${d1?.slice(0, 6)}/${d2?.slice(0, 6)}/${d3?.slice(0, 6)}`)
  const w1 = (await api('POST', `/api/workshop/projects/${pid}/work-items`, { deliverableId: d1, channelId: req.cid, title: 'W1 需求规格', brief: '定义记账软件的账目录入/汇总/分类统计三项功能与数据格式。', execBudgetMinutes: 20 })).data?.id
  const w2 = (await api('POST', `/api/workshop/projects/${pid}/work-items`, { deliverableId: d2, channelId: dev.cid, title: 'W2 源码实现', brief: '按 W1 规格实现可运行 CLI 与 JSON 存储。', execBudgetMinutes: 20, dependsOn: [w1] })).data?.id
  const w3 = (await api('POST', `/api/workshop/projects/${pid}/work-items`, { deliverableId: d3, channelId: qa.cid, title: 'W3 自动化测试', brief: '对 W2 源码执行三条主路径测试并出报告。', execBudgetMinutes: 20, dependsOn: [w2] })).data?.id
  step('S1-5', '依赖链 W1→W2→W3', Boolean(w1 && w2 && w3), [w1, w2, w3].map(x => String(x ?? '').slice(0, 6)).join('→'))
  await api('POST', `/api/workshop/projects/${pid}/activate`, {})
  const plan = await api('POST', `/api/workshop/projects/${pid}/plan/request-approval`, { version: 1, plan: { facts: ['记账软件为通用开发域案例'], steps: ['W1 规格', 'W2 实现', 'W3 测试'] } })
  const planDec = plan.data?.id ? await api('POST', `/api/workshop/projects/${pid}/approvals/${plan.data.id}/decide`, { approve: true }, { user: 'B' }) : { status: 400 }
  step('S1-6', 'plan 审批(独立 admin)', planDec.status === 200, plan.message || planDec.message || '')

  // ═══ W1 需求规格(真实规格文档)═══
  const c1 = await dispatchAndWaitInstance(pid, w1, 'W1')
  if (!c1) return finish(pid)
  const SPEC = `# 记账软件需求规格 v1
## 功能
1. 记账:add <金额> <分类> [备注] —— 正数=收入,负数=支出,落 JSON 文件
2. 汇总:summary —— 返回 {count, income, expense, balance}
3. 分类统计:by-category —— 按分类聚合净额
## 数据格式
[{date, amount, category, note}] , date=ISO 日期, amount=正负浮点
## 验收
- summary.balance = income - expense(两位小数)
- by-category 净利润分类正确聚合
`
  writeFileSync(join(APP, 'SPEC.md'), SPEC, 'utf8')
  step('W1-t1', 'W1 规格文档落盘(真实文件)', existsSync(join(APP, 'SPEC.md')), `${join(APP, 'SPEC.md').length} bytes`)
  await closeRoot(pid, w1, c1, `W1 需求规格:${SPEC.replace(/\s+/g, ' ').slice(0, 260)}`, 'W1')
  if (!await acceptanceChain(pid, w1, SPEC.slice(0, 800), 'W1')) return finish(pid)

  // ═══ W2 源码实现(真实可运行 Python)═══
  const c2 = await dispatchAndWaitInstance(pid, w2, 'W2')
  if (!c2) return finish(pid)
  writeFileSync(join(APP, 'ledger.py'), LEDGER_PY, 'utf8')
  let smoke = ''
  let smokeOk = false
  try {
    smoke = execFileSync('python', [join(APP, 'ledger.py'), 'summary'], { encoding: 'utf8', timeout: 20_000 }).trim()
    smokeOk = smoke.includes('balance')
  }
  catch (err) {
    smoke = `执行失败: ${err instanceof Error ? err.message : String(err)}`
  }
  step('W2-t1', 'W2 源码落盘且可执行(python ledger.py summary)', smokeOk, smoke.slice(0, 120))
  await closeRoot(pid, w2, c2, `W2 源码实现:ledger.py 已落盘并可执行(summary 输出 ${smoke.slice(0, 120)});实现 add/summary/by-category 三命令 + JSON 存储。`, 'W2')
  if (!await acceptanceChain(pid, w2, LEDGER_PY.slice(0, 700), 'W2')) return finish(pid)

  // ═══ W3 自动化测试(真实执行)═══
  const c3 = await dispatchAndWaitInstance(pid, w3, 'W3')
  if (!c3) return finish(pid)
  writeFileSync(join(APP, 'test_ledger.py'), TEST_PY, 'utf8')
  let testOut = ''
  let testOk = false
  try {
    testOut = execFileSync('python', [join(APP, 'test_ledger.py')], { encoding: 'utf8', timeout: 30_000 }).trim()
    testOk = testOut === 'PASS'
  }
  catch (err) {
    testOut = err instanceof Error ? String((/** @type {{stdout?: string}} */ (err)).stdout ?? err.message) : String(err)
  }
  step('W3-t1', 'W3 自动化测试执行并 PASS', testOk, testOut.slice(0, 160))
  const REPORT = `# 记账软件测试报告
- 用例:3(记账/汇总/分类统计)
- 结果:${testOk ? 'PASS' : 'FAIL'}
- 原始输出:${testOut.slice(0, 300)}
- 覆盖:add 收入+支出、summary.count/balance、by-category 聚合
`
  writeFileSync(join(APP, 'TEST-REPORT.md'), REPORT, 'utf8')
  await closeRoot(pid, w3, c3, `W3 自动化测试:${testOut.slice(0, 200)}(报告已出)`, 'W3')
  if (!await acceptanceChain(pid, w3, REPORT, 'W3')) return finish(pid)

  // ═══ S3 项目收口 ═══
  const comp = await api('POST', `/api/workshop/projects/${pid}/complete`, {})
  step('S3-1', '项目完成审批创建', comp.status === 200, comp.message)
  if (comp.data?.id) step('S3-2', '项目完成签核(独立 admin)', (await api('POST', `/api/workshop/projects/${pid}/approvals/${comp.data.id}/decide`, { approve: true }, { user: 'B' })).status === 200, '')
  const pf = (await api('GET', `/api/workshop/projects/${pid}`)).data
  step('S3-3', '项目终态 completed', pf?.status === 'completed', `status=${pf?.status}`)
  const evs = (await api('GET', `/api/workshop/projects/${pid}/events?scope=all&limit=400`)).data ?? []
  const types = new Set((Array.isArray(evs) ? evs : evs.items ?? []).map(e => e.type))
  const need = ['work.dispatched', 'work.completed', 'result.submitted', 'result.reviewed', 'approval.approved']
  step('S3-4', '全链审计事件齐备', need.every(n => types.has(n)), `missing=${need.filter(n => !types.has(n)).join(',')}`)
  step('S3-5', '三交付物 approved', ((await api('GET', `/api/workshop/projects/${pid}/results`)).data ?? []).filter(r => r.status === 'approved').length >= 3, '')
  const files = ['SPEC.md', 'ledger.py', 'test_ledger.py', 'TEST-REPORT.md'].filter(f => existsSync(join(APP, f)))
  step('S3-6', '产物文件齐备(4 件)', files.length === 4, files.join(', '))
  finish(pid)
}

function finish(pid) {
  const pass = results.filter(r => r.pass).length
  const fail = results.length - pass
  writeFileSync(join(EVID, 'bookkeeping.json'), JSON.stringify({ generatedAt: new Date().toISOString(), base, pid: pid ?? '', pass, fail, results }, null, 2))
  console.log(`\n=== BOOKKEEPING PROJECT pass=${pass}/${results.length} fail=${fail} ===`)
  process.exitCode = fail > 0 ? 1 : 0
}

main().catch(e => { console.error('fatal:', e); finish('') })
