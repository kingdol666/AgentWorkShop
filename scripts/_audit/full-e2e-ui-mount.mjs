#!/usr/bin/env node
/**
 * scripts/_audit/full-e2e-ui-mount.mjs —— 全功能 E2E UI 第三轮(补 Workspace 维度)。
 *
 * 首两轮 UI 空态的根因:控制台(/workshop/w/:wsId)与孪生空间(/town)渲染的都是
 * **挂载到 Workspace 的 Channel**(workspace_channels 表);API 裸建的频道未挂载,
 * 空态「还没有挂载任何 Channel」是正确产品行为。
 *
 * 本轮:建 Workspace → 挂载团队频道(已开群聊)+ AML 训练频道 →
 *   控制台点击频道 → composer 实发群聊 → 时间线断言 → /town canvas+__townStats。
 * 用法:node scripts/_audit/full-e2e-ui-mount.mjs
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3474'
const ADMIN = { email: 'e2e-full@awshop.local', password: 'E2eFull2026!' }
const SHOTS = join(tmpdir(), 'aw-full-e2e-fmtJ6b', 'shots')

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const callA = async (method, path, body, token) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
  })
  const json = await r.json().catch(() => null)
  return { status: r.status, json, data: json?.data, message: json?.message }
}

process.env.AW_BASE = BASE
process.env.AW_UI_SCALE = '1'
const { launch, openPage, gotoReady } = await import('../ui/lib.mjs')
const withT = (label, ms, fn) => new Promise((resolve) => {
  let settled = false
  const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
  const timer = setTimeout(() => done({ okT: false, e: new Error(`hard-timeout:${label}(${ms}ms)`) }), ms)
  Promise.resolve().then(fn).then(v => done({ okT: true, v }), e => done({ okT: false, e }))
})
const killBrowser = async (b) => {
  if (!b) return
  const r = await withT('browser-close', 12000, () => b.close())
  if (!r.okT) { try { b.process()?.kill() } catch { /* 已死 */ } }
}

/* ── U1 建工作区 + 挂载频道 ── */
const login = await callA('POST', '/api/users/login', ADMIN)
const TOKEN = login.data?.token
const TAG = Date.now().toString(36)
const ws = await callA('POST', '/api/workshop/workspaces', { name: `E2E工作区-${TAG}` }, TOKEN)
const wsId = ws.data?.id ?? ws.data?.workspace?.id
ok('U1a 创建 Workspace', Boolean(wsId), JSON.stringify(ws.data ?? {}).slice(0, 120))
const chs = (await callA('GET', '/api/workshop/channels', undefined, TOKEN)).data
const chList = Array.isArray(chs) ? chs : (chs?.items ?? [])
const teamCh = [...chList].reverse().find(c => c.name.startsWith('补测-team'))
const amlCh = chList.find(c => c.name === '全功能E2E训练通道')
const m1 = teamCh ? await callA('POST', `/api/workshop/workspaces/${wsId}/channels/${teamCh.id}`, {}, TOKEN) : { status: 400 }
const m2 = amlCh ? await callA('POST', `/api/workshop/workspaces/${wsId}/channels/${amlCh.id}`, {}, TOKEN) : { status: 400 }
ok('U1b 挂载团队频道+AML 频道到工作区', m1.status === 200 && m2.status === 200, `team=${m1.status} aml=${m2.status}`)

/* ── U2 控制台 UI 实发群聊 ── */
/* ── U3 孪生渲染深检(同一浏览器)── */
{
  const r = await withT('ui-console-town', 240000, async () => {
    const b = await launch()
    try {
      const page = await openPage(b, { token: TOKEN, width: 1440, height: 900 })
      await gotoReady(page, `/workshop/w/${wsId}`, { wait: 3500, timeout: 50000 })
      const clicked = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('[class*=channel], li, a, [role=button]'))
          .find(e => (e.textContent ?? '').includes('补测-team') && e.offsetHeight > 0)
        if (el) { el.click(); return true }
        return false
      })
      await sleep(3000)
      const ta = await page.$('.composer-pane textarea') ?? await page.$('textarea')
      let sent = false
      if (ta) {
        await ta.type('UI 直发:控制台 composer 群聊消息(工作区轮)')
        await page.keyboard.press('Enter')
        await sleep(4500)
        sent = await page.evaluate(() => (document.body.innerText ?? '').includes('UI 直发:控制台 composer 群聊消息(工作区轮)'))
      }
      await page.screenshot({ path: join(SHOTS, 'mount-console-chat.png') })
      await gotoReady(page, '/town', { wait: 9000, timeout: 50000 })
      const town = await page.evaluate(() => {
        const canvas = document.querySelector('canvas')
        const stats = window.__townStats
        return {
          canvas: Boolean(canvas), w: canvas?.width ?? 0, h: canvas?.height ?? 0,
          statsKeys: stats ? Object.keys(stats) : [], fps: Number(stats?.fps ?? stats?.fpsAvg ?? 0) || null,
        }
      })
      await page.screenshot({ path: join(SHOTS, 'mount-town.png') })
      return { clicked, sent, town }
    }
    finally { await killBrowser(b) }
  })
  ok('U2 控制台 UI 实发群聊(composer→时间线)', r.okT && r.v?.clicked && r.v?.sent, r.okT ? `clicked=${r.v?.clicked} sent=${r.v?.sent}` : String(r.e).slice(0, 120))
  ok('U3-1 孪生 canvas 渲染(频道挂载后)', r.okT && r.v?.town?.canvas && r.v.town.w > 400, r.okT ? JSON.stringify({ w: r.v.town.w, h: r.v.town.h }) : String(r.e).slice(0, 120))
  ok('U3-2 __townStats 仪表在位', r.okT && (r.v?.town?.statsKeys?.length ?? 0) > 0, r.okT ? `keys=${r.v.town.statsKeys.join(',')} fps=${r.v.town.fps}` : 'n/a')
}

console.log(`\n═══ UI 工作区轮:${pass} PASS / ${fails.length} FAIL ═══`)
if (fails.length) console.log(fails.map(f => `  ✖ ${f}`).join('\n'))
process.exit(fails.length ? 1 : 0)
