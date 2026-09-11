/**
 * town-focus-shot.mjs —— 只拍数字孪生,并尝试把 3D 视角调到能看清设备
 * 用 window.__townStats 读真实渲染指标(设备数/实例数/FPS)作为"模型真的在场"的判据,
 * 而不是靠肉眼看截图。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const BASE = arg('base', 'http://127.0.0.1:3112').replace(/\/$/, '')
const OUT = arg('out', join(REPO, '.e2e-shots', 'plc-clean'))
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME
const sleep = ms => new Promise(r => setTimeout(r, ms))

mkdirSync(OUT, { recursive: true })
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'plant@awshop.local', password: 'Plant!2026' }),
}).then(r => r.json()).catch(() => null)
const token = login?.data?.token ?? ''
if (!token) { console.error('✖ 登录失败'); process.exit(2) }

const browser = await puppeteer.launch({
  executablePath: EXEC,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1', '--hide-scrollbars', '--use-gl=angle', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1920, height: 1200 },
})
try {
  const page = await browser.newPage()
  await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.evaluate((tok) => {
    document.cookie = `token=${encodeURIComponent(tok)}; path=/`
    document.cookie = 'aw-theme=light; path=/'
    localStorage.setItem('app', JSON.stringify({ isDark: false, sidebarCollapsed: true, accent: '', themeTouched: true }))
  }, token)
  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 })
  // 3D 首帧 + 模型 GLB 异步加载,给足时间
  await sleep(12000)

  const stats = await page.evaluate(() => {
    const s = globalThis.__townStats
    return s ? JSON.parse(JSON.stringify(s)) : null
  })
  console.log('window.__townStats =', JSON.stringify(stats))

  // 尝试点「复位视角」把相机拉到能看全设备的位置(按钮存在才点)
  const resetBtn = await page.evaluateHandle(() => {
    const els = [...document.querySelectorAll('button, .ant-btn, [role="button"]')]
    return els.find(e => /复位视角|重置视角|复位/.test(e.textContent ?? '')) ?? null
  })
  const el = resetBtn.asElement()
  if (el) {
    await el.click().catch(() => {})
    console.log('已点击「复位视角」')
    await sleep(3500)
  }
  else {
    console.log('未找到「复位视角」按钮,跳过')
  }

  // 相机默认拉得很远,设备只有几十像素;点几次放大让设备读得清
  const zoomIn = await page.evaluateHandle(() => {
    const els = [...document.querySelectorAll('button, .ant-btn, [role="button"], [class*="zoom"]')]
    return els.find((e) => {
      const txt = (e.textContent ?? '').trim()
      const title = `${e.getAttribute('title') ?? ''} ${e.getAttribute('aria-label') ?? ''}`
      return txt === '+' || txt === '＋' || /放大|zoom in/i.test(title)
    }) ?? null
  })
  const z = zoomIn.asElement()
  const ZOOM_CLICKS = Number(arg('zoom', '2'))
  if (z) {
    for (let i = 0; i < ZOOM_CLICKS; i++) {
      await z.click().catch(() => {})
      await sleep(700)
    }
    console.log(`已放大 ${ZOOM_CLICKS} 档`)
  }
  else {
    console.log('未找到放大按钮,保持默认视角')
  }
  await sleep(1500)

  const file = join(OUT, '数字孪生小镇-1920.png')
  await page.screenshot({ path: file, fullPage: false })
  console.log(`截图 → ${file}`)

  // 再出一张只含 3D 视口的图:全页截图里场景只占一小块,细节看不出来
  const viewport = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')].map((c) => {
      const r = c.getBoundingClientRect()
      return { w: r.width, h: r.height, x: r.x, y: r.y }
    }).filter(c => c.w > 200 && c.h > 200)
    canvases.sort((a, b) => b.w * b.h - a.w * a.h)
    const c = canvases[0]
    if (!c) return null
    // 把 HUD(统计条/趋势/控制面板)也算进去,给出完整场景区
    return { x: Math.max(0, c.x - 10), y: Math.max(0, c.y - 60), width: c.w + 20, height: c.h + 80 }
  })
  if (viewport) {
    const sceneFile = join(OUT, '数字孪生小镇-3D视口.png')
    await page.screenshot({ path: sceneFile, clip: viewport })
    console.log(`3D 视口截图 → ${sceneFile}  ${JSON.stringify(viewport)}`)
  }

  const canvasInfo = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')].map((c) => {
      const r = c.getBoundingClientRect()
      return `${c.width}x${c.height} css ${Math.round(r.width)}x${Math.round(r.height)}`
    })
    return cs
  })
  console.log('canvases:', JSON.stringify(canvasInfo))
  console.log(stats && (stats.devices ?? stats.deviceCount) ? '✅ 场景内确有设备实例' : '⚠ __townStats 未暴露设备计数,以截图为准')
}
finally {
  await browser.close()
}
