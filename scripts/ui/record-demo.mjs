/**
 * AgentWorkShop 实机演示录屏工具 v4.1 —— 英文界面 + Edge 神经语音 + 章节化合成。
 *
 * 产出:docs/site/public/demo/agentworkshop-demo.mp4(1600×900@30,含配音)
 *      docs/site/public/demo/poster.jpg
 *
 * 架构:录制期间 Node 零 Runtime.evaluate(场景脚本整体下推页面内单函数自跑,
 * Node 只负责 screencast 启停、定长 sleep 与孪生鼠标运镜)。场景级重试:
 * 帧不足(渲染进程被重页面拖挂等)自动 reload 后重录一次。
 *
 * 用法:
 *   node scripts/ui/record-demo.mjs tts      # 生成英文配音(edge-tts,增量)
 *   node scripts/ui/record-demo.mjs record   # 录制 + 配音对齐 + 合成(含 poster)
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const CHROME = process.env.AW_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const OUT_DIR = path.resolve('docs/site/public/demo')
const WORK = path.resolve('.tmp-demo')
const EMAIL = 'admin@awshop.local'
const PASSWORD = 'admin123'
const VOICE = 'en-US-AndrewNeural'
const RATE = '-4%'
const HEAD = 1.6

const sleep = ms => new Promise(r => setTimeout(r, ms))
const sh = cmd => execSync(cmd, { stdio: ['ignore', 'ignore', 'pipe'] })
const probeDur = f => Number(execSync(`ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${f}"`).toString().trim())

// ════ 解说词与场景规划(单一事实源) ═════════════════════════════════════════
const PLAN = [
  {
    id: 'title', chapter: null, url: 'card',
    clips: [
      { cap: 'AgentWorkShop', sub: 'INDUSTRIAL AGENT RUNTIME · RECORDED LIVE', say: 'Agent Work Shop — an industrial agent runtime, recorded live. Real protocols, real control — nothing in this demo is scripted.' },
    ],
  },
  {
    id: 'platform', chapter: '01|THE CONTROL ROOM', url: '/',
    clips: [
      { cap: 'The control room', sub: 'Every line, control node and sample in one view — live', say: 'The control room. Every production line, control node, and sample in one view — live.' },
      { cap: '14 engines · 4 entry points', sub: 'WebSocket · MCP · A2A · REST', say: 'Fourteen agent engines behind one contract, and four entry points: WebSocket, M C P, A to A, and REST.' },
    ],
  },
  {
    id: 'telemetry', chapter: '02|LIVE TELEMETRY', url: '/daq',
    clips: [
      { cap: 'DAQ console — live telemetry', sub: '2,000+ channels across six field protocols', say: 'The data acquisition console. Over two thousand live channels across six field protocols: Modbus T C P and R T U, O P C U A, M Q T T, H T T P, and serial.' },
      { cap: 'driver → queue → storage → WebSocket', sub: 'Every node keeps its own cadence', say: 'Samples flow from driver, through the queue, into time-series storage, then fan out over WebSockets. Every node keeps its own cadence.' },
    ],
  },
  {
    id: 'control', chapter: '03|GOVERNED CONTROL', url: '/dcw/ln-bcc8ea44',
    clips: [
      { cap: 'Writing to a real PLC', sub: 'Recipe interlock → safety limits → field', say: 'Now writing to a real PLC. Every setpoint passes the recipe interlock and the safety limits before anything reaches the field.' },
      { cap: 'SET 150 °C → Modbus → read-back', sub: 'Watch the write land, then read the register straight back', say: 'Watch the write land: the platform drives the Modbus holding registers, then reads the value straight back from the device.' },
      { cap: 'Read-back agrees — audit signed', sub: 'Who · when · why — every entry signed', say: 'One hundred and fifty degrees, confirmed by read-back, with a signed entry in the audit trail: who, when, and why.' },
    ],
  },
  {
    id: 'plugins', chapter: '04|PROTOCOLS ARE PLUGINS', url: '/plugins',
    clips: [
      { cap: 'Protocols are plugins', sub: 'ctx.daq.registerDriver · ctx.dcw.registerWriteDriver', say: 'Protocols are plugins. A driver registered through the SDK appears in the interface with its own configuration form — zero front-end changes.' },
      { cap: 'serial-bridge — direct RS-232/485', sub: 'Modbus RTU + ASCII line, probe API included', say: 'The built-in serial bridge opens a real COM port and probes it. If nothing answers, it says so — honestly.' },
    ],
  },
  {
    id: 'agents', chapter: '05|AGENT TEAMS', url: 'workshop',
    clips: [
      { cap: 'The melt-optimization crew', sub: 'A lead agent · trend analyst · setpoint writer', say: 'This is the agent workshop, and this crew owns melt temperature optimization: a lead agent, a trend analyst, and a setpoint writer, supervised over A to A.' },
      { cap: 'Dispatch a goal', sub: 'Lead decomposes → workers execute with tools', say: 'Dispatch a goal. The lead decomposes it, workers stream progress as they execute with tools, and every message lands on the audit trail.' },
      { cap: 'Execution, live', sub: '7-state task machine · artifacts · real-time events', say: 'Task state, artifacts, and messages update in real time. The same seven-state machine backs every engine — from the scripted mock to a real L L M.' },
    ],
  },
  {
    id: 'loop', chapter: '06|THE CLOSED LOOP', url: 'pvnode',
    clips: [
      { cap: 'The closed loop', sub: 'Analyze → propose → approve → write → verify', say: 'The closed loop, end to end. Analyze the trend, propose a setpoint, take the human approval, write to the PLC, and verify — the process value follows.' },
      { cap: 'PV tracks the setpoint', sub: 'SET and ACT — one calibration, both directions', say: 'The process value tracks the setpoint through the real control chain. The same calibration reads back what was written: S E T and A C T, side by side.' },
    ],
  },
  {
    id: 'twin', chapter: '07|THE DIGITAL TWIN', url: '/town',
    clips: [
      { cap: 'The digital twin', sub: 'Live tags · device health · alarms — one event bus', say: 'And everything streams into a three-D digital twin. Live tags, device health, and alarms — all rendered from the same event bus.' },
      { cap: '2,000+ channels · one scene', sub: 'Nothing mocked', say: 'Two thousand channels, one scene — nothing mocked.' },
    ],
  },
  {
    id: 'outro', chapter: null, url: '/',
    clips: [
      { cap: 'AgentWorkShop v0.7.41', sub: 'Open source · PolyForm NC · github.com/kingdol666/AgentWorkShop', say: 'Agent Work Shop, version zero point seven forty one. Open source under PolyForm N C. Find it on Git Hub — king dol sixty six, slash, Agent Work Shop.' },
    ],
  },
]

// ════ 阶段 1:TTS(edge-tts 神经语音,增量) ═════════════════════════════════
async function ttsPhase() {
  const narrDir = path.join(WORK, 'narr')
  fs.mkdirSync(narrDir, { recursive: true })
  for (const scene of PLAN) {
    for (let k = 0; k < scene.clips.length; k++) {
      const id = `${scene.id}_${k}`
      const mp3 = path.join(narrDir, `${id}.mp3`)
      const wav = path.join(narrDir, `${id}.wav`)
      if (fs.existsSync(wav)) continue
      const text = scene.clips[k].say.replace(/"/g, '\\"')
      sh(`edge-tts --voice ${VOICE} --rate=${RATE} --text "${text}" --write-media "${mp3}"`)
      sh(`ffmpeg -y -v error -i "${mp3}" -af "loudnorm=I=-16:TP=-1.5" -ar 44100 -ac 2 "${wav}"`)
      console.log(`  tts ${id}`)
    }
  }
  const durations = {}
  for (const scene of PLAN) {
    for (let k = 0; k < scene.clips.length; k++) {
      durations[`${scene.id}_${k}`] = probeDur(path.join(narrDir, `${scene.id}_${k}.wav`))
    }
  }
  fs.writeFileSync(path.join(narrDir, 'durations.json'), JSON.stringify(durations, null, 2))
  console.log('✅ TTS 完成:', JSON.stringify(durations))
}

// ════ 页面内叠加层(序列化注入) ══════════════════════════════════════════════
const OVERLAY_FN = () => {
  if (window.__demoInstalled) {
    window.__demoRebuild()
    return
  }
  window.__demoInstalled = true
  const css = document.createElement('style')
  css.textContent = `
    #aw-demo-cap { position: fixed; left: 50%; bottom: 42px; transform: translateX(-50%);
      max-width: 82vw; z-index: 2147483000; pointer-events: none; text-align: center;
      background: rgba(7,11,19,.84); border: 1px solid rgba(65,200,244,.35);
      border-radius: 12px; padding: 14px 26px;
      font: 600 21px/1.45 'Segoe UI', system-ui, sans-serif; color: #eaf6ff;
      box-shadow: 0 8px 32px rgba(0,0,0,.45); backdrop-filter: blur(6px);
      transition: opacity .45s ease; opacity: 0; }
    #aw-demo-cap .sub { display: block; margin-top: 4px; font: 400 15px/1.4 'Segoe UI', system-ui, sans-serif;
      color: #7dd8c8; letter-spacing: .4px; }
    #aw-demo-cap .tag { position: absolute; top: -11px; left: 18px; background: #35e0a0; color: #06251a;
      font: 700 11px/1 'Segoe UI', sans-serif; letter-spacing: 1.5px; padding: 4px 9px; border-radius: 6px; }
    #aw-demo-veil { position: fixed; inset: 0; background: #000; z-index: 2147483001;
      pointer-events: none; opacity: 0; transition: opacity .4s ease; }
    #aw-demo-card { position: fixed; inset: 0; background: #05080f; z-index: 2147482999;
      display: none; align-items: center; justify-content: center; flex-direction: column; gap: 14px; }
    #aw-demo-card .no { font: 700 15px/1 'Segoe UI', sans-serif; letter-spacing: 4px; color: #35e0a0; }
    #aw-demo-card .tt { font: 600 54px/1.2 Georgia, 'Times New Roman', serif; color: #eaf2ff; }
    #aw-demo-card .rule { width: 120px; height: 2px; background: #2c4568; animation: awpulse 1.4s ease-in-out infinite; }
    @keyframes awpulse { 0%, 100% { width: 120px; opacity: .55 } 50% { width: 168px; opacity: 1 } }
    #aw-demo-steps { position: fixed; left: 50%; top: 34px; transform: translateX(-50%);
      display: none; gap: 10px; z-index: 2147483000; pointer-events: none; }
    #aw-demo-steps span { font: 600 13px/1 'Segoe UI', sans-serif; letter-spacing: 1px;
      padding: 8px 14px; border-radius: 8px; color: #8fa0b5;
      background: rgba(7,11,19,.8); border: 1px solid rgba(45,69,104,.6); transition: all .3s ease; }
    #aw-demo-steps span.on { color: #06251a; background: #35e0a0; border-color: #35e0a0; }
    #aw-demo-beat { position: fixed; width: 2px; height: 2px; bottom: 0; left: 0;
      opacity: 0; animation: awbeat .5s steps(1) infinite; }
    @keyframes awbeat { 0% { opacity: 0 } 50% { opacity: .02 } 100% { opacity: 0 } }
  `
  document.head.append(css)
  for (const id of ['aw-demo-cap', 'aw-demo-veil', 'aw-demo-card', 'aw-demo-steps', 'aw-demo-beat']) {
    const el = document.createElement('div')
    el.id = id
    document.body.append(el)
  }
  window.__demoRebuild = () => {
    for (const id of ['aw-demo-cap', 'aw-demo-veil', 'aw-demo-card', 'aw-demo-steps', 'aw-demo-beat']) {
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
    await new Promise(r => setTimeout(r, 430))
  }
  window.__demoCard = (no) => {
    window.__demoRebuild()
    const c = document.getElementById('aw-demo-card')
    if (!no) {
      c.style.display = 'none'
      return
    }
    const [noTxt, ...rest] = String(no).split('|')
    c.innerHTML = `<span class="no">${noTxt}</span><span class="tt">${rest.join('|')}</span><span class="rule"></span>`
    c.style.display = 'flex'
  }
  window.__demoSteps = (names, active) => {
    window.__demoRebuild()
    const s = document.getElementById('aw-demo-steps')
    if (!names) {
      s.style.display = 'none'
      return
    }
    s.style.display = 'flex'
    s.innerHTML = names.map((n, i) => `<span class="${i <= active ? 'on' : ''}">${n}</span>`).join('')
  }
  window.__demoScroll = async (toY, ms = 1000) => {
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

/**
 * 场景运行器(页面内自跑;录制期间 Node 零 evaluate)。返回实际耗时(秒)。
 */
