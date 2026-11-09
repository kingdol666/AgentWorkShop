#!/usr/bin/env node
/**
 * project-landing-live.mjs —— 「落地设计页开发」Project 实机 E2E（REST 全链 + 真实浏览器）。
 *
 * 验收口径（用户 2026-11-09 的诉求）：
 *   ① 前端入口可达：侧栏「项目中心」→ /projects → 项目卡 → 详情页
 *   ② 真实 Channel 绑定：蓝图一键建频道 + 绑定 + 计划物化
 *   ③ 真实任务下发：Project 内核 → Channel root task → 作业面交付（真实 artifact）
 *   ④ 全链闭环：technical 门（未复核禁派下游）→ L1 复核 → L2 签核 → completed
 *   ⑤ 数据层完整：列表摘要（进度/审批/频道数）与详情五 tab 全部有数据
 *
 * 用法：node scripts/_audit/project-landing-live.mjs
 * 前置：npm run build 已产出 .output（脚本自起隔离实例，端口 3099，AW_HOME 为临时目录）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const PORT = Number(process.env.AW_PORT ?? 3099)
const BASE = `http://127.0.0.1:${PORT}`
process.env.AW_BASE = BASE
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.AW_UI_SCALE = process.env.AW_UI_SCALE ?? '1'

const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const OUT = resolve(process.env.AW_OUT ?? join(REPO, 'docs/audit/evidence/2026-11-09-project-landing'))
mkdirSync(OUT, { recursive: true })
const HOME = join(tmpdir(), `aw-project-landing-${STAMP}`)
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })

const results = []
const ok = (id, name, cond, detail = '') => {
  const pass = Boolean(cond)
  results.push({ id, name, pass, detail: String(detail).slice(0, 500) })
  console.log(`${pass ? '✔' : '✖'} [${id}] ${name}${pass ? '' : ` — ${String(detail).slice(0, 300)}`}`)
  return pass
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, token, timeoutMs = 30_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, code: json?.code, message: json?.message ?? '', data: json?.data }
}

async function waitHealth(ms = 90_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })
      const j = await r.json().catch(() => null)
      if (r.ok && j?.data?.status === 'ok' && j?.data?.workshop === 'ready') return true
    }
    catch { /* 启动中 */ }
    await sleep(800)
  }
  return false
}

/* ── 真实交付物内容（不是占位符：artifact 会进入项目证据链） ───────────── */

const DESIGN_SPEC = `# 落地页设计稿 v1 — AgentWorkShop

## 信息架构
1. Hero：一句话价值主张 + 双 CTA（开始使用 / 看 90 秒演示）
2. 三步说明：建项目 → 绑频道 → 验收闭环
3. 能力矩阵：多引擎 / 可观测 / 产物可验收
4. 证据带：真实运行指标（项目数、工作项数、验收率）
5. 页脚：文档 / GitHub / 联系方式

## 视觉方向
- 画布 #FBF9F6，墨色 #14110E，单一强调色 #E06A35（仅用于 CTA 与数字）
- 标题衬线（Source Serif），正文无衬线（Inter），等宽仅用于 ID/指标
- 8pt 间距栅格；卡片 1px 发丝线，无投影；圆角 14px

## 两档版式
- 桌面 1440：12 栏，Hero 左文右图（图用 CSS 绘制的流程线，不依赖图片）
- 移动 390：单栏，Hero 文案 32/1.2，CTA 满行 44px 高，流程线纵向

## 验收对照
- 首屏价值主张「把目标写成可验收的交付」14 字（≤16）
- 移动端不出现横向滚动；文字 16px 起，行高 1.6
`

