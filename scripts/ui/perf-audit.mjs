/**
 * 前端实时链路性能体检 —— 用真实浏览器量"数据刷新是否把主线程压垮"。
 *
 * 量的是四件事(全部来自运行时,不是估算):
 *  1. Long Task:>50ms 的主线程阻塞任务数 与 总阻塞时长(TBT)
 *  2. FPS:用 requestAnimationFrame 采样的真实帧率 + 掉帧比例
 *  3. DOM 变更速率:每秒多少次节点/属性变更(重渲染churn 的直接代理指标)
 *  4. CDP Performance 指标:ScriptDuration / LayoutDuration / RecalcStyleDuration 的增量
 *
 * 用法: node scripts/ui/perf-audit.mjs [--routes daq,town,dashboard] [--secs 20] [--vp 1440x900]
 */
import { ensureVisualUser, launch, openPage, gotoReady, sleep, ROUTES } from './lib.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const ONLY = arg('routes', 'daq,town,dashboard,monitor')
const SECS = Number(arg('secs', 20))
const [W, H] = arg('vp', '1440x900').split('x').map(Number)

const picks = ROUTES.filter(r => ONLY.split(',').includes(r.name))
// 频道会话台(/workshop/w/<id>)不在静态 ROUTES 里,但它是事件最密的页面 ——
// 用真实 workspace id 合成一条,才能量到"Agent 事件流是否压垮主线程"。

const token = await ensureVisualUser()
// 频道会话台(/workshop/w/<id>)不在静态 ROUTES 里,但它是事件最密的页面 ——
// 用真实 workspace id 合成一条,才能量到"Agent 事件流是否压垮主线程"。
if (ONLY.includes('console')) {
  const { api } = await import('./lib.mjs')
  const ws = await api('GET', '/api/workshop/workspaces', { token })
  const list = ws.data?.workspaces ?? ws.data ?? []
  const wid = (Array.isArray(list) ? list[0] : null)?.id
  if (wid) picks.push({ path: `/workshop/w/${wid}`, name: 'console', title: '频道会话台' })
  else console.log('!! 没有可用工作区,跳过 console(先跑 scripts/ui/seed-demo.mjs)')
}
const browser = await launch()

const INSTRUMENT = () => {
  const w = window
  w.__perf = { longTasks: 0, tbt: 0, frames: 0, slowFrames: 0, mutations: 0, last: performance.now(), maxGap: 0 }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        w.__perf.longTasks++
        w.__perf.tbt += Math.max(0, e.duration - 50)
      }
    }).observe({ entryTypes: ['longtask'] })
  }
  catch { /* 不支持 longtask 就只靠 FPS */ }
  const mo = new MutationObserver((recs) => {
    w.__perf.mutations += recs.length
  })
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
  const tick = (t) => {
    const p = w.__perf
    const gap = t - p.last
    p.last = t
    if (p.frames > 0) {
      if (gap > p.maxGap) p.maxGap = gap
      if (gap > 33) p.slowFrames++
    }
    p.frames++
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

const rows = []
for (const r of picks) {
  const page = await openPage(browser, { token, dark: true, width: W, height: H, deviceScaleFactor: 1 })
  const errs = []
  page.on('pageerror', e => errs.push(String(e.message).slice(0, 140)))
  try {
    await gotoReady(page, r.path, { wait: 4000 })
    await page.evaluate(INSTRUMENT)
    const client = await page.createCDPSession()
    await client.send('Performance.enable')
    const m0 = await client.send('Performance.getMetrics')
    const t0 = Date.now()

    await sleep(SECS * 1000)

    const m1 = await client.send('Performance.getMetrics')
    const p = await page.evaluate(() => ({ ...window.__perf }))
    const metric = (name) => {
      const a = m0.metrics.find(x => x.name === name)?.value ?? 0
      const b = m1.metrics.find(x => x.name === name)?.value ?? 0
      return b - a
    }
    const secs = (Date.now() - t0) / 1000
    const row = {
      route: r.name,
      secs: +secs.toFixed(1),
      fps: +(p.frames / secs).toFixed(1),
      slowFramePct: +((p.slowFrames / Math.max(1, p.frames)) * 100).toFixed(1),
      maxGapMs: Math.round(p.maxGap),
      longTasks: p.longTasks,
      tbtMs: Math.round(p.tbt),
      mutPerSec: Math.round(p.mutations / secs),
      scriptMs: Math.round(metric('ScriptDuration') * 1000),
      layoutMs: Math.round(metric('LayoutDuration') * 1000),
      styleMs: Math.round(metric('RecalcStyleDuration') * 1000),
      nodes: Math.round(metric('Nodes')),
      listeners: Math.round(metric('JSEventListeners')),
      pageErrors: errs.length,
    }
    rows.push(row)
    console.log(JSON.stringify(row))
  }
  catch (e) {
    console.log(r.name, 'FAIL', String(e.message).slice(0, 120))
  }
  await page.close()
}
await browser.close()
console.log('\n路由          FPS   掉帧%  最大间隔  长任务  阻塞ms  DOM变更/s  脚本ms  布局ms  样式ms')
for (const r of rows) {
  console.log(
    r.route.padEnd(12),
    String(r.fps).padStart(5),
    String(r.slowFramePct).padStart(6),
    String(r.maxGapMs).padStart(8),
    String(r.longTasks).padStart(7),
    String(r.tbtMs).padStart(7),
    String(r.mutPerSec).padStart(10),
    String(r.scriptMs).padStart(7),
    String(r.layoutMs).padStart(7),
    String(r.styleMs).padStart(7),
  )
}