const SCENE_RUNNER = async ({ clips, chapter, isTitle, actions, durs }) => {
  const t0 = Date.now()
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const cap = (m, s2) => window.__demoCap(m, s2)
  const qa = sel => [...document.querySelectorAll(sel)]
  const setVal = (inp, v) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(inp, v)
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.dispatchEvent(new Event('change', { bubbles: true }))
  }
  await window.__demoVeil(false)
  if (chapter) {
    window.__demoCard(chapter)
    await sleep(1700)
    window.__demoCard(null)
    await sleep(350)
  }
  if (isTitle) {
    window.__demoCard('★|AgentWorkShop')
  }
  for (let k = 0; k < clips.length; k++) {
    cap(clips[k].cap, clips[k].sub)
    const act = actions[k]
    if (act === 'scrollcard') {
      await window.__demoScroll(document.body.scrollHeight, 1400)
      await sleep(800)
    }
    if (act === 'scroll430') {
      await window.__demoScroll(430, 1100)
      await sleep(900)
    }
    if (act === 'scroll320') {
      await window.__demoScroll(320, 1200)
      await sleep(1100)
    }
    if (act === 'pause3400') await sleep(3400)
    if (act === 'write150') {
      const inp = qa('input[type=number]').find(i => /^\d+~\d+$/.test((i.placeholder || '').replace(/\s/g, '')))
      if (inp) {
        inp.closest('tr, [class*="row"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        await sleep(700)
        setVal(inp, '150')
        await sleep(250)
        qa('button').find(b => b.textContent.trim() === '下发' || b.textContent.trim() === 'Dispatch')?.click()
      }
      await sleep(5200)
      qa('button').find(b => ['读取', 'Read'].includes(b.textContent.trim()))?.click()
      await sleep(3200)
    }
    if (act === 'history') {
      await window.__demoScroll(document.body.scrollHeight, 1400)
      await sleep(1500)
    }
    if (act === 'probe') {
      const form = document.querySelector('.aw-serial-form')
      if (form) {
        const inputs = [...form.querySelectorAll('input')]
        const nums = inputs.filter(i => i.type === 'number')
        setVal(inputs[0], 'COM1')
        if (nums[0]) setVal(nums[0], '9600')
        if (nums[1]) setVal(nums[1], '1')
        if (nums[2]) setVal(nums[2], '40001')
      }
      await sleep(400)
      qa('.aw-serial-btn').find(b => (b.textContent || '').includes('测试连接') || (b.textContent || '').toLowerCase().includes('test'))?.click()
      await sleep(4200)
    }
    if (act === 'sendtask') {
      const any = qa('textarea')[0]
      if (any) {
        const st = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        st.call(any, 'Demo run: optimize the melt temperature setpoint')
        any.dispatchEvent(new Event('input', { bubbles: true }))
        any.focus()
      }
      await sleep(700)
      qa('button').find(b => /发送|Send/.test(b.title ?? ''))?.click()
      await sleep(8500)
    }
    if (act === 'stages') {
      const names = ['ANALYZE', 'PROPOSE', 'APPROVE', 'WRITE', 'VERIFY']
      window.__demoSteps(names, -1)
      for (let i = 0; i < names.length; i++) {
        window.__demoSteps(names, i)
        await sleep(1550)
      }
      await sleep(400)
      window.__demoSteps(null)
    }
    await sleep(Math.max(1200, ((durs[k] ?? 6) + 0.7) * 1000))
  }
  cap(null)
  await window.__demoVeil(true)
  await sleep(700)
  return (Date.now() - t0) / 1000
}