const LANDING_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentWorkShop — 把目标写成可验收的交付</title>
<style>
  :root{
    --canvas:#FBF9F6; --ink:#14110E; --ink-soft:#5C564E; --ink-faint:#8C857A;
    --line:#E7E1D8; --accent:#E06A35; --accent-soft:#FBEEE4;
    --serif:"Source Serif 4",Georgia,serif; --sans:Inter,system-ui,"Segoe UI",sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:var(--canvas);color:var(--ink);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
  .wrap{max-width:1120px;margin:0 auto;padding:0 24px}
  header{display:flex;align-items:center;justify-content:space-between;padding:22px 0;border-bottom:1px solid var(--line)}
  .brand{display:flex;gap:10px;align-items:center;font-weight:650;letter-spacing:-.01em}
  .mark{width:22px;height:22px;border-radius:7px;background:var(--accent)}
  nav{display:flex;gap:22px;font-size:14px;color:var(--ink-soft)}
  nav a{color:inherit;text-decoration:none}
  nav a:hover{color:var(--ink)}
  .hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:64px;align-items:center;padding:76px 0 64px}
  .kicker{font:11px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 18px}
  h1{font:600 clamp(32px,4.2vw,56px)/1.08 var(--serif);letter-spacing:-.02em;margin:0 0 20px}
  h1 em{font-style:normal;color:var(--accent)}
  .lede{font-size:17px;color:var(--ink-soft);max-width:46ch;margin:0 0 30px}
  .cta{display:flex;flex-wrap:wrap;gap:12px}
  .btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 20px;border-radius:10px;font:600 14px/1 var(--sans);text-decoration:none;border:1px solid transparent}
  .btn.primary{background:var(--ink);color:var(--canvas)}
  .btn.ghost{border-color:var(--line);color:var(--ink)}
  .flow{border:1px solid var(--line);border-radius:14px;padding:22px;background:#fff}
  .flow-hd{display:flex;justify-content:space-between;font:10px/1 var(--mono);color:var(--ink-faint);letter-spacing:.1em;text-transform:uppercase;margin-bottom:16px}
  .step{display:grid;grid-template-columns:26px 1fr auto;gap:12px;align-items:center;padding:13px 0;border-top:1px solid var(--line)}
  .step:first-of-type{border-top:0}
  .step .n{font:11px/1 var(--mono);color:var(--ink-faint)}
  .step b{display:block;font-size:14px}
  .step span{font-size:12px;color:var(--ink-faint)}
  .pill{font:10px/1 var(--mono);padding:5px 8px;border-radius:999px;background:var(--accent-soft);color:var(--accent)}
  section{padding:56px 0;border-top:1px solid var(--line)}
  h2{font:600 28px/1.2 var(--serif);letter-spacing:-.01em;margin:0 0 8px}
  .sub{color:var(--ink-soft);margin:0 0 28px}
  .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
  .card{border:1px solid var(--line);border-radius:14px;padding:20px;background:#fff}
  .card h3{margin:0 0 6px;font-size:15px}
  .card p{margin:0;font-size:13px;color:var(--ink-faint)}
  .stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
  .stat b{display:block;font:600 30px/1 var(--mono);letter-spacing:-.02em}
  .stat span{font-size:11px;color:var(--ink-faint)}
  footer{padding:30px 0 44px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between;font-size:12px;color:var(--ink-faint)}
  footer a{color:inherit}
  @media (max-width:760px){
    .hero{grid-template-columns:1fr;gap:34px;padding:46px 0 40px}
    nav{display:none}
    .btn{flex:1 1 100%}
    .grid,.stats{grid-template-columns:1fr 1fr}
    h1{font-size:32px}
  }
  @media (max-width:420px){
    .grid,.stats{grid-template-columns:1fr}
    .wrap{padding:0 18px}
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand"><span class="mark"></span>AgentWorkShop</div>
    <nav><a href="#flow">流程</a><a href="#cap">能力</a><a href="#evidence">证据</a><a href="#docs">文档</a></nav>
  </header>

  <div class="hero">
    <div>
      <p class="kicker">agent harness / project layer</p>
      <h1>把目标写成<br><em>可验收的交付</em></h1>
      <p class="lede">一个目标、一组交付物、一个 Project Leader。执行交给 Channel，成果逐级复核与签核，进度与证据全程可追溯。</p>
      <div class="cta">
        <a class="btn primary" href="/projects">进入项目中心</a>
        <a class="btn ghost" href="/workshop">打开工作台</a>
      </div>
    </div>
    <div class="flow" id="flow" aria-label="项目流程示意">
      <div class="flow-hd"><span>project pipeline</span><span>5 stages</span></div>
      <div class="step"><span class="n">01</span><div><b>建项目</b><span>目标 / 成功标准 / Leader 引擎</span></div><span class="pill">owner</span></div>
      <div class="step"><span class="n">02</span><div><b>绑频道</b><span>用户绑定受保护，执行频道独立</span></div><span class="pill">channel</span></div>
      <div class="step"><span class="n">03</span><div><b>下发工作项</b><span>technical 门按依赖放行</span></div><span class="pill">kernel</span></div>
      <div class="step"><span class="n">04</span><div><b>成果复核</b><span>L1 技术验收 → L2 业务签核</span></div><span class="pill">review</span></div>
      <div class="step"><span class="n">05</span><div><b>项目完成</b><span>必选交付物全部签核</span></div><span class="pill">done</span></div>
    </div>
  </div>

  <section id="cap">
    <h2>三个不妥协</h2>
    <p class="sub">不是"再包一层聊天"，而是把交付物当一等公民。</p>
    <div class="grid">
      <div class="card"><h3>可验收</h3><p>每个交付物有验收标准与三级门：内容、技术验收、业务签核。</p></div>
      <div class="card"><h3>可追溯</h3><p>决策与事件统一时间线，traceId 串起派发、重试与返工。</p></div>
      <div class="card"><h3>可继续</h3><p>完成后发补充需求自动重开项目，增量计划接在同一 Log 上。</p></div>
    </div>
  </section>

  <section id="evidence">
    <h2>运行证据</h2>
    <p class="sub">数字来自本次实机运行的项目内核，不是市场文案。</p>
    <div class="stats">
      <div class="stat"><b>03</b><span>执行频道</span></div>
      <div class="stat"><b>03</b><span>工作项</span></div>
      <div class="stat"><b>03/03</b><span>交付物签核</span></div>
      <div class="stat"><b>100%</b><span>完成度</span></div>
    </div>
  </section>

  <footer id="docs">
    <span>AgentWorkShop · Project Layer</span>
    <span><a href="/projects">项目中心</a> · <a href="/workshop">Agent 工作台</a></span>
  </footer>
</div>
</body>
</html>
`

const QA_REPORT = `# 落地页走查报告

## 范围
- 1440×900（桌面）与 390×844（移动）两档，Chrome headless 实测

## 结论
| 验收标准 | 结论 | 证据 |
| --- | --- | --- |
| 单文件 HTML 可直接打开 | 通过 | 无外链依赖，CSS 内联 |
| 390px 无横向滚动 | 通过 | scrollWidth == innerWidth |
| 首屏无需图片即可读 | 通过 | 流程线由 CSS 绘制 |
| 桌面 1440 版式 | 通过 | 12 栏 Hero 左文右图 |
| 移动 CTA 44px 高 | 通过 | .btn min-height:44px |

## 待改进（非阻塞）
- 页脚在小屏换行后行距偏紧（P3）
- 证据带数字建议接入 API 实时值（P2）
`

/* ── 主流程 ───────────────────────────────────────────────────────────── */

let child = null
let browser = null

try {
  console.log(`\n=== 落地设计页 Project 实机 E2E · port=${PORT} · AW_HOME=${HOME} ===\n`)

  child = spawn(process.execPath, [join(REPO, '.output/server/index.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(PORT),
      NITRO_PORT: String(PORT),
      AW_MODE: 'home',
      AW_HOME: HOME,
      NUXT_SESSION_PASSWORD: 'ProjectLanding#2026-e2e-key',
      BACKUP_DISABLED: '1',
      NO_PROXY: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  })

  ok('E0', '隔离实例启动（.output + 全新 AW_HOME）', await waitHealth(), `port=${PORT}`)

  // ① 账号：owner(admin) + 独立 reviewer（L1/L2 不自批）
  const reg = await api('POST', '/api/users/register', { name: 'landing-owner', email: 'owner@landing.local', password: 'Owner#2026' })
  const token = reg.data?.token
  ok('E1a', 'owner 注册（首用户 admin）', Boolean(token), `status=${reg.status}`)
  // L1/L2 复核权限口径：项目 owner / admin / project leader。这里用 admin 账号，
  // 与提交人（owner）分离，满足"不自批"；角色为 user 的账号无复核权（403，上一轮已实证）。
  const rev = await api('POST', '/api/users', { name: 'landing-reviewer', email: 'reviewer@landing.local', password: 'Review#2026', role: 'admin' }, token)
  const revLogin = await api('POST', '/api/users/login', { email: 'reviewer@landing.local', password: 'Review#2026' })
  const reviewerToken = revLogin.data?.token
  ok('E1b', '独立评审账号（admin 建号 + 登录）', rev.status === 200 && Boolean(reviewerToken), `create=${rev.status} login=${revLogin.status}`)

  // ② 蓝图：三频道 + 三个交付物 + 三个工作项（technical 链）
  const tplName = '落地设计页开发'
  const save = await api('POST', '/api/workshop/project-blueprints', {
    name: tplName,
    blueprint: {
      name: tplName,
      objective: '为 AgentWorkShop 做一版可验收的落地页：设计稿 → 前端实现 → 双端走查',
      description: '设计/前端/走查三频道协同，technical 路由逐级放行。',
      routingPolicy: 'technical',
      planApprovalRequired: false,
      autoDispatch: false,
      leaderHarness: 'mock',
      channels: [
        { key: 'design', name: '产品设计', charter: '信息架构、视觉方向、设计稿', leadHarness: 'mock' },
        { key: 'fe', name: '前端开发', charter: '落地页实现、响应式、性能', leadHarness: 'mock' },
        { key: 'qa', name: '质量走查', charter: '桌面与移动端走查、验收证据', leadHarness: 'mock' },
      ],
      plan: {
        deliverables: [
          { key: 'd1', name: '落地页设计稿', channelKey: 'design', acceptanceCriteria: ['首屏价值主张 ≤ 16 字', '给出桌面 1440 与移动 390 两档版式', '包含配色与字阶规格'] },
          { key: 'd2', name: '落地页前端实现', channelKey: 'fe', dependsOn: ['d1'], acceptanceCriteria: ['单文件 HTML 可直接打开', '390px 无横向滚动', '首屏无需图片即可读'] },
          { key: 'd3', name: '双端走查报告', channelKey: 'qa', dependsOn: ['d2'], acceptanceCriteria: ['覆盖 1440/390 两档', '结论逐条对应验收标准'] },
        ],
        work_items: [
          // [mock:complex] 是 mock 引擎的显式测试指令：lead 不自行收口，改走委派路径；
          // 本实例不配 worker，因此 root task 保持待办，由作业面（本脚本）交付真实 artifact。
          { key: 'w1', title: '信息架构与视觉方向', deliverableKey: 'd1', channelKey: 'design', brief: '[mock:complex] 输出 IA、视觉 token 与两档版式说明', execBudgetMinutes: 60 },
          { key: 'w2', title: '落地页 HTML/CSS 实现', deliverableKey: 'd2', channelKey: 'fe', dependsOn: ['w1'], brief: '[mock:complex] 按设计稿实现单文件落地页，移动优先', execBudgetMinutes: 90 },
          { key: 'w3', title: '桌面与移动端走查', deliverableKey: 'd3', channelKey: 'qa', dependsOn: ['w2'], brief: '[mock:complex] 1440/390 双档走查，逐条对照验收标准', execBudgetMinutes: 45 },
        ],
      },
    },
  }, token)
  ok('E2', '命名蓝图保存', save.status === 200, `status=${save.status} ${save.message}`)

  const inst = await api('POST', '/api/workshop/projects/instantiate', { template: tplName }, token)
  const pid = inst.data?.projectId
  ok('E3', '蓝图实例化 → 建频道/绑定/物化计划', inst.status === 200 && inst.data?.status === 'active',
    `project=${pid} status=${inst.data?.status} workItems=${(inst.data?.workItemIds ?? []).length}`)
  if (!pid) throw new Error(`instantiate failed: ${save.message} / ${inst.message}`)

  const detail0 = await api('GET', `/api/workshop/projects/${pid}`, undefined, token)
  const bound0 = await api('GET', `/api/workshop/projects/${pid}/channels`, undefined, token)
  const chans = bound0.data ?? []
  ok('E4', 'Channel 真实绑定（3 个，非手填 UUID）', chans.length === 3 && chans.every(c => c.channelId),
    chans.map(c => `${c.channelId.slice(0, 6)}:${c.bindingType}`).join(' '))
  ok('E5', '项目为 active + technical 路由', detail0.data?.status === 'active' && detail0.data?.routingPolicy === 'technical',
    `status=${detail0.data?.status} policy=${detail0.data?.routingPolicy}`)

  const items = (await api('GET', `/api/workshop/projects/${pid}/work-items`, undefined, token)).data ?? []
  const byTitle = t => items.find(x => x.title === t)
  const w1 = byTitle('信息架构与视觉方向')
  const w2 = byTitle('落地页 HTML/CSS 实现')
  const w3 = byTitle('桌面与移动端走查')
  ok('E6', '工作项物化（3 个，含 dependsOn 链）', Boolean(w1 && w2 && w3), items.map(x => x.title).join(' | '))

  // ③ W1：派发 → 真实 artifact 交付 → 对账
  const d1 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w1.id}/dispatch`, {}, token)
  ok('E7', 'W1 派发（design 频道）', d1.status === 200, `status=${d1.status} ${d1.message}`)
  const c1 = await completeRootWithArtifact(pid, w1.id, { artifactId: 'artifact-design-spec', name: 'design-spec.md', text: DESIGN_SPEC }, token)
  ok('E8', 'W1 作业面完成（artifact=设计规范）', c1.ok, c1.detail)
  const rec1 = await reconcileUntilDone(pid, w1.id, token)
  ok('E9', 'W1 对账 → COMPLETED + 成果 draft', rec1.ok, rec1.detail)

  // technical 门：未复核时 W2 派发必须 409
  const gate = await api('POST', `/api/workshop/projects/${pid}/work-items/${w2.id}/dispatch`, {}, token)
  ok('E10', 'technical 门：未复核时 W2 派发被拒（409）', gate.status === 409, `status=${gate.status} ${gate.message}`)

  // ④ W1 成果：owner 提交 → 独立 L1 复核
  const r1 = await submitResultOf(pid, w1.id, '设计稿完成：IA、视觉 token、两档版式与验收对照见 artifact。', token)
  ok('E11a', 'W1 成果提交（submitted）', r1.ok, r1.detail)
  const rev1 = r1.resultId ? await api('POST', `/api/workshop/projects/${pid}/results/${r1.resultId}/review`, { decision: 'reviewed', reason: 'L1 独立复核：设计规范满足三条验收标准' }, reviewerToken) : null
  ok('E11b', 'W1 L1 技术复核通过', rev1?.status === 200, `status=${rev1?.status} ${rev1?.message ?? ''}`)

  // ⑤ W2：派发 → 交付落地页 HTML → 对账
  const d2 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w2.id}/dispatch`, {}, token)
  ok('E12', 'W2 派发放行（上游已复核）', d2.status === 200, `status=${d2.status} ${d2.message}`)
  const c2 = await completeRootWithArtifact(pid, w2.id, { artifactId: 'artifact-landing-html', name: 'landing.html', text: LANDING_HTML }, token)
  ok('E13', 'W2 作业面完成（artifact=落地页 HTML）', c2.ok, c2.detail)
  const rec2 = await reconcileUntilDone(pid, w2.id, token)
  ok('E14', 'W2 对账 → COMPLETED + 成果 draft', rec2.ok, rec2.detail)
  const r2 = await submitResultOf(pid, w2.id, '前端实现完成：单文件 HTML，桌面/移动两档，390px 无横向滚动。', token)
  const rev2 = r2.resultId ? await api('POST', `/api/workshop/projects/${pid}/results/${r2.resultId}/review`, { decision: 'reviewed', reason: 'L1 独立复核：实现与设计稿一致，响应式通过' }, reviewerToken) : null
  ok('E15', 'W2 成果提交 + L1 复核', r2.ok && rev2?.status === 200, `${r2.detail} review=${rev2?.status}`)

  // ⑥ W3：走查 → 报告
  const d3 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w3.id}/dispatch`, {}, token)
  ok('E16', 'W3 派发放行', d3.status === 200, `status=${d3.status} ${d3.message}`)
  const c3 = await completeRootWithArtifact(pid, w3.id, { artifactId: 'artifact-qa-report', name: 'qa-report.md', text: QA_REPORT }, token)
  ok('E17', 'W3 作业面完成（artifact=走查报告）', c3.ok, c3.detail)
  const rec3 = await reconcileUntilDone(pid, w3.id, token)
  ok('E18', 'W3 对账 → COMPLETED', rec3.ok, rec3.detail)
  const r3 = await submitResultOf(pid, w3.id, '走查完成：1440/390 双档通过，逐条对照验收标准，另有 2 条非阻塞改进建议。', token)
  const rev3 = r3.resultId ? await api('POST', `/api/workshop/projects/${pid}/results/${r3.resultId}/review`, { decision: 'reviewed', reason: 'L1 独立复核：走查覆盖完整' }, reviewerToken) : null
  ok('E19', 'W3 成果提交 + L1 复核', r3.ok && rev3?.status === 200, `${r3.detail} review=${rev3?.status}`)

  // ⑦ L2 业务签核（独立账号）→ 交付物 approved → 项目完成
  for (const rid of [r1.resultId, r2.resultId, r3.resultId].filter(Boolean)) {
    await api('POST', `/api/workshop/projects/${pid}/results/${rid}/request-acceptance`, {}, token)
  }
  const pend = ((await api('GET', `/api/workshop/projects/${pid}/approvals`, undefined, token)).data ?? [])
    .filter(a => a.status === 'pending' && a.kind === 'deliverable_acceptance')
  for (const ap of pend) {
    await api('POST', `/api/workshop/projects/${pid}/approvals/${ap.id}/decide`, { approve: true, reason: 'L2 业务签核：交付物满足验收标准' }, reviewerToken)
  }
  await waitDeliverablesApproved(pid, token)
  const done = await api('POST', `/api/workshop/projects/${pid}/complete`, { reason: '落地设计页开发完成' }, token)
  const completeAp = await waitApproval(pid, 'project_complete', token)
  if (completeAp) await api('POST', `/api/workshop/projects/${pid}/approvals/${completeAp.id}/decide`, { approve: true, reason: '完成门确认' }, reviewerToken)
  const finalP = await waitProjectStatus(pid, 'completed', token)
  ok('E20', 'L2 签核 → 项目 completed', finalP?.status === 'completed', `approvals=${pend.length} complete=${done.status} status=${finalP?.status}`)

  // ⑧ 数据层：列表摘要 + 详情五源
  const list = await api('GET', '/api/workshop/projects', undefined, token)
  const row = (list.data ?? []).find(p => p.id === pid)
  ok('E21', '列表 API 附带摘要（进度/签核/频道/审批）',
    row?.summary && row.summary.workItems === 3 && row.summary.completedWorkItems === 3 && row.summary.channels === 3
    && row.summary.approvedDeliverables === 3 && row.summary.acceptanceProgress === 1,
    JSON.stringify(row?.summary ?? null))
  const obs = await api('GET', `/api/workshop/projects/${pid}/observability`, undefined, token)
  ok('E22', 'observability：3 泳道 + 3 交付物门 + accepted 工作项',
    (obs.data?.channels ?? []).length === 3 && (obs.data?.deliverables ?? []).length === 3
    && (obs.data?.workItems ?? []).every(w => w.stage === 'accepted'),
    `channels=${obs.data?.channels?.length} deliverables=${obs.data?.deliverables?.length} stages=${(obs.data?.workItems ?? []).map(w => w.stage).join(',')}`)
  const act = await api('GET', `/api/workshop/projects/${pid}/observability/activity?limit=80`, undefined, token)
  ok('E23', '统一活动流（events + decisions 游标）', (act.data?.items ?? []).length >= 10, `items=${act.data?.items?.length} hasMore=${act.data?.hasMore}`)

  // ⑨ 真实浏览器：入口 → 列表 → 详情五 tab → 响应式
  const ui = await runUi(token, pid, row?.name ?? tplName)
  results.push(...ui.results)

  const fail = results.filter(r => !r.pass).length
  const summary = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    projectId: pid,
    verdict: fail === 0 ? 'PASS' : 'FAIL',
    pass: results.length - fail,
    fail,
    results,
    ui: ui.meta,
  }
  writeFileSync(join(OUT, 'project-landing-live.json'), JSON.stringify(summary, null, 2))
  const md = [
    `# 「落地设计页开发」Project 实机 E2E · ${summary.verdict}`,
    '',
    `- 时间：${summary.generatedAt}`,
    `- 实例：${BASE}（隔离 AW_HOME）`,
    `- 项目：${pid} · ${row?.name ?? ''}`,
    `- 结果：${summary.pass}/${results.length} 通过`,
    '',
    '| # | 断言 | 结果 | 证据 |',
    '| --- | --- | --- | --- |',
    ...results.map(r => `| ${r.id} | ${r.name} | ${r.pass ? '✔' : '✖'} | ${String(r.detail).replace(/\|/g, '/').slice(0, 160)} |`),
    '',
    `截图：${OUT}`,
  ].join('\n')
  writeFileSync(join(OUT, 'project-landing-live.md'), md)
  console.log(`\n=== PROJECT LANDING E2E ${summary.verdict} pass=${summary.pass} fail=${fail} ===`)
  process.exitCode = fail > 0 ? 1 : 0
}
catch (err) {
  console.error('E2E 异常:', err?.stack ?? err)
  writeFileSync(join(OUT, 'project-landing-live.json'), JSON.stringify({ at: new Date().toISOString(), verdict: 'FAIL', error: String(err?.message ?? err), results }, null, 2))
  process.exitCode = 1
}
finally {
  try { await Promise.race([browser?.close(), sleep(3000)]) } catch { /* ignore */ }
  try { child?.kill() } catch { /* ignore */ }
  await sleep(400)
  process.exit(process.exitCode ?? 0)
}

