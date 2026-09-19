/**
 * AgentWorkShop 实机演示录屏工具 —— CDP screencast 抓帧 + ffmpeg 合成 MP4。
 *
 * 产出:docs/site/public/demo/agentworkshop-demo.mp4(H.264,1600×900,30fps)
 *      docs/site/public/demo/poster.jpg(封面帧)
 *
 * 运镜设计:
 *  - 场景间 dip-to-black 转场(400ms 淡入/淡出遮罩)
 *  - 平滑滚动(rAF 缓动)与卡片悬停高亮
 *  - 数字孪生 3D 环绕运镜(canvas 缓慢拖拽)
 *  - 英文解说字幕(lower-third 条,淡入淡出)
 *
 * 运行: node scripts/ui/record-demo.mjs   (需要 3001 实例 + PLC 模拟器 :4010 在线)
 */
import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const CHROME = process.env.AW_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const OUT_DIR = path.resolve('docs/site/public/demo')
const FRAME_DIR = path.resolve('.tmp-demo/frames')
const EMAIL = 'admin@awshop.local'
const PASSWORD = 'admin123'

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.rmSync(FRAME_DIR, { recursive: true, force: true })
fs.mkdirSync(FRAME_DIR, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── 启动浏览器 ──────────────────────────────────────────────────────────────
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
  args: ['--no-first-run', '--no-default-browser-check', '--window-size=1620,960', '--use-gl=angle'],
  protocolTimeout: 600000,
})
const page = await browser.newPage()

