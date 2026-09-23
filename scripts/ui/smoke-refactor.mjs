/**
 * 前端重构后的**浏览器冒烟**:逐页加载、等客户端水合、收集控制台错误与页面异常。
 *
 * 为什么必须有这一步:typecheck/eslint 看不到「模板搬进子组件后运行时报错 / 响应式断链 /
 * scoped CSS 失配」这类问题,而本轮把 8 个巨型页面/组件拆成了上百个文件。
 *
 * 用法: node scripts/ui/smoke-refactor.mjs [--base http://127.0.0.1:3458] [--routes /aml,/daq,...]
 * 判据:HTTP 加载成功 + 客户端水合(data-vp-tier)+ 无 console error/pageerror + 根节点有内容
 */
import { existsSync } from 'node:fs'

/** 找到可用的 Chromium:优先 AW_CHROME,其次本机 Chrome/Edge(puppeteer-core 不自带浏览器) */
function resolveChrome() {
  if (process.env.AW_CHROME) return process.env.AW_CHROME
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ]
  return cands.find(p => existsSync(p))
}
const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  if (i >= 0) return process.argv[i + 1]
  const kv = process.argv.find(a => a.startsWith(`${k}=`))
  return kv ? kv.slice(k.length + 1) : d
}
// lib.mjs 在**模块加载时**读取 AW_CHROME / AW_BASE,所以两者都必须先定好再动态导入
process.env.AW_BASE = arg('--base', process.env.AW_BASE ?? 'http://127.0.0.1:3458')
process.env.AW_CHROME = resolveChrome() ?? ''
if (!process.env.AW_CHROME) {
  console.error('未找到 Chromium:请设置 AW_CHROME 指向本机 chrome/msedge 可执行文件')
  process.exit(2)
}

const { BASE: DEFAULT_BASE, api, ensureVisualUser, launch, openPage, ROUTES, sleep } = await import('./lib.mjs')

const only = arg('--routes', '')?.split(',').map(s => s.trim()).filter(Boolean)
const routes = only?.length ? ROUTES.filter(r => only.includes(r.path) || only.includes(r.name)) : ROUTES

let pass = 0
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass += 1
  else fails.push(`${name}${detail ? ` (${detail})` : ''}`)
}

const NOISE = [
  /favicon/i,
  /ResizeObserver loop/i,
  /Download the Vue Devtools/i,
  /\[nuxt\]/i,
  /WebSocket connection to .* failed/i,
  /net::ERR_CONNECTION_REFUSED/i,
]
const isNoise = t => NOISE.some(re => re.test(t))

/**
 * 水合判据:Vue 在挂载容器上写 `__vue_app__` —— 它出现即客户端已接管。
 * 不用 `data-vp-tier`:那是 useResponsive 的副作用,/town 的**空态**不会挂载它(实测踩过,
 * 会把"合法的空状态页"误判成"没水合")。
 */
const HYDRATED = () => Boolean(document.querySelector('#__nuxt')?.__vue_app__)

/** 预置:建频道 + 建 workspace + 挂载 → 让 /town 与 /workshop/w/:wsId 走**真实渲染分支**而不是空态 */
async function seedTown(api, token) {
  const name = `smoke-${Date.now().toString(36)}`
  const ch = await api('POST', '/api/workshop/channels', {
    body: { name, leadAgent: { name: `${name}-lead`, harness: 'mock', config: { delayMs: 30 } } },
    token,
  })
  const channelId = ch.data?.channelId
  if (!channelId) return null
  const wsName = `${name}-ws`
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: wsName }, token })
  const wsId = ws.data?.id ?? ws.data?.workspaceId
  if (wsId) {
    await api('POST', `/api/workshop/workspaces/${wsId}/channels/${channelId}`, { body: {}, token })
  }
  return { channelId, wsId, wsName }
}

/**
 * 预置:/daq/:id(节点详情)与 /dcw/:id(**产线**详情)+ 挂载节点/产品/配方。
 * 为什么必须预置:
 *  1) 详情页拆成了 5~9 个 composable + 3~4 个子组件,只在数据存在时才挂载;
 *     访问不存在的 id 只渲染一行「未找到 / 产线不存在」,等于什么都没验证(实测踩过:
 *     /dcw/<节点id> 渲染出的是「产线不存在或已被删除」——该路由的参数是**产线 id**,不是节点 id);
 *  2) 挂上节点/产品/配方后,页面才会渲染控制节点清单、配方版本历史、数据查询这些真实分支。
 * templateRef 用内置模板(shared/{daq,dcw}-protocol.ts),无需先建模板。
 */