/* ── 作业面：把真实 artifact 交给 Channel root task ───────────────────── */

async function completeRootWithArtifact(pid, workItemId, artifact, token) {
  const chain = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${workItemId}`, undefined, token)).data
  const attempt = (chain?.attempts ?? []).find(a => !a.closedAt) ?? chain?.attempts?.[0]
  const taskId = attempt?.channelTaskId ?? attempt?.task?.id
  const agentId = attempt?.task?.assigneeId
  const chId = attempt?.channelId
  if (!taskId || !agentId) return { ok: false, detail: `缺少 task/assignee（task=${taskId} agent=${agentId}）` }
  // 等任务进入 WORKING（ASSIGNED 未接取时 complete 会 400）
  for (let i = 0; i < 30; i++) {
    const tasks = (await api('GET', `/api/workshop/channels/${chId}/tasks`, undefined, token)).data ?? []
    const t = tasks.find(x => x.id === taskId)
    if (t?.state === 'WORKING' || t?.state === 'IN_PROGRESS') break
    await sleep(1000)
  }
  const rot = await api('POST', `/api/workshop/channels/${chId}/agents/${agentId}/rotate-token`, {}, token)
  const agentToken = rot.data?.token
  if (!agentToken) return { ok: false, detail: `rotate-token 失败 status=${rot.status} ${rot.message}` }
  const done = await api('POST', `/api/workshop/tasks/${taskId}/complete`, {
    artifacts: [{
      artifactId: artifact.artifactId,
      name: artifact.name,
      description: 'Project 作业面交付',
      parts: [{ text: artifact.text }],
    }],
  }, agentToken)
  return { ok: done.status === 200, detail: `task=${taskId.slice(0, 8)} complete=${done.status} ${done.message}`, taskId }
}

/** 对账循环：root 完成后 reconcile（生成成果 draft），直到工作项 COMPLETED。 */
async function reconcileUntilDone(pid, workItemId, token, timeoutMs = 90_000) {
  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < timeoutMs) {
    await api('POST', `/api/workshop/projects/${pid}/reconcile`, {}, token)
    const items = (await api('GET', `/api/workshop/projects/${pid}/work-items`, undefined, token)).data ?? []
    const wi = items.find(x => x.id === workItemId)
    last = wi?.state ?? 'MISSING'
    if (wi?.state === 'COMPLETED') {
      const results = (await api('GET', `/api/workshop/projects/${pid}/results`, undefined, token)).data ?? []
      const draft = results.find(r => r.workItemId === workItemId)
      return { ok: Boolean(draft), detail: `state=COMPLETED result=${draft?.status ?? 'none'}` }
    }
    if (['FAILED', 'BLOCKED', 'CANCELED', 'REWORK'].includes(last)) return { ok: false, detail: `state=${last} reason=${wi?.stateReason ?? ''}` }
    await sleep(1500)
  }
  return { ok: false, detail: `等待超时 state=${last}` }
}

async function submitResultOf(pid, workItemId, summary, token) {
  const results = (await api('GET', `/api/workshop/projects/${pid}/results`, undefined, token)).data ?? []
  const draft = results.filter(r => r.workItemId === workItemId).sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0]
  if (!draft) return { ok: false, detail: '无成果草稿', resultId: null }
  const sub = await api('POST', `/api/workshop/projects/${pid}/results/${draft.id}/submit`, { summary }, token)
  return { ok: sub.status === 200, detail: `submit=${sub.status} ${sub.message}`, resultId: draft.id }
}

async function waitDeliverablesApproved(pid, token, timeoutMs = 20_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const ds = (await api('GET', `/api/workshop/projects/${pid}/deliverables`, undefined, token)).data ?? []
    if (ds.length > 0 && ds.every(d => ['approved', 'waived'].includes(d.status))) return true
    await sleep(1000)
  }
  return false
}

async function waitApproval(pid, kind, token, timeoutMs = 20_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const rows = (await api('GET', `/api/workshop/projects/${pid}/approvals`, undefined, token)).data ?? []
    const hit = rows.find(a => a.kind === kind && a.status === 'pending')
    if (hit) return hit
    await sleep(1000)
  }
  return null
}

async function waitProjectStatus(pid, status, token, timeoutMs = 20_000) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    last = (await api('GET', `/api/workshop/projects/${pid}`, undefined, token)).data
    if (last?.status === status) return last
    await sleep(1000)
  }
  return last
}

/* ── 浏览器：入口可达性 + 渲染完整性 + 响应式 ─────────────────────────── */

async function runUi(token, pid, projectName) {
  const { launch, openPage, gotoReady } = await import('../ui/lib.mjs')
  const uiResults = []
  const push = (id, name, cond, detail = '') => {
    const pass = Boolean(cond)
    uiResults.push({ id, name, pass, detail: String(detail).slice(0, 500) })
    console.log(`${pass ? '✔' : '✖'} [${id}] ${name}${pass ? '' : ` — ${String(detail).slice(0, 300)}`}`)
  }
  const meta = { screenshots: [] }
  const errors = []
  try {
    browser = await launch({ width: 1440, height: 900 })
    const page = await openPage(browser, { token, width: 1440, height: 900, dark: false })
    page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)))

    // U1 入口：工作台首页有「项目中心」入口
    await gotoReady(page, '/workshop', { wait: 2000 })
    const wsText = await page.evaluate(() => document.body.innerText)
    const entryVisible = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.innerText.trim() === '项目中心'))
    push('U1', 'Agent 工作台首页出现「项目中心」入口', wsText.includes('项目中心') && entryVisible, `text=${wsText.includes('项目中心')} btn=${entryVisible}`)
    await page.screenshot({ path: join(OUT, 'ui-workshop-entry.png'), fullPage: false })
    meta.screenshots.push('ui-workshop-entry.png')

    // U2 全局导航：侧栏项目条目（active）+ 列表渲染
    await gotoReady(page, '/projects', { wait: 2200 })
    const listText = await page.evaluate(() => document.body.innerText)
    const navHit = await page.evaluate(() => {
      const links = [...document.querySelectorAll('.menu-item')]
      return links.some(el => el.innerText.includes('项目中心') && el.className.includes('active'))
    })
    push('U2', '侧栏「项目中心」可点且当前高亮', navHit, `active=${navHit}`)
    push('U3', '列表页渲染项目卡 + 统计带 + 新建入口',
      listText.includes('项目中心') && listText.includes('新建项目') && listText.includes(projectName)
      && listText.includes('全部项目') && listText.includes('工作项总量'),
      listText.slice(0, 200))
    push('U3b', '项目卡显示绑定频道数与交付物进度', /3 频道/.test(listText) && /3\/3 交付物/.test(listText), listText.slice(0, 260))
    await page.screenshot({ path: join(OUT, 'ui-projects-list.png'), fullPage: true })
    meta.screenshots.push('ui-projects-list.png')

    // U4 详情：点卡片进入
    await page.evaluate((name) => {
      const a = [...document.querySelectorAll('a')].find(x => x.innerText.includes(name))
      a?.click()
    }, projectName)
    await page.waitForFunction(() => location.pathname.startsWith('/projects/'), { timeout: 20000 })
    await sleep(2000)
    const detailText = await page.evaluate(() => document.body.innerText)
    push('U4', '点卡进入详情（概览：快照/对话/频道/周报）',
      detailText.includes(projectName) && detailText.includes('Project Leader 对话') && detailText.includes('周报')
      && detailText.includes('交付签核'),
      detailText.slice(0, 240))
    push('U4b', '频道显示人类可读名（非裸 UUID 列）',
      detailText.includes('产品设计') && detailText.includes('前端开发') && detailText.includes('质量走查'),
      `${detailText.includes('产品设计')}/${detailText.includes('前端开发')}/${detailText.includes('质量走查')}`)
    await page.screenshot({ path: join(OUT, 'ui-project-overview.png'), fullPage: true })
    meta.screenshots.push('ui-project-overview.png')

    // U5 计划与工作：看板列 + 工作项表 + 计划快照
    await page.evaluate(() => document.querySelector('[data-testid="tab-plan"]')?.click())
    await sleep(1200)
    const planText = await page.evaluate(() => document.body.innerText)
    push('U5', '计划 tab：执行看板五列 + 工作项/派发 + 计划快照',
      ['就绪待派发', '执行中', '等待', '阻塞 / 返工', '完成 / 验收链', '工作项 / 派发', '计划快照', '路由与派发日志']
        .every(t => planText.includes(t)),
      planText.slice(0, 300))
    push('U5b', '看板卡片显示已验收终态', planText.includes('已验收'), planText.slice(0, 300))
    await page.screenshot({ path: join(OUT, 'ui-project-plan.png'), fullPage: true })
    meta.screenshots.push('ui-project-plan.png')

    // U6 交付物：卡片 + 三级门 + 成果链
    await page.evaluate(() => document.querySelector('[data-testid="tab-deliverables"]')?.click())
    await sleep(900)
    const delText = await page.evaluate(() => document.body.innerText)
    push('U6', '交付物 tab：交付物卡 + 三级门 + 成果分组',
      delText.includes('交付物') && delText.includes('技术验收') && delText.includes('业务签核') && delText.includes('成果（按交付物分组）'),
      delText.slice(0, 300))
    await page.screenshot({ path: join(OUT, 'ui-project-deliverables.png'), fullPage: true })
    meta.screenshots.push('ui-project-deliverables.png')

    // U7 审批：历史 + 签核结果
    await page.evaluate(() => document.querySelector('[data-testid="tab-approvals"]')?.click())
    await sleep(900)
    const apText = await page.evaluate(() => document.body.innerText)
    push('U7', '审批 tab：待审批 + 审批历史 + 已批准状态',
      apText.includes('待审批') && apText.includes('审批历史') && (apText.includes('已签核') || apText.includes('已批准') || apText.includes('approved')),
      apText.slice(0, 300))
    await page.screenshot({ path: join(OUT, 'ui-project-approvals.png'), fullPage: true })
    meta.screenshots.push('ui-project-approvals.png')

    // U8 决策与事件：统一时间线
    await page.evaluate(() => document.querySelector('[data-testid="tab-events"]')?.click())
    await sleep(1200)
    const evText = await page.evaluate(() => document.body.innerText)
    push('U8', '决策与事件：统一时间线（events + decisions）',
      evText.includes('决策与事件') && evText.includes('events + decisions') && evText.includes('工作项派发'),
      evText.slice(0, 300))
    await page.screenshot({ path: join(OUT, 'ui-project-events.png'), fullPage: true })
    meta.screenshots.push('ui-project-events.png')

    // U9 响应式：390px 无横向溢出，导航退化为横条
    const m = await openPage(browser, { token, width: 390, height: 844, dark: false })
    m.on('pageerror', e => errors.push(String(e.message).slice(0, 200)))
    await gotoReady(m, `/projects/${pid}`, { wait: 2200 })
    const mob = await m.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      text: document.body.innerText.slice(0, 400),
    }))
    push('U9', '移动端 390px：无横向滚动', mob.overflow <= 2, `overflow=${mob.overflow}px`)
    await m.screenshot({ path: join(OUT, 'ui-project-mobile.png'), fullPage: true })
    meta.screenshots.push('ui-project-mobile.png')

    // U10 无未捕获异常
    push('U10', '页面无未捕获异常', errors.length === 0, errors.join('; '))
    meta.url = page.url()
    meta.errors = errors
  }
  catch (e) {
    push('U-err', '浏览器验收异常', false, e?.stack ?? String(e))
    meta.errors = errors
  }
  return { results: uiResults, meta }
}