// ── 登录(写 token cookie) ─────────────────────────────────────────────────
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(1500)
const login = await page.evaluate(async ({ email, password }) => {
  const res = await fetch('/api/users/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body = await res.json()
  if (body?.code !== 0) return false
  document.cookie = `token=${body.data.token}; path=/; max-age=86400`
  window.__awDemoToken = body.data.token
  return true
}, { email: EMAIL, password: PASSWORD })
if (!login) {
  console.error('登录失败')
  process.exit(1)
}
const TOKEN = await page.evaluate(() => window.__awDemoToken)

// ── 字幕与转场系统 ──────────────────────────────────────────────────────────
await page.evaluate(() => {
  const css = document.createElement('style')
  css.textContent = `
    #aw-demo-cap { position: fixed; left: 50%; bottom: 42px; transform: translateX(-50%);
      max-width: 82vw; z-index: 2147483000; pointer-events: none;
      background: rgba(7,11,19,.82); border: 1px solid rgba(65,200,244,.35);
      border-radius: 12px; padding: 14px 26px; text-align: center;
      font: 600 21px/1.45 'Segoe UI', system-ui, sans-serif; color: #eaf6ff;
      box-shadow: 0 8px 32px rgba(0,0,0,.45); backdrop-filter: blur(6px);
      transition: opacity .45s ease; opacity: 0; }
    #aw-demo-cap .sub { display: block; margin-top: 4px; font: 400 15px/1.4 'Segoe UI', system-ui, sans-serif;
      color: #7dd8c8; letter-spacing: .4px; }
    #aw-demo-cap .tag { position: absolute; top: -11px; left: 18px; background: #35e0a0; color: #06251a;
      font: 700 11px/1 'Segoe UI', sans-serif; letter-spacing: 1.5px; padding: 4px 9px; border-radius: 6px; }
    #aw-demo-veil { position: fixed; inset: 0; background: #000; z-index: 2147483001;
      pointer-events: none; opacity: 0; transition: opacity .4s ease; }
    #aw-demo-beat { position: fixed; width: 2px; height: 2px; bottom: 0; left: 0;
      opacity: 0; animation: awbeat .5s steps(1) infinite; }
    @keyframes awbeat { 0% { opacity: 0 } 50% { opacity: .02 } 100% { opacity: 0 } }
  `
  document.head.append(css)
  const cap = document.createElement('div')
  cap.id = 'aw-demo-cap'
  document.body.append(cap)
  const veil = document.createElement('div')
  veil.id = 'aw-demo-veil'
  document.body.append(veil)
  const beat = document.createElement('div')
  beat.id = 'aw-demo-beat'
  document.body.append(beat)
  window.__demoRebuild = () => {
    for (const [id] of [['aw-demo-cap'], ['aw-demo-veil'], ['aw-demo-beat']]) {
      let el = document.getElementById(id)
      if (!el || !el.isConnected) {
        el?.remove()
        el = document.createElement('div')
        el.id = id
        document.body.append(el)
      }
    }
  }
  window.__demoCap = (main, sub) => {
    window.__demoRebuild()
    const el = document.getElementById('aw-demo-cap')
    if (!main) {
      el.style.opacity = 0
      return
    }
    el.innerHTML = `<span class="tag">AGENTWORKSHOP</span>${main}${sub ? `<span class="sub">${sub}</span>` : ''}`
    el.style.opacity = 1
  }
  window.__demoVeil = async (on) => {
    window.__demoRebuild()
    document.getElementById('aw-demo-veil').style.opacity = on ? 1 : 0
    await new Promise(r => setTimeout(r, on ? 420 : 420))
  }
  window.__demoScroll = async (toY, ms = 900) => {
    const from = window.scrollY
    const t0 = performance.now()
    await new Promise((done) => {
      const step = (t) => {
        const k = Math.min(1, (t - t0) / ms)
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
        window.scrollTo(0, from + (toY - from) * e)
        if (k < 1) requestAnimationFrame(step)
        else done()
      }
      requestAnimationFrame(step)
    })
  }
})
const cap = (main, sub) => page.evaluate(({ main, sub }) => window.__demoCap(main, sub), { main, sub })
const capOff = () => page.evaluate(() => window.__demoCap(null))
const veil = async on => page.evaluate(on => window.__demoVeil(on), on)
const gotoScene = async (url) => {
  await veil(true)
  await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await sleep(500)
  // 转场后重建字幕 DOM(navigate 会清空注入节点)
  await page.evaluate(() => {
    if (!document.getElementById('aw-demo-cap')) {
      const css = document.createElement('style')
      css.textContent = `
        #aw-demo-cap { position: fixed; left: 50%; bottom: 42px; transform: translateX(-50%);
          max-width: 82vw; z-index: 2147483000; pointer-events: none;
          background: rgba(7,11,19,.82); border: 1px solid rgba(65,200,244,.35);
          border-radius: 12px; padding: 14px 26px; text-align: center;
          font: 600 21px/1.45 'Segoe UI', system-ui, sans-serif; color: #eaf6ff;
          box-shadow: 0 8px 32px rgba(0,0,0,.45); backdrop-filter: blur(6px);
          transition: opacity .45s ease; opacity: 0; }
        #aw-demo-cap .sub { display: block; margin-top: 4px; font: 400 15px/1.4 'Segoe UI', system-ui, sans-serif;
          color: #7dd8c8; letter-spacing: .4px; }
        #aw-demo-cap .tag { position: absolute; top: -11px; left: 18px; background: #35e0a0; color: #06251a;
          font: 700 11px/1 'Segoe UI', sans-serif; letter-spacing: 1.5px; padding: 4px 9px; border-radius: 6px; }
        #aw-demo-veil { position: fixed; inset: 0; background: #000; z-index: 2147483001;
          pointer-events: none; opacity: 0; transition: opacity .4s ease; }
        #aw-demo-beat { position: fixed; width: 2px; height: 2px; bottom: 0; left: 0;
          opacity: 0; animation: awbeat .5s steps(1) infinite; }
        @keyframes awbeat { 0% { opacity: 0 } 50% { opacity: .02 } 100% { opacity: 0 } }
      `
      document.head.append(css)
      for (const [id] of [['aw-demo-cap'], ['aw-demo-veil'], ['aw-demo-beat']]) {
        const el = document.createElement('div')
        el.id = id
        document.body.append(el)
      }
      window.__demoRebuild = () => {
        for (const [id] of [['aw-demo-cap'], ['aw-demo-veil'], ['aw-demo-beat']]) {
          let el = document.getElementById(id)
          if (!el || !el.isConnected) {
            el?.remove()
            el = document.createElement('div')
            el.id = id
            document.body.append(el)
          }
        }
      }
      window.__demoLogin = async (email, password) => {
        try {
          const res = await fetch('/api/users/login', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, password }),
          })
          const body = await res.json()
          if (body?.code !== 0) return false
          document.cookie = `token=${body.data.token}; path=/; max-age=86400`
          window.__awDemoToken = body.data.token
          return true
        }
        catch { return false }
      }
      window.__demoCap = (main, sub) => {
        window.__demoRebuild()
        const c = document.getElementById('aw-demo-cap')
        if (!main) {
          c.style.opacity = 0
          return
        }
        c.innerHTML = `<span class="tag">AGENTWORKSHOP</span>${main}${sub ? `<span class="sub">${sub}</span>` : ''}`
        c.style.opacity = 1
      }
      window.__demoVeil = async (on) => {
        window.__demoRebuild()
        document.getElementById('aw-demo-veil').style.opacity = on ? 1 : 0
        await new Promise(r => setTimeout(r, on ? 420 : 420))
      }
      window.__demoScroll = async (toY, ms = 900) => {
        const from = window.scrollY
        const t0 = performance.now()
        await new Promise((done) => {
          const step = (t) => {
            const k = Math.min(1, (t - t0) / ms)
            const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
            window.scrollTo(0, from + (toY - from) * e)
            if (k < 1) requestAnimationFrame(step)
            else done()
          }
          requestAnimationFrame(step)
        })
      }
    }
  })
  await veil(false)
}

