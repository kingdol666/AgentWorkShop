#!/usr/bin/env node
/**
 * hitl-ui-two-harness-demo.mjs —— omp ask + dsh 权限 HITL 的群聊界面演示。
 *
 * omp: 原生 ask 提问 Proceed? yes/no → 群聊页铃标下拉 → 点 yes → 提交答案
 *      → 断言该待办清空、任务交付物含 yes。
 * dsh: shell 操作触发 dsh-permission(Allow once/Reject)→ 群聊页铃标下拉
 *      → 点“批准” → 断言该待办清空、任务不再停留在 SUBMITTED。
 *
 * 运行:AW_E2E_TOKEN=<admin token> node scripts/hitl-ui-two-harness-demo.mjs [--base ...]
 * 产物:docs/audit/2026-10-20-harness-acceptance-evidence/hitl-ui-{omp,dsh}.png
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (k, d = '') => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const BASE = argOf('--base', process.env.AW_BASE ?? 'http://127.0.0.1:3001')
const TOKEN = process.env.AW_E2E_TOKEN ?? process.env.AW_TOKEN ?? ''
const SHOT_DIR = 'docs/audit/2026-10-20-harness-acceptance-evidence'
const TAG = Date.now().toString(36)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const checks = []
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${String(detail).slice(0, 220)}`)
  checks.push({ name, ok: !!cond, detail: String(detail).slice(0, 500) })
  return !!cond
}
if (!TOKEN) {
  console.error('缺少 AW_E2E_TOKEN / AW_TOKEN')
  process.exit(1)
}
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
async function pendingItem(channelId, kind) {
  const p = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`)
  return (p.data?.items ?? []).find(i => i.kind === kind) ?? null
}
async function waitPending(channelId, kind, timeoutMs) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const it = await pendingItem(channelId, kind)
    if (it) return it
    await sleep(2500)
  }
  return null
}
async function waitCleared(channelId, kind, id, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const it = (await (async () => {
      const p = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`)
      return (p.data?.items ?? []).find(i => i.kind === kind && i.id === id) ?? null
    })())
    if (!it) return true
    await sleep(1000)
  }
  return false
}
async function taskOf(id) {
  return (await api('GET', `/api/workshop/tasks/${id}`)).data
}

async function openChannelPage(browser, me, workspaceId, channelName) {
  const page = await browser.newPage()
  await page.evaluateOnNewDocument((inject) => {
    localStorage.setItem('workshop.user', JSON.stringify({ user: { ...inject.me, token: inject.token } }))
    document.cookie = `token=${inject.token}; path=/; max-age=31536000`
  }, { me, token: TOKEN })
  // /workshop/w/<wsId> 是 workspace 控制台;先点左栏 Channel 进入群聊,再开 HITL 铃标。
  await page.goto(`${BASE}/workshop/w/${workspaceId}`, { waitUntil: 'networkidle2', timeout: 60_000 })
  await page.waitForSelector('.channel-item', { timeout: 60_000 })
  await page.evaluate((name) => {
    const item = [...document.querySelectorAll('.channel-item')]
      .find(el => el.textContent.includes(name))
    item?.click()
  }, channelName)
  await sleep(2000)
  await page.waitForSelector('.channel-item.active', { timeout: 30_000 })
  await page.waitForSelector('.hitl-bell', { timeout: 60_000 })
  await page.click('.hitl-bell')
  await page.waitForSelector('.hitl-menu .hitl-item', { timeout: 10_000 })
  return page
}

async function itemInfo(page, needle) {
  return await page.evaluate((n) => {
    const el = [...document.querySelectorAll('.hitl-menu .hitl-item')]
      .find(x => x.textContent.includes(n)) ?? null
    if (!el) return null
    return {
      text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 240),
      options: [...el.querySelectorAll('.hitl-opt')].map(x => x.textContent.trim()),
      buttons: [...el.querySelectorAll('.hitl-btns .ant-btn, .hitl-btns button')].map(x => x.textContent.trim()),
    }
  }, needle)
}

async function clickOption(page, needle, optionText) {
  return await page.evaluate(({ n, t }) => {
    const el = [...document.querySelectorAll('.hitl-menu .hitl-item')]
      .find(x => x.textContent.includes(n)) ?? null
    if (!el) return false
    const opt = [...el.querySelectorAll('.hitl-opt')]
      .find(x => x.textContent.trim().toLowerCase() === t.toLowerCase())
    opt?.click()
    return Boolean(opt)
  }, { n: needle, t: optionText })
}

async function clickPrimary(page, needle) {
  return await page.evaluate((n) => {
    const el = [...document.querySelectorAll('.hitl-menu .hitl-item')]
      .find(x => x.textContent.includes(n)) ?? null
    if (!el) return false
    const btn = [...el.querySelectorAll('.hitl-btns .ant-btn-primary, .hitl-btns button')]
      .find(x => !x.disabled)
    btn?.click()
    return Boolean(btn)
  }, needle)
}

async function clickApprove(page, needle) {
  return await page.evaluate((n) => {
    const el = [...document.querySelectorAll('.hitl-menu .hitl-item')]
      .find(x => x.textContent.includes(n)) ?? null
    if (!el) return false
    // Ant Design 两字按钮会渲染成“批 准”
    const btn = [...el.querySelectorAll('.hitl-btns .ant-btn')]
      .find(x => /批\s*准|approve/i.test(x.textContent) && !x.disabled)
    btn?.click()
    return Boolean(btn)
  }, needle)
}

async function main() {
  console.log(`━━━ HITL 群聊 UI 双 harness 演示 @ ${BASE} (tag=${TAG}) ━━━`)
  const me = (await api('GET', '/api/users/me')).data ?? {}
  mkdirSync(SHOT_DIR, { recursive: true })
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    protocolTimeout: 300_000,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 },
  })

  // 专用 workspace:把演示 Channel 挂进去,群聊页才能显示该 Channel
  const ws = await api('POST', '/api/workshop/workspaces', { name: `hitl-ui-${TAG}` })
  const wsId = ws.data?.workspace?.id ?? ws.data?.id
  ok('演示 workspace 创建', Boolean(wsId), wsId ?? ws.message)

  // ── omp ask ──
  const och = await api('POST', '/api/workshop/channels', {
    name: `ui-omp-${TAG}`,
    leadAgent: { name: `ui-omp-${TAG}`, harness: 'omp' },
  })
  const oChannel = och.data?.channelId
  await api('POST', `/api/workshop/workspaces/${wsId}/channels/${oChannel}`)
  const oAgentName = `ui-omp-${TAG}`
  const oTask = (await api('POST', `/api/workshop/channels/${oChannel}/tasks`, {
    title: `ui-omp-${TAG}`,
    description: 'Use the ask tool NOW to ask me exactly one question: "Proceed?" with options yes and no. '
      + 'Do not do anything else. After I answer, call complete_task with summary set to my exact answer.',
  })).data?.id
  const oItem = await waitPending(oChannel, 'omp-dialog', 180_000)
  ok('omp ask 待办出现', Boolean(oItem), oItem ? `options=${JSON.stringify(oItem.options)} requestType=${oItem.requestType}` : '超时')
  if (oItem) {
    const page = await openChannelPage(browser, me, wsId, `ui-omp-${TAG}`)
    const info = await itemInfo(page, oAgentName)
    ok('omp 群聊页渲染 ask 选项', Boolean(info?.options?.some(x => x.toLowerCase() === 'yes')), JSON.stringify(info?.options ?? []))
    await page.screenshot({ path: `${SHOT_DIR}/hitl-ui-omp.png` })
    const picked = await clickOption(page, oAgentName, 'yes')
    await sleep(700)
    const submitted = await clickPrimary(page, oAgentName)
    ok('omp 群聊页点击 yes 并提交', picked && submitted, `picked=${picked} submitted=${submitted}`)
    const cleared = await waitCleared(oChannel, 'omp-dialog', oItem.id, 30_000)
    ok('omp 提交后该待办清空', cleared, `id=${oItem.id}`)
    let oDone = null
    for (let i = 0; i < 20; i++) {
      await sleep(3000)
      oDone = await taskOf(oTask)
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(oDone?.state)) break
    }
    const text = (oDone?.artifacts ?? []).flatMap(a => a.parts ?? []).map(p => String(p.text ?? '')).join('')
    ok('omp agent 收到 yes', oDone?.state === 'COMPLETED' && /\byes\b/i.test(text), `state=${oDone?.state} deliverable=${text.slice(0, 120)}`)
    await page.close()
  }

  // ── dsh 权限 ──
  const dch = await api('POST', '/api/workshop/channels', {
    name: `ui-dsh-${TAG}`,
    leadAgent: { name: `ui-dsh-${TAG}`, harness: 'dsh', config: { approvalPolicy: 'ask' } },
  })
  const dChannel = dch.data?.channelId
  await api('POST', `/api/workshop/workspaces/${wsId}/channels/${dChannel}`)
  const dAgentName = `ui-dsh-${TAG}`
  const dTask = (await api('POST', `/api/workshop/channels/${dChannel}/tasks`, {
    title: `ui-dsh-${TAG}`,
    description: 'Run the shell command "echo DSH-UI-HITL" to verify the environment. This action requires human approval; wait for the approval result.',
  })).data?.id
  const dItem = await waitPending(dChannel, 'dsh-permission', 180_000)
  ok('dsh 权限待办出现', Boolean(dItem), dItem ? `options=${JSON.stringify(dItem.options)} method=${dItem.method}` : '超时')
  if (dItem) {
    const page = await openChannelPage(browser, me, wsId, `ui-dsh-${TAG}`)
    const info = await itemInfo(page, dAgentName)
    ok('dsh 群聊页渲染批准/拒绝', Boolean(info?.buttons?.some(x => /批\s*准/.test(x))), JSON.stringify(info?.buttons ?? []))
    await page.screenshot({ path: `${SHOT_DIR}/hitl-ui-dsh.png` })
    const clicked = await clickApprove(page, dAgentName)
    ok('dsh 群聊页点击批准', clicked)
    const cleared = await waitCleared(dChannel, 'dsh-permission', dItem.id, 30_000)
    ok('dsh 批准后该待办清空', cleared, `id=${dItem.id}`)
    let dDone = null
    for (let i = 0; i < 15; i++) {
      await sleep(3000)
      dDone = await taskOf(dTask)
      if (['WORKING', 'COMPLETED', 'FAILED', 'CANCELED'].includes(dDone?.state)) break
    }
    ok('dsh 任务批准后继续(非 SUBMITTED)', dDone?.state !== 'SUBMITTED', `state=${dDone?.state}`)
    await page.close()
  }

  await browser.close()
  const pass = checks.filter(c => c.ok).length
  console.log(`\n=== HITL 群聊 UI 演示: ${pass} PASS / ${checks.length - pass} FAIL ===`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`${SHOT_DIR}/hitl-ui-two-harness.json`, JSON.stringify({ at: new Date().toISOString(), checks }, null, 2))
  process.exit(pass === checks.length ? 0 : 1)
}
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
