/** CPU 热点剖析:/daq 与 /town 各采 12s CPU profile,输出 self-time Top20。 */
import puppeteer from 'puppeteer-core'
import { writeFileSync } from 'node:fs'

const ROOT = process.argv[2] ?? 'http://127.0.0.1:3001'
const OUT = process.argv[3] ?? '.e2e-shots/cpu-profile.json'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'perf-runner@awshop.io', password: 'Perf@Run2026' }) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: new URL(ROOT).hostname, path: '/' })

const cdp = await page.createCDPSession()
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 500 })

async function profile(path, warmMs, sampleMs) {
  await page.goto(`${ROOT}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(warmMs)
  await cdp.send('Profiler.start')
  await sleep(sampleMs)
  const { profile: prof } = await cdp.send('Profiler.stop')
  // self time 聚合
  const nodesById = new Map(prof.nodes.map(n => [n.id, n]))
  const self = new Map()
  const total = prof.timeDeltas.reduce((a, b) => a + b, 0)
  for (let i = 0; i < prof.samples.length; i++) {
    const id = prof.samples[i]
    const dt = prof.timeDeltas[i] ?? 0
    self.set(id, (self.get(id) ?? 0) + dt)
  }
  const rows = [...self.entries()]
    .map(([id, us]) => {
      const n = nodesById.get(id)
      const cf = n?.callFrame ?? {}
      const url = (cf.url ?? '').replace(/^.*\/(_nuxt|node_modules)\//, '$1/')
      return { fn: `${cf.functionName || '(anon)'} @ ${url}:${(cf.lineNumber ?? 0) + 1}`, selfMs: +(us / 1000).toFixed(1) }
    })
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, 20)
    .filter(r => r.selfMs >= 5)
  return { path, totalMs: +(total / 1000).toFixed(0), top: rows }
}

const daq = await profile('/daq', 12000, 12000)
console.log('==== /daq self-time Top:', JSON.stringify(daq, null, 1))
const town = await profile('/town', 18000, 12000)
console.log('==== /town self-time Top:', JSON.stringify(town, null, 1))
writeFileSync(OUT, JSON.stringify({ daq, town }, null, 2))
await browser.close()
console.log('DONE ->', OUT)