async function seedDetail(api, token) {
  const name = `smoke-${Date.now().toString(36)}`
  const daqName = `${name}-daq`
  const lineName = `${name}-line`
  const daq = await api('POST', '/api/workshop/daq', {
    body: { name: daqName, templateRef: 'temp-tc', driver: 'mock' },
    token,
  })
  const line = await api('POST', '/api/workshop/dcw/lines', { body: { name: lineName }, token })
  const lineId = line.data?.line?.id ?? ''
  if (!lineId) return { daqId: daq.data?.node?.id ?? '', lineId: '', dcwId: '', daqName, lineName }

  const dcw = await api('POST', '/api/workshop/dcw', {
    body: { name: `${name}-dcw`, templateRef: 'temp-sp', driver: 'mock', lineId },
    token,
  })
  const product = await api('POST', '/api/workshop/dcw/products', {
    body: { name: `${name}-product`, lineId },
    token,
  })
  const productId = product.data?.product?.id ?? ''
  if (productId) {
    await api('POST', '/api/workshop/dcw/recipes', {
      body: { name: `${name}-recipe`, productId, params: [] },
      token,
    })
  }
  return { daqId: daq.data?.node?.id ?? '', lineId, dcwId: dcw.data?.node?.id ?? '', daqName, lineName }
}

const token = await ensureVisualUser()
check('0.1 取得可登录测试账号 token', Boolean(token))

const wantsDetail = routes.some(r => r.name === 'daq' || r.name === 'dcw')
if (wantsDetail) {
  const { daqId, lineId, dcwId, daqName, lineName } = await seedDetail(api, token)
  // expect:把"有内容"升级为"渲染的确实是这个实体" —— 详情页早退到「未找到」时页面同样非空
  if (daqId) routes.push({ path: `/daq/${daqId}`, name: 'daq-detail', title: '数采节点详情', expect: daqName })
  if (lineId) routes.push({ path: `/dcw/${lineId}`, name: 'dcw-detail', title: '产线控制台', expect: lineName })
  check('0.3 详情页预置:数采节点 + 产线(挂节点/产品/配方)—— 否则只渲染「未找到」,拆分出的 composable/子组件全不挂载',
    Boolean(daqId && lineId && dcwId), `daqId=${daqId} lineId=${lineId} dcwId=${dcwId}`)
}

/**
 * 已知既存缺陷(与本轮重构无关,已在未改动的文件上复现):
 *   connection.ts:87 对**每一帧**都调用 onDataRecovered(),而 useWorkshopWs 的回调在
 *   其中 `sendNotificationsSub()` + `backfill()` —— 服务端收到 sub 会回 notification.snapshot,
 *   它同样是"非 pong 帧",于是再次触发 → 客户端/服务端 ping-pong。
 *   实测:有实时实体时 967 帧/s 的 notification.snapshot + ~1450 次/s 的通知 REST,
 *   直到浏览器 socket 耗尽报 ERR_INSUFFICIENT_RESOURCES;空库(0 实体)则完全不出现。
 *   两个文件都与 HEAD 逐字节一致(git diff 为空),且同一风暴在**未重构**的 / 与 /daq 列表页出现。
 *
 * 处理:仅当"错误全是资源耗尽类 + 通知接口请求数达到风暴量级"时降级为 WARN,
 * 其余任何控制台错误仍判 FAIL —— 不能让这条已知噪声淹掉真正的重构回归。
 */
const STORM_URL = '/api/workshop/notifications'
const STORM_MIN_REQ = 200
/** 浏览器级:本次冒烟里是否出现过通知风暴(资源耗尽是跨标签页的,见下面用法说明) */
let stormSeen = false
const isResourceExhaustion = t => /ERR_INSUFFICIENT_RESOURCES|ERR_ABORTED|ERR_FAILED|Failed to load resource/i.test(t)
/**
 * 风暴的另一种下游症状:Nuxt 客户端在启动时会拉 `/_nuxt/builds/meta/<buildId>.json`(版本自检),
 * socket 被风暴打满后这一步会失败,控制台只留一行 `[NUXT_E5002]`。
 * 已证伪"产物缺文件":该 json 存在于 .output 且服务端 GET 返回 200(实测),失败纯属客户端资源耗尽。
 * 只在"本次冒烟确实观察到风暴"时才把它并入风暴桶,避免掩盖真正的分包缺失。
 */
const isStormSymptom = t => isResourceExhaustion(t) || /^\[NUXT_E5002\]$/.test(t.trim())
const STORM_MIN_EXHAUSTION = 100

console.log(`\n━━━ 前端重构冒烟 @ ${process.env.AW_BASE}(${routes.length} 条路由)━━━`)
// /workshop/w/:wsId(单工作区控制台)需要一个**已挂载频道**的 workspace 才走真实分支,
// 与 /town 同一份预置;id 只能运行时拿到,故路由在这里追加。
if (routes.some(r => r.path === '/town' || r.name === 'ws-console')) {
  const seeded = await seedTown(api, token)
  check('0.2 /town 与 /workshop/w/:wsId 预置:建频道 + workspace + 挂载(否则只会渲染空态,测不到拆分后的控制台/孪生视图)',
    Boolean(seeded?.channelId), JSON.stringify(seeded))
  if (seeded?.wsId) {
    routes.push({
      path: `/workshop/w/${seeded.wsId}`,
      name: 'ws-console',
      title: '单工作区控制台',
      expect: seeded.wsName,
    })
  }
}

