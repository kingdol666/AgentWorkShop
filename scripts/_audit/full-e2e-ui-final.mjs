#!/usr/bin/env node
/**
 * scripts/_audit/full-e2e-ui-final.mjs —— UI 终验:
 *   U1 种 3 个 DAQ 孪生实体(绑真实数采节点)→ /town 渲染断言(__townStats.devices>0)
 *   U2 控制台 composer 实发群聊(evaluate 填值 + Enter 键事件派发)
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3474'
const SHOTS = join(tmpdir(), 'aw-full-e2e-fmtJ6b', 'shots')
const sleep = ms => new Promise(r => setTimeout(r, ms))
process.env.AW_BASE = BASE
process.env.AW_UI_SCALE = '1'
const { launch, openPage, gotoReady } = await import('../ui/lib.mjs')
const withT = (label, ms, fn) => new Promise((resolve) => {
  let settled = false
  const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
  const timer = setTimeout(() => done({ okT: false, e: new Error(`timeout:${label}`) }), ms)
  Promise.resolve().then(fn).then(v => done({ okT: true, v }), e => done({ okT: false, e }))
})
let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`) }
}
const callA = async (method, path, body, token) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
  })
  return r.json().catch(() => null)
}

const login = await callA('POST', '/api/users/login', { email: 'e2e-full@awshop.local', password: 'E2eFull2026!' })
const TOKEN = login?.data?.token

/* U1 种孪生实体 + /town 渲染 */
{
  const daq = await callA('GET', '/api/workshop/daq', undefined, TOKEN)
  const nodes = daq?.data?.nodes ?? daq?.data?.items ?? []
  const pick = kw => nodes.find(n => (n.name ?? '').includes(kw))
  const seeds = [
    { name: '温度传感器孪生', kw: '温度', x: -3, z: -2 },
    { name: '膜厚传感器孪生', kw: '膜厚', x: 0, z: -2 },
    { name: '压力变送器孪生', kw: '压力', x: 3, z: -2 },
  ].map((s) => {
    const n = pick(s.kw)
    return n ? { name: s.name, kind: 'daq', modelRef: `daq-${n.templateRef ?? 'tc'}`, telemetry: { nodeId: n.id }, posX: s.x, posZ: s.z } : null
  }).filter(Boolean)
  let created = 0
  for (const s of seeds) {
    const r = await callA('POST', '/api/workshop/device-twins', s, TOKEN)
    if (r?.code === 0) created++
    else console.log(`  ↳ 实体 ${s.name}: ${JSON.stringify(r).slice(0, 90)}`)
  }
  ok('U1a DAQ 孪生实体落库', created >= 3, `created=${created}/${seeds.length}`)

  const b = await launch()
  try {
    const page = await openPage(b, { token: TOKEN, width: 1440, height: 900 })
    await gotoReady(page, '/town', { wait: 12000, timeout: 50000 })
    const town = await withT('town', 30000, () => page.evaluate(() => {
      const stats = window.__townStats
      return { devices: Number(stats?.devices ?? 0) || 0, fps: Number(stats?.fps ?? 0) || null, keys: stats ? Object.keys(stats).length : 0 }
    }))
    await page.screenshot({ path: join(SHOTS, 'final-town-entities.png') })
    ok('U1b 孪生空间渲染实体(devices>0)', town.okT && town.v?.devices > 0, town.okT ? JSON.stringify(town.v) : String(town.e))
    ok('U1c 孪生引擎仪表(键≥8)', town.okT && town.v?.keys >= 8, `keys=${town.v?.keys}`)

    /* U2 控制台 composer 实发(Enter 键事件) */
    const wsList = (await callA('GET', '/api/workshop/workspaces', undefined, TOKEN))?.data
    const wsId = (Array.isArray(wsList) ? wsList : (wsList?.items ?? [])).slice(-1)[0]?.id
    await gotoReady(page, `/workshop/w/${wsId}`, { wait: 3500, timeout: 50000 })
    const clicked = await withT('click', 30000, () => page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('[class*=channel], li, a, [role=button]'))
        .find(e => (e.textContent ?? '').includes('补测-team') && e.offsetHeight > 0)
      if (el) { el.click(); return true }
      return false
    }))
    await sleep(3000)
    const MSG = 'UI 直发(Enter 键):控制台群聊消息 ✓'
    const filled = await withT('fill', 30000, () => page.evaluate((msg) => {
      const ta = document.querySelector('.composer-pane textarea') ?? document.querySelector('textarea')
      if (!ta) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, msg)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.focus()
      return true
    }, MSG))
    const sent = await withT('enter', 30000, () => page.evaluate(() => {
      const ta = document.querySelector('.composer-pane textarea') ?? document.querySelector('textarea')
      if (!ta) return false
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
      return true
    }))
    await sleep(4500)
    const inTimeline = await withT('assert', 30000, () => page.evaluate((msg) => {
      const tas = Array.from(document.querySelectorAll('textarea'))
      const inEditor = tas.some(t => t.value === msg)
      return (document.body.innerText ?? '').includes(msg) && !inEditor
    }, MSG))
    await page.screenshot({ path: join(SHOTS, 'final-console-sent.png') })
    ok('U2 控制台 composer 实发群聊(Enter)', clicked && filled && sent && inTimeline, `clicked=${clicked} filled=${filled} sent=${sent} inTimeline=${inTimeline}`)
  }
  finally { await withT('close', 12000, () => b.close()).catch(() => { try { b.process()?.kill() } catch {} }) }
}
console.log(`\n═══ UI 终验:${pass} PASS / ${fails.length} FAIL ═══`)
process.exit(fails.length ? 1 : 0)