// ════ 阶段 2:录制(场景级重试) ══════════════════════════════════════════════
async function recordPhase() {
  const narrDir = path.join(WORK, 'narr')
  const durations = JSON.parse(fs.readFileSync(path.join(narrDir, 'durations.json'), 'utf8'))
  fs.rmSync(path.join(WORK, 'frames'), { recursive: true, force: true })
  fs.mkdirSync(path.join(WORK, 'frames'), { recursive: true })
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1620,960', '--use-gl=angle'],
    protocolTimeout: 600000,
  })
  const page = await browser.newPage()
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('aw.locale', 'en')
    }
    catch { /* about:blank */ }
  })
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(1500)
  const token = await page.evaluate(async ({ email, password }) => {
    const res = await fetch('/api/users/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const body = await res.json()
    if (body?.code !== 0) return null
    document.cookie = `token=${body.data.token}; path=/; max-age=86400`
    return body.data.token
  }, { email: EMAIL, password: PASSWORD })
  if (!token) throw new Error('登录失败')

  const sceneFiles = []
  for (const scene of PLAN) {
    let recorded = null
    for (let attempt = 0; attempt < 2 && !recorded; attempt++) {
      const durs = scene.clips.map((_, k) => durations[`${scene.id}_${k}`] ?? 6)
      const narrTotal = durs.reduce((a, b) => a + b, 0) + 0.7 * scene.clips.length
      console.log(`● 场景 ${scene.id}${attempt ? '(重试)' : ''}(解说 ${narrTotal.toFixed(1)}s)`)

      let navTo = scene.url.startsWith('/') ? BASE + scene.url : null
      if (scene.url === 'workshop') {
        const wsId = await page.evaluate(async (t) => {
          const r = await fetch('/api/workshop/workspaces', { headers: { authorization: `Bearer ${t}` } }).then(x => x.json())
          return r?.data?.[0]?.id ?? null
        }, token)
        navTo = wsId ? `${BASE}/workshop/w/${wsId}` : `${BASE}/workshop`
      }
      if (scene.url === 'pvnode') {
        const nid = await page.evaluate(async (t) => {
          const r = await fetch('/api/workshop/daq', { headers: { authorization: `Bearer ${t}` } }).then(x => x.json())
          const nodes = r.data?.nodes ?? []
          return (nodes.find(n => n.name.includes('Temp PV')) ?? nodes[0])?.id ?? null
        }, token)
        navTo = nid ? `${BASE}/daq/${nid}` : `${BASE}/daq`
      }
      if (scene.url === 'card') {
        await page.goto('about:blank').catch(() => {})
      }
      else {
        await page.goto(navTo, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
      }
      await sleep(800)
      await page.evaluate(OVERLAY_FN)
      await sleep(2200)

      const actions = {
        telemetry: { 1: 'scroll430' },
        control: { 1: 'write150', 2: 'history' },
        plugins: { 1: 'probe' },
        agents: { 1: 'sendtask' },
        loop: { 1: 'stages' },
        twin: { 0: 'pause3400' },
      }
      const payload = {
        clips: scene.clips.map(c => ({ cap: c.cap, sub: c.sub })),
        chapter: scene.chapter,
        isTitle: scene.id === 'title',
        actions: actions[scene.id] ?? {},
        durs,
      }
      const attemptSuffix = attempt ? `-r${attempt}` : ''
      const sceneDir = path.join(WORK, 'frames', `${scene.id}${attemptSuffix}`)
      fs.mkdirSync(sceneDir, { recursive: true })
      let frameNo = 0
      let pending = 0
      const stamps = []
      const client = await page.createCDPSession()
      client.on('Page.screencastFrame', async (ev) => {
        const at = ev.metadata.timestamp ?? Date.now() / 1000
        if (pending < 24) {
          pending++
          const f = path.join(sceneDir, `f${String(frameNo++).padStart(5, '0')}.jpg`)
          stamps.push({ file: f, at })
          fs.promises.writeFile(f, Buffer.from(ev.data, 'base64')).catch(() => {}).finally(() => pending--)
        }
        await client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {})
      })

      // 场景脚本下推(不等待;录制期间零 evaluate)。超时/异常 → 由 attempt 重试兜底。
      const runnerPromise = page.evaluate(SCENE_RUNNER, payload).catch(err => console.warn('  runner:', String(err).slice(0, 70)))
      await sleep(600)
      await client.send('Page.startScreencast', { format: 'jpeg', quality: 74, maxWidth: 1600, maxHeight: 900, everyNthFrame: 3 })

      if (scene.id === 'twin') {
        await sleep(4200)
        const orbit = async (dx, steps = 24) => {
          const box = await page.evaluate(() => {
            const c = document.querySelector('canvas')
            const r = c?.getBoundingClientRect()
            return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
          })
          if (!box) return
          await page.mouse.move(box.x, box.y)
          await page.mouse.down()
          for (let i = 0; i < steps; i++) {
            const k = (i + 1) / steps
            const e = 1 - (1 - k) ** 2
            await page.mouse.move(box.x + dx * e, box.y + Math.sin(k * Math.PI) * 30)
            await sleep(46)
          }
          await page.mouse.up()
        }
        await orbit(300)
        await sleep(600)
        await orbit(-240)
        await sleep(500)
      }

      await runnerPromise.catch(() => {})
      await sleep(600)
      await client.send('Page.stopScreencast').catch(() => {})
      await sleep(300)
      console.log(`  帧 ${stamps.length}`)

      if (stamps.length >= 8) {
        const lines = []
        for (let i = 0; i < stamps.length; i++) {
          const next = stamps[i + 1]?.at
          const d = next ? Math.max(0.02, Math.min(3, next - stamps[i].at)) : 0.12
          lines.push(`file '${stamps[i].file.replace(/\\/g, '/')}'`)
          lines.push(`duration ${d.toFixed(3)}`)
        }
        lines.push(`file '${stamps[stamps.length - 1].file.replace(/\\/g, '/')}'`)
        const durFile = path.join(sceneDir, 'durations.txt')
        fs.writeFileSync(durFile, lines.join('\n'))
        const out = path.join(WORK, 'frames', `${scene.id}${attemptSuffix}.mp4`)
        execSync(`ffmpeg -y -v error -f concat -safe 0 -i "${durFile}" -vf "fps=30,format=yuv420p" -c:v libx264 -preset medium -crf 24 "${out}"`)
        recorded = { id: scene.id, video: out }
      }
      else {
        console.warn(`  ⚠ ${scene.id} 帧不足(attempt=${attempt})`)
        // 渲染器可能被拖挂:整页 reload 复位后再试
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
        await sleep(2500)
      }
      await client.detach().catch(() => {})
    }
    if (recorded) sceneFiles.push(recorded)
    else console.warn(`  ✖ ${scene.id} 两次尝试均失败,跳过该场景`)
  }

  // ── 配音对齐 + 混流(clip 边缘 afade)+ 拼接 + 封面 ──
  console.log('● 配音对齐与混流 …')
  const finalOut = path.join(OUT_DIR, 'agentworkshop-demo.mp4')
  const parts = []
  for (const scene of PLAN) {
    const sf = sceneFiles.find(x => x.id === scene.id)
    if (!sf) continue
    const vdur = probeDur(sf.video)
    const inputs = []
    const filters = []
    const mixIns = []
    let t = HEAD
    scene.clips.forEach((c, k) => {
      const d = durations[`${scene.id}_${k}`] ?? 0
      const narr = path.join(narrDir, `${scene.id}_${k}.wav`)
      if (fs.existsSync(narr)) {
        inputs.push('-i', narr)
        const ms = Math.round(t * 1000)
        filters.push(`[${k}:a]adelay=${ms}|${ms},afade=t=in:d=0.025,afade=t=out:st=${Math.max(0, d - 0.06).toFixed(3)}:d=0.06[a${k}]`)
        mixIns.push(`[a${k}]`)
      }
      t += d + 0.7
    })
    const sceneWav = path.join(WORK, 'frames', `${scene.id}.wav`)
    if (mixIns.length) {
      execSync(`ffmpeg -y -v error ${inputs.join(' ')} -filter_complex "${filters.join(';')};${mixIns.join('')}amix=inputs=${mixIns.length}:normalize=0,apad=whole_dur=${vdur.toFixed(3)}[out]" -map "[out]" -ar 44100 -ac 2 "${sceneWav}"`)
    }
    else {
      execSync(`ffmpeg -y -v error -f lavfi -i anullsrc=r=44100:cl=stereo -t ${vdur.toFixed(3)} "${sceneWav}"`)
    }
    const av = path.join(WORK, 'frames', `${scene.id}.av.mp4`)
    execSync(`ffmpeg -y -v error -i "${sf.video}" -i "${sceneWav}" -c:v copy -c:a aac -b:a 160k -shortest "${av}"`)
    parts.push(av)
  }
  const listFile = path.join(WORK, 'frames', 'concat.txt')
  fs.writeFileSync(listFile, parts.map(p2 => `file '${p2.replace(/\\/g, '/')}'`).join('\n'))
  execSync(`ffmpeg -y -v error -f concat -safe 0 -i "${listFile}" -c copy -movflags +faststart "${finalOut}"`)
  const dur = probeDur(finalOut)
  const size = fs.statSync(finalOut).size
  console.log(`✅ 完成:${finalOut.replace(process.cwd(), '.')}(${(size / 1e6).toFixed(1)} MB,${dur.toFixed(1)}s)`)

  const posterAt = Math.min(dur - 2, dur * 0.86)
  execSync(`ffmpeg -y -v error -ss ${posterAt.toFixed(1)} -i "${finalOut}" -frames:v 1 -q:v 3 "${path.join(OUT_DIR, 'poster.jpg')}"`)
  await browser.close()
}

// ════ 入口 ══════════════════════════════════════════════════════════════════
const phase = process.argv[2] ?? 'record'
fs.mkdirSync(OUT_DIR, { recursive: true })
if (phase === 'tts') {
  await ttsPhase()
}
else if (phase === 'record') {
  await recordPhase()
}
else {
  console.error('用法: node scripts/ui/record-demo.mjs [tts|record]')
  process.exit(1)
}