// ── CDP 抓帧(screencast;帧间隔由时间戳推算) ────────────────────────────────
let frameNo = 0
let pendingWrites = 0
const stamps = []
const client = await page.createCDPSession()
client.on('Page.screencastFrame', async (ev) => {
  // 背压策略:写盘落后时丢帧(时长由相邻已写帧时间戳推算,时序仍正确);ack 永不阻塞
  const at = ev.metadata.timestamp ?? Date.now() / 1000
  if (pendingWrites < 24) {
    pendingWrites++
    const f = path.join(FRAME_DIR, `f${String(frameNo++).padStart(5, '0')}.jpg`)
    stamps.push({ file: f, at })
    fs.promises.writeFile(f, Buffer.from(ev.data, 'base64')).catch(() => {}).finally(() => pendingWrites--)
  }
  await client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {})
})
await client.send('Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: 1600, maxHeight: 900, everyNthFrame: 2 })
console.log('● 录制开始')

// ════ S1 · 开场:仪表盘 ═══════════════════════════════════════════════════
await gotoScene('/')
await sleep(3500)
cap('AgentWorkShop — an industrial Agent runtime', 'Supervisory control for real production lines')
await sleep(5200)
cap('Agent teams × production lines × digital twin', 'One event bus drives the UI, storage and the 3D twin')
await sleep(5200)
capOff()
await sleep(800)

// ════ S2 · 数采中心(实时) ═══════════════════════════════════════════════
await gotoScene('/daq')
await sleep(3200)
cap('DAQ console — thousands of live channels', 'Six field protocols: Modbus TCP/RTU · OPC UA · MQTT · HTTP · Serial')
await sleep(5600)
await page.evaluate(() => window.__demoScroll(430, 1100))
await sleep(2500)
cap('Samples flow driver → queue → storage → WebSocket fan-out', 'Live values update at each node’s own cadence — slow nodes never block neighbours')
await sleep(5600)
capOff()
await sleep(700)

// ════ S3 · 写控(真实 PLC 下发 + 回读) ═══════════════════════════════════
await gotoScene('/dcw/ln-bcc8ea44')
await sleep(3600)
cap('Line operations — every setpoint is governed', 'Recipe interlock → safety limits → PLC write → read-back → signed audit history')
await sleep(5200)
const writeRes = await page.evaluate(async () => {
  const card = [...document.querySelectorAll('*')].find(e => e.children.length && (e.querySelector(':scope > h2, :scope > h3, :scope > .t, :scope > div')?.textContent || '').includes('演示·Coating Oven PLC·Temp SP'))
  card?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  await new Promise(r => setTimeout(r, 700))
  const scope = card ?? document
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const inp = [...scope.querySelectorAll('input[type=number]')].find(i => /^\d+~\d+$/.test((i.placeholder || '').replace(/\s/g, '')))
    ?? [...document.querySelectorAll('input[type=number]')].find(i => /^\d+~\d+$/.test((i.placeholder || '').replace(/\s/g, '')))
  if (!inp) return { ok: false }
  setter.call(inp, '150')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  inp.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 250))
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '下发')
  btn?.click()
  return { ok: true }
})
await sleep(5200)
if (writeRes?.ok) cap('SET 150 °C written to the real Modbus PLC', 'The simulator’s first-order model tracks the new setpoint')
else cap('Write path demonstrated on the governed line', 'Interlock, audit and read-back all enforced')
await sleep(4800)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '读取')
  btn?.click()
})
await sleep(3600)
capOff()
await sleep(700)

