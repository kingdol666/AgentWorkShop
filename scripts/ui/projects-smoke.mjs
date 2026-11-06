#!/usr/bin/env node
/**
 * /projects UI smoke（PR6）：真实浏览器 + 真实服务端 + 真实 API 数据。
 * 覆盖：列表页渲染、详情页渲染、项目/交付物/工作项/成果/审批区域可见、截图证据。
 * 不覆盖：完整交互矩阵（后续 Playwright 行为套件）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = join(tmpdir(), 'aw-projects-ui-smoke')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'home'), { recursive: true })
const EVID = join(REPO, 'docs/audit/evidence/2026-11-03-project-layer')
mkdirSync(EVID, { recursive: true })

let port = 0
for (const p of [3985, 3984, 3983]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1000) })
    if (r.ok) continue
  }
  catch { /* free */ }
  port = p
  break
}
if (!port) throw new Error('无空闲端口')
const BASE = `http://127.0.0.1:${port}`
process.env.AW_BASE = BASE
process.env.NO_PROXY = '127.0.0.1,localhost'

const child = spawn(process.execPath, [join(REPO, '.output/server/index.mjs')], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(port),
    NITRO_PORT: String(port),
    AW_MODE: 'home',
    AW_HOME: join(ROOT, 'home'),
    NUXT_SESSION_PASSWORD: 'ProjectsUi#2026-smoke-key',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', 'ignore', 'ignore'],
  windowsHide: true,
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* ignore */ }
  return { status: res.status, ...json }
}

let browser
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${detail}`}`)
}

try {
  let healthy = false
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    try {
      const h = await api('GET', '/api/health')
      if (h.data?.status === 'ok' && h.data?.workshop === 'ready') {
        healthy = true
        break
      }
    }
    catch { /* wait */ }
  }
  ok('U0', '构建产物服务启动', healthy, `port=${port}`)
  if (!healthy) throw new Error('server not ready')

  const email = `ui-proj-${Date.now().toString(36)}@awshop.local`
  const reg = await api('POST', '/api/users/register', { name: 'ui-admin', email, password: 'UiAdmin#2026' })
  const token = reg.data?.token
  ok('U1', 'admin 注册', Boolean(token), `status=${reg.status}`)
  if (!token) throw new Error('no token')

  const project = (await api('POST', '/api/workshop/projects', {
    name: `UI项目-${Date.now().toString(36).slice(-4)}`,
    objective: '验证项目页渲染与数据绑定',
    leaderHarness: 'mock',
  }, token)).data
  const member = (await api('POST', '/api/workshop/channels', {
    name: 'UI执行频道', leadAgent: { name: 'UI Lead', harness: 'mock' },
  }, token)).data
  await api('POST', `/api/workshop/projects/${project.id}/channels`, { channelId: member.channelId, charter: 'UI验收' }, token)
  const deliverable = (await api('POST', `/api/workshop/projects/${project.id}/deliverables`, {
    name: 'UI交付物', ownerChannelId: member.channelId, acceptanceCriteria: ['可渲染'],
  }, token)).data
  await api('POST', `/api/workshop/projects/${project.id}/work-items`, {
    deliverableId: deliverable.id, channelId: member.channelId, title: 'UI工作项', brief: '渲染验证',
    dedupeKey: 'ui-smoke',
  }, token)
  ok('U2', '真实 API 数据准备', Boolean(project?.id && member?.channelId && deliverable?.id))

  const { launch, openPage, gotoReady } = await import('./lib.mjs')
  browser = await launch({ width: 1440, height: 900 })
  const page = await openPage(browser, { token, width: 1440, height: 900 })
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)))

  await gotoReady(page, '/projects', { wait: 2500 })
  const listText = await page.evaluate(() => document.body.innerText)
  ok('U3', '列表页渲染项目', listText.includes(project.name) && listText.includes('新建项目'), listText.slice(0, 200))
  await page.screenshot({ path: join(EVID, 'projects-list.png'), fullPage: true })

  await gotoReady(page, `/projects/${project.id}`, { wait: 3000 })
  // PR15 五 tab：概览（默认）→ 逐 tab 断言区块可见（innerText 不含 v-show 隐藏区）
  const detailText = await page.evaluate(() => document.body.innerText)
  ok('U4a', '详情页概览 tab：项目名/频道/周报', detailText.includes(project.name) && detailText.includes('频道') && detailText.includes('周报'), detailText.slice(0, 200))
  const clickTab = async (testid) => {
    await page.evaluate((tid) => {
      const el = document.querySelector(`[data-testid="tab-${tid}"]`)
      el?.click()
    }, testid)
    await sleep(500)
    return page.evaluate(() => document.body.innerText)
  }
  const planText = await clickTab('plan')
  const delText = await clickTab('deliverables')
  const apText = await clickTab('approvals')
  const evText = await clickTab('events')
  ok('U4', '五 tab 全渲染：计划与工作/交付物/审批/决策与事件',
    planText.includes('工作项 / 派发') && planText.includes('计划快照')
    && delText.includes('交付物') && delText.includes('成果（按交付物分组）')
    && apText.includes('待审批') && apText.includes('审批历史')
    && evText.includes('决策') && evText.includes('事件'),
    `plan=${planText.includes('工作项 / 派发')} del=${delText.includes('成果（按交付物分组）')} ap=${apText.includes('待审批')} ev=${evText.includes('决策')}`)
  await page.evaluate(() => document.querySelector('[data-testid="tab-overview"]')?.click())
  await sleep(400)
  ok('U5', '页面无未捕获异常', errors.length === 0, errors.join('; '))
  await page.screenshot({ path: join(EVID, 'project-detail.png'), fullPage: true })

  const fail = results.filter(r => !r.pass).length
  console.log(`\n=== UI SMOKE pass=${results.length - fail} fail=${fail} ===`)
  console.log(JSON.stringify({ pass: results.length - fail, fail, results }, null, 2))
  process.exitCode = fail > 0 ? 1 : 0
}
catch (err) {
  console.error('UI smoke 异常:', err)
  process.exitCode = 1
}
finally {
  try {
    await browser?.close()
  }
  catch { /* ignore */ }
  try {
    child.kill()
  }
  catch { /* ignore */ }
  await sleep(300)
}
