import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const project = path.resolve(here, '..')
const build = path.resolve(process.env.AW_VIDEO_BUILD ?? path.join(project, '_build'))
const stills = path.join(project, 'stills')
const base = (process.env.AW_VIDEO_BASE ?? 'http://127.0.0.1:3310').replace(/\/$/, '')
const email = process.env.AW_DEMO_EMAIL
const password = process.env.AW_DEMO_PASSWORD
const chrome = process.env.AW_CHROME ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const ffmpeg = process.env.AW_FFMPEG ?? 'ffmpeg'
const fps = 30

if (!email || !password) throw new Error('Set AW_DEMO_EMAIL and AW_DEMO_PASSWORD for the isolated demo account.')
fs.mkdirSync(path.join(build, 'frames'), { recursive: true })
fs.mkdirSync(path.join(build, 'scenes'), { recursive: true })
fs.mkdirSync(stills, { recursive: true })

const voice = JSON.parse(fs.readFileSync(path.join(build, 'manifest.json'), 'utf8'))
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: false,
  userDataDir: path.join(build, 'browser-profile'),
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
  args: ['--no-first-run', '--no-default-browser-check', '--window-size=1620,960', '--force-color-profile=srgb'],
  protocolTimeout: 180_000,
})

try {
  const page = await browser.newPage()
  const client = await page.createCDPSession()
  await client.send('Page.enable')
  await client.send('Network.enable')
  const login = await fetch(`${base}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const loginBody = await login.json()
  if (loginBody?.code !== 0 || !loginBody.data?.token) throw new Error(loginBody?.message ?? 'Local demo login failed')
  const token = loginBody.data.token
  await client.send('Network.setCookie', {
    name: 'token', value: token, url: base, path: '/', sameSite: 'Lax', secure: false,
  })
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('aw.locale', 'en')
    document.cookie = 'aw.locale=en; path=/; max-age=31536000; samesite=lax'
  })
  const navigate = async (url) => {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    }
    catch (error) {
      if (page.url() !== url) throw error
      console.warn(`Continuing after DOM-ready timeout; waiting for visible page content at ${url}`)
    }
  }
  const getData = async (endpoint) => {
    const res = await fetch(`${base}${endpoint}`, { headers: { authorization: `Bearer ${token}` } })
    const body = await res.json()
    if (body?.code !== 0) throw new Error(`${endpoint}: ${body?.message ?? res.status}`)
    return body.data
  }

  const workspaces = await getData('/api/workshop/workspaces')
  const workspace = (Array.isArray(workspaces) ? workspaces : workspaces?.workspaces ?? [])
    .find(item => item.name === (process.env.AW_DEMO_WORKSPACE ?? 'Demo Operations'))
  if (!workspace?.id) throw new Error('The isolated demo workspace was not found.')
  const linesData = await getData('/api/workshop/dcw/lines')
  const line = (linesData?.lines ?? []).find(item => item.name === (process.env.AW_DEMO_LINE ?? 'Demo Line'))
  if (!line?.id) throw new Error('The isolated mock demo line was not found.')

  const routes = {
    dashboard: '/',
    templates: '/workshop/channel-templates',
    workspace: `/workshop/w/${encodeURIComponent(workspace.id)}`,
    lines: '/dcw',
    'line-detail': `/dcw/${encodeURIComponent(line.id)}`,
  }
  const expected = {
    dashboard: 'Dashboard',
    templates: 'Channel Template Hub',
    workspace: 'Demo Operations',
    lines: 'Demo Line',
    'line-detail': 'Warm-up Profile',
  }

  const ensureVisible = async (scene) => {
    console.log(`Loading ${scene.id} (${scene.route})`)
    await navigate(`${base}${routes[scene.route]}`)
    try {
      await page.waitForFunction((text) => document.body?.innerText?.includes(text), { timeout: 30_000 }, expected[scene.route])
    }
    catch (error) {
      const evidence = await page.evaluate(() => ({ title: document.title, url: location.href, body: document.body?.innerText?.slice(0, 1200) }))
      console.error('Page content did not reach the expected state:', JSON.stringify(evidence))
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 900))
    if (scene.route === 'workspace') {
      await page.evaluate(() => {
        const text = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && el.textContent?.trim() === 'Agent lanes')
        const target = text?.closest('[role="radio"],button,label,[tabindex]') ?? text
        target?.click()
      })
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  for (const scene of voice.scenes) {
    const still = path.join(stills, `${scene.id}.png`)
    if (scene.sourceStill) {
      const source = path.join(stills, scene.sourceStill)
      if (!fs.existsSync(source)) throw new Error(`Missing source screenshot for ${scene.id}: ${source}`)
      if (path.resolve(source) !== path.resolve(still)) fs.copyFileSync(source, still)
      console.log(`Using captured screenshot for ${scene.id}: ${scene.sourceStill}`)
      continue
    }
    await ensureVisible(scene)
    await page.screenshot({ path: still, type: 'png' })

    const targetDuration = (scene.end - scene.start) + voice.transitionSeconds
    const sceneDir = path.join(build, 'frames', scene.id)
    fs.mkdirSync(sceneDir, { recursive: true })
    const stamps = []
    let frameNo = 0

    const animation = (async () => {
      if (scene.route === 'templates') {
        const stopAt = Date.now() + Math.min(2400, targetDuration * 1000 * 0.42)
        while (Date.now() < stopAt) {
          const progress = 1 - ((stopAt - Date.now()) / Math.min(2400, targetDuration * 1000 * 0.42))
          await page.evaluate(p => window.scrollTo({ top: Math.round(170 * p), behavior: 'instant' }), progress)
          await new Promise(resolve => setTimeout(resolve, 40))
        }
      }
      else if (scene.route === 'line-detail') {
        const stopAt = Date.now() + Math.min(1600, targetDuration * 1000 * 0.25)
        while (Date.now() < stopAt) {
          const progress = 1 - ((stopAt - Date.now()) / Math.min(1600, targetDuration * 1000 * 0.25))
          await page.evaluate(p => window.scrollTo({ top: Math.round(100 * p), behavior: 'instant' }), progress)
          await new Promise(resolve => setTimeout(resolve, 45))
        }
      }
    })()
    const until = Date.now() + targetDuration * 1000
    while (Date.now() < until) {
      const tick = Date.now()
      const filename = path.join(sceneDir, `f${String(frameNo++).padStart(5, '0')}.jpg`)
      await page.screenshot({ path: filename, type: 'jpeg', quality: 86 })
      stamps.push({ filename, at: tick / 1000 })
      const rest = 250 - (Date.now() - tick)
      if (rest > 0) await new Promise(resolve => setTimeout(resolve, rest))
    }
    await animation

    if (!stamps.length) throw new Error(`No screen frames were captured for ${scene.id}.`)
    stamps.sort((a, b) => a.at - b.at)
    const firstAt = stamps[0].at
    const lines = []
    for (let i = 0; i < stamps.length; i++) {
      const elapsed = stamps[i].at - firstAt
      const nextElapsed = i + 1 < stamps.length ? stamps[i + 1].at - firstAt : targetDuration
      const duration = Math.max(0.02, Math.min(targetDuration - elapsed, nextElapsed - elapsed))
      lines.push(`file '${stamps[i].filename.replace(/\\/g, '/')}'`)
      lines.push(`duration ${duration.toFixed(4)}`)
    }
    lines.push(`file '${stamps.at(-1).filename.replace(/\\/g, '/')}'`)
    const concatFile = path.join(sceneDir, 'frames.txt')
    fs.writeFileSync(concatFile, lines.join('\n'), 'utf8')
    const output = path.join(build, 'scenes', `${scene.id}.mp4`)
    execFileSync(ffmpeg, [
      '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-vf', `fps=${fps},scale=1600:900,format=yuv420p`, '-t', targetDuration.toFixed(3),
      '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', output,
    ], { stdio: 'inherit' })
    console.log(`Captured ${scene.id}: ${stamps.length} UI frames, ${(targetDuration).toFixed(2)}s`)
  }

  fs.copyFileSync(path.join(stills, '01-workspace.png'), path.join(project, 'poster.png'))
  fs.writeFileSync(path.join(build, 'capture-routes.json'), JSON.stringify({ workspace: workspace.id, line: line.id, routes }, null, 2), 'utf8')
}
finally {
  await browser.close()
  fs.rmSync(path.join(build, 'browser-profile'), { recursive: true, force: true })
}