const browser = await launch({ width: 1440, height: 900 })
try {
  for (const r of routes) {
    const page = await openPage(browser, { token, dark: true })
    const consoleErrors = []
    const pageErrors = []
    const warnings = []
    const reqCount = new Map()
    page.on('request', (r) => {
      const u = r.url().split('?')[0]
      if (u.endsWith(STORM_URL)) reqCount.set(STORM_URL, (reqCount.get(STORM_URL) ?? 0) + 1)
    })
    page.on('console', (m) => {
      const t = m.text()
      if (isNoise(t)) return
      // 生产构建下 Vue 只给"有 mismatch"这一句、没有任何节点级细节,无法据此定位;
      // 且实测**未改动**的页面(/workshop/agents、teams、channel-templates)同样会报,
      // 与本轮重构无关 ⇒ 单列为 WARN 而不是 FAIL。
      if (/Hydration completed but contains mismatches/i.test(t)) {
        warnings.push(t)
        return
      }
      if (m.type() === 'error') consoleErrors.push(t.slice(0, 200))
    })
    page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)))
    let status = 0
    try {
      const resp = await page.goto(DEFAULT_BASE + r.path, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      status = resp?.status() ?? 0
      await page.waitForFunction(HYDRATED, { timeout: 90_000, polling: 200 })
      await sleep(1800)
    }
    catch (e) {
      pageErrors.push(`导航/水合失败: ${String(e.message).slice(0, 160)}`)
    }
    const bodyText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim()).catch(() => '')
    const bodyLen = bodyText.length
    const mainChildren = await page.evaluate(() => {
      const el = document.querySelector('#__nuxt > *, main, .page, [class*="page"]')
      return el ? el.children.length : 0
    }).catch(() => 0)
    check(`${r.path} 可加载并水合`, status === 200 && pageErrors.length === 0,
      `status=${status} pageErrors=${pageErrors.length}${pageErrors.length ? ` :: ${pageErrors[0]}` : ''}`)
    check(`${r.path} 渲染出内容(非空白页)`, bodyLen > 40 && mainChildren > 0, `text=${bodyLen} chars, children=${mainChildren}`)
    if (r.expect) {
      check(`${r.path} 渲染的确实是预置实体「${r.expect}」(而非「未找到」早退分支)`, bodyText.includes(r.expect))
    }

    const notifReq = reqCount.get(STORM_URL) ?? 0
    if (notifReq >= STORM_MIN_REQ) stormSeen = true
    const exhaustion = consoleErrors.filter(isResourceExhaustion).length
    const onlyStormSymptoms = consoleErrors.every(isStormSymptom)
    // 资源耗尽是**浏览器级**的:一个标签页把 socket 打满后,后续标签页即使自己没发起风暴
    // 也会报 ERR_INSUFFICIENT_RESOURCES(实测:/workshop 风暴之后,/workshop/w/:wsId 单独看请求数
    // 并不多却仍然报错)。故用"本次冒烟里是否出现过风暴"作为全局判据,并把本页与全局计数都打出来。
    if (consoleErrors.length > 0 && onlyStormSymptoms && stormSeen && exhaustion >= STORM_MIN_EXHAUSTION) {
      console.log(`  WARN  ${r.path} 通知风暴的浏览器级连带(既存缺陷,非本轮重构):本页 ${notifReq} 次`
        + ` + ${exhaustion} 条资源耗尽错误${consoleErrors.length > exhaustion ? ' + build-meta 自检失败' : ''}`
        + `;见 connection.ts:87 每帧回调 onDataRecovered`)
    }
    else {
      // 打印**全部**去重后的错误(只印前两条会掩盖"第三条才是真因"的情况,实测踩过)
      const uniq = [...new Set(consoleErrors)]
      check(`${r.path} 无控制台错误`, consoleErrors.length === 0,
        uniq.length ? `${consoleErrors.length} 条/${uniq.length} 种 :: ${uniq.slice(0, 4).join(' || ')}` : '')
    }
    if (warnings.length) console.log(`  WARN  ${r.path} 水合告警(生产构建无细节;未改动页面同样存在): ${warnings[0]}`)
    await page.close()
  }
}
finally {
  await browser.close()
}

console.log(`\n${'='.repeat(64)}`)
console.log(`前端冒烟: PASS=${pass} FAIL=${fails.length}`)
for (const f of fails) console.log(`  FAIL  ${f}`)
console.log('='.repeat(64))
process.exit(fails.length > 0 ? 1 : 0)
