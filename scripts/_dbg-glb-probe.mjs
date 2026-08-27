/** 一次性:逐 GLB 加载探错(浏览器内 GLTFLoader + HTTP 状态) */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 3000))

const out = await page.evaluate(async () => {
  // three 经 vite dev 服务有 hash 化入口,改从页面内已加载的模块拿:直接用相对裸路径 import('three')(vite dev 会解析)
  let loaderMod = null
  try { loaderMod = await import('/_nuxt/assets/../../node_modules/.vite/deps/three.js') } catch {}
  if (!loaderMod?.GLTFLoader) {
    try { loaderMod = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js') } catch {}
  }
  if (!loaderMod?.GLTFLoader) {
    // 兜底:裸说明符(vite index.html 上下文通常可解析裸导入)
    try { loaderMod = await import('three/examples/jsm/loaders/GLTFLoader.js') } catch (e) { return { error: 'loader import fail: ' + String(e).slice(0, 150) } }
  }
  if (!loaderMod.GLTFLoader) return { error: 'gltfloader import fail: ' + JSON.stringify(loaderMod).slice(0, 200) }
  const loader = new loaderMod.GLTFLoader()
  const files = ['agv', 'caster', 'device-robot-arm', 'device-scanner', 'extruder', 'mdo', 'power-cabinet', 'pump', 'tdo', 'thickness-scanner', 'winder', 'device-console']
  const res = []
  for (const f of files) {
    const url = `/assets/game/devices/${f}.glb`
    const http = await fetch(url).then(r => `${r.status} ${r.headers.get('content-type')}`).catch(e => `fetch-err ${e.message}`)
    const load = await new Promise((resolve) => {
      loader.load(url, g => resolve(`ok meshes=${g.scene.children.length}`), undefined, e => resolve(`load-err ${String(e).slice(0, 120)}`))
    })
    res.push(`${f}: http[${http}] load[${load}]`)
  }
  return { res }
})
console.log(JSON.stringify(out, null, 1))
await browser.close()