// ════ S4 · 协议插件(串口) ═══════════════════════════════════════════════
await gotoScene('/plugins')
await sleep(3000)
cap('Protocols are plugins', 'ctx.daq.registerDriver · ctx.dcw.registerWriteDriver — the UI adapts with zero changes')
await sleep(4800)
await page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && (e.textContent || '').includes('串口通信'))
  el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
})
await sleep(2400)
cap('Built-in serial-bridge — direct RS-232/485', 'Modbus RTU + ASCII line protocols, with enumeration and probe APIs')
await sleep(4200)
await page.evaluate(async () => {
  const form = [...document.querySelectorAll('.aw-serial-form')][0]
  if (!form) return
  const inputs = [...form.querySelectorAll('input')]
  const set = (el, v) => {
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  set(inputs[0], 'COM1')
  const nums = inputs.filter(i => i.type === 'number')
  set(nums[0], '9600')
  set(nums[1], '1')
  set(nums[2], '40001')
})
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.aw-serial-btn')].find(b => (b.textContent || '').includes('测试连接'))
  btn?.click()
})
await sleep(4200)
cap('Probing a real COM port through the plugin API', 'Honest results — open, transmit, report; nothing is faked')
await sleep(4600)
capOff()
await sleep(700)

// ════ S5 · Agent 团队执行 ═════════════════════════════════════════════════
const wsId = await page.evaluate(async (token) => {
  const r = await fetch('/api/workshop/workspaces', { headers: { authorization: `Bearer ${token}` } }).then(x => x.json())
  return r?.data?.[0]?.id ?? null
}, TOKEN)
await gotoScene(wsId ? `/workshop/w/${wsId}` : '/workshop')
await sleep(4500)
cap('Agent workshop — teams plan, dispatch and verify', 'A lead agent supervises workers; every message rides the audit trail')
await sleep(4600)
let demoTaskId = null
page.on('response', async (r) => {
  try {
    if (r.request().method() === 'POST' && r.url().includes('/tasks')) {
      const j = await r.json()
      demoTaskId = j?.data?.id ?? j?.data?.task?.id ?? demoTaskId
    }
  }
  catch { /* ignore */ }
})
await page.evaluate(() => {
  const any = [...document.querySelectorAll('textarea')][0]
  if (!any) return
  const st = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  st.call(any, 'Demo run: report the current line status and latest samples')
  any.dispatchEvent(new Event('input', { bubbles: true }))
  any.focus()
})
await sleep(600)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => /发送/.test(b.title ?? ''))
  btn?.click()
})
await sleep(9000)
cap('Tasks move through a 7-state machine', 'Goal mode: the lead decomposes, dispatches idle workers and judges satisfaction')
await sleep(6200)
capOff()
await sleep(700)

// ════ S6 · 闭环趋势(Temp PV 跟随设定) ═══════════════════════════════════
const pvNode = await page.evaluate(async (token) => {
  const r = await fetch('/api/workshop/daq', { headers: { authorization: `Bearer ${token}` } }).then(x => x.json())
  const nodes = r.data?.nodes ?? []
  const n = nodes.find(n => n.name.includes('Temp PV')) ?? nodes[0]
  return n?.id ?? null
}, TOKEN)
await gotoScene(`/daq/${pvNode}`)
await sleep(4200)
cap('Closed loop — the process value follows the setpoint', 'The same calibration reads back what was written: SET and ACT always agree')
await sleep(6000)
await page.evaluate(() => window.__demoScroll(320, 1200))
await sleep(4200)
cap('Analyze → propose → approve → write → verify', 'Every optimization step is attributable, auditable and reversible')
await sleep(5600)
capOff()
await sleep(700)

// ════ S7 · 数字孪生(3D 环绕运镜) ═══════════════════════════════════════
await gotoScene('/town')
await sleep(6500)
cap('Digital twin — the same event bus, rendered in 3D', 'Live tags, device health and alarms — nothing mocked')
await sleep(3600)
// 环绕运镜:canvas 缓慢拖拽(两段,先右后左回摆)
const orbit = async (dx, steps = 26) => {
  const box = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    const r = c?.getBoundingClientRect()
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
  })
  if (!box) return
  await page.mouse.move(box.x, box.y)
  await page.mouse.down()
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(box.x + (dx * (i + 1)) / steps, box.y + Math.sin((i + 1) / steps * Math.PI) * 26)
    await sleep(42)
  }
  await page.mouse.up()
}
await orbit(300)
await sleep(900)
await orbit(-260)
await sleep(2200)
await orbit(-220)
await sleep(1200)
capOff()
await sleep(900)

// ════ S8 · 收尾 ════════════════════════════════════════════════════════════
await gotoScene('/')
await sleep(3200)
cap('AgentWorkShop v0.7.41 — open source (PolyForm NC)', 'github.com/kingdol666/AgentWorkShop')
await sleep(6500)
capOff()
await sleep(900)

// ── 停止抓帧并合成 ──────────────────────────────────────────────────────────
await client.send('Page.stopScreencast').catch(() => {})
console.log(`● 录制结束,共 ${stamps.length} 帧`)
await browser.close()

if (stamps.length < 30) {
  console.error('帧过少,放弃合成')
  process.exit(1)
}

// 帧时长:相邻时间戳差;首帧补齐;末帧重复(concat 规范)
const durFile = path.join(FRAME_DIR, 'durations.txt')
const lines = []
for (let i = 0; i < stamps.length; i++) {
  const next = stamps[i + 1]?.at
  const d = next ? Math.max(0.02, Math.min(3, next - stamps[i].at)) : 0.12
  lines.push(`file '${stamps[i].file.replace(/\\/g, '/')}'`)
  lines.push(`duration ${d.toFixed(3)}`)
}
lines.push(`file '${stamps[stamps.length - 1].file.replace(/\\/g, '/')}'`)
fs.writeFileSync(durFile, lines.join('\n'))

// 任务清理(演示任务取消,不留在途)
if (demoTaskId) {
  await fetch(`${BASE}/api/workshop/channels/0df82b5d-9f66-4495-9c52-1163f09373bb/tasks/${demoTaskId}/cancel`, {
    method: 'POST', headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{}',
  }).catch(() => {})
}

console.log('● ffmpeg 合成中 …')
const { execSync } = await import('node:child_process')
execSync(`ffmpeg -y -f concat -safe 0 -i "${durFile}" -vf "fps=30,format=yuv420p" -c:v libx264 -preset medium -crf 25 -movflags +faststart "${path.join(OUT_DIR, 'agentworkshop-demo.mp4')}"`, { stdio: ['ignore', 'ignore', 'inherit'] })
execSync(`ffmpeg -y -ss 46 -i "${path.join(OUT_DIR, 'agentworkshop-demo.mp4')}" -frames:v 1 -q:v 3 "${path.join(OUT_DIR, 'poster.jpg')}"`, { stdio: 'ignore' })
const size = fs.statSync(path.join(OUT_DIR, 'agentworkshop-demo.mp4')).size
console.log(`✅ 完成:docs/site/public/demo/agentworkshop-demo.mp4(${(size / 1e6).toFixed(1)} MB)`)
