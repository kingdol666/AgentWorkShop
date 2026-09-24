/**
 * UI 视觉走查公共库 —— 真实浏览器(puppeteer-core + 本机 Chrome)驱动的
 * 截图 / 自适应审计 / 录屏(GIF)统一入口。
 *
 * 为什么集中在一处:此前 20+ 个 _dbg-*.mjs 各写一遍 launch/login/screenshot,
 * 浏览器路径、登录方式、等待策略各不一致,改一处要改二十处。这里收敛为
 * 一个可复用对象(huashu-design「可复用优先」+ 项目 hygiene 要求)。
 */
import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

export const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3021'
export const CHROME = process.env.AW_CHROME
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

/**
 * 渲染倍率:默认 2(视觉走查/截图取清晰像素)。
 * 资源紧张的机器(或长链路交互 E2E:多页 + 整页截图)可 `AW_UI_SCALE=1` 降一档 ——
 * 否则 Chromium 会以 `net::ERR_INSUFFICIENT_RESOURCES` 拒绝加载后续资源,
 * 表现为"页面加载不出来",实际是渲染表面内存打满(与产品无关)。
 */
export const UI_SCALE = Number(process.env.AW_UI_SCALE ?? 2) || 2

export const VISUAL_USER = {
  name: 'visual',
  email: 'visual@awshop.local',
  password: 'Visual2026',
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 站点全部页面(与 app/pages 一一对应) —— 自适应审计矩阵的行 */
export const ROUTES = [
  { path: '/', name: 'dashboard', title: '仪表盘' },
  { path: '/workshop', name: 'workshop', title: 'Agent 工作台' },
  { path: '/workshop/agents', name: 'agents', title: 'Agent 管理' },
  { path: '/workshop/teams', name: 'teams', title: '团队/频道' },
  { path: '/workshop/channel-templates', name: 'templates', title: '频道模板' },
  { path: '/monitor', name: 'monitor', title: '实时监控 & HITL' },
  { path: '/daq', name: 'daq', title: '数采中心' },
  { path: '/dcw', name: 'dcw', title: '产线作业' },
  { path: '/aml', name: 'aml', title: '自动建模实验室' },
  { path: '/town', name: 'town', title: '数字孪生' },
  { path: '/logs', name: 'logs', title: '审计日志' },
  { path: '/permissions', name: 'permissions', title: '产线权限' },
  { path: '/plugins', name: 'plugins', title: '插件' },
  { path: '/settings', name: 'settings', title: '设置' },
  { path: '/tokens', name: 'tokens', title: 'API Token' },
  { path: '/users', name: 'users', title: '用户' },
]

/** 自适应验收视口矩阵:从 iPhone SE 到超宽屏,含横屏与平板 */
export const VIEWPORTS = [
  { name: 'xs-320', width: 320, height: 720, label: 'iPhone SE(竖)' },
  { name: 'sm-390', width: 390, height: 844, label: 'iPhone 14(竖)' },
  { name: 'mobile-land-844', width: 844, height: 390, label: '手机横屏' },
  { name: 'tablet-768', width: 768, height: 1024, label: 'iPad(竖)' },
  { name: 'laptop-1280', width: 1280, height: 800, label: '笔记本' },
  { name: 'desktop-1440', width: 1440, height: 900, label: '桌面' },
  { name: 'wide-1920', width: 1920, height: 1080, label: '宽屏' },
]

/** REST 调用(JSON envelope 解包) */
export async function api(method, endpoint, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  }
  catch {
    return { code: -1, message: `HTTP ${res.status}: ${text.slice(0, 200)}`, data: null }
  }
}

/** 确保存在一个可登录的视觉走查账号(admin 角色,便于看到全部页面真实数据) */
export async function ensureVisualUser() {
  let login = await api('POST', '/api/users/login', {
    body: { email: VISUAL_USER.email, password: VISUAL_USER.password },
  })
  if (login.code === 0 && login.data?.token) return login.data.token

  const reg = await api('POST', '/api/users/register', {
    body: { name: VISUAL_USER.name, email: VISUAL_USER.email, password: VISUAL_USER.password },
  })
  if (reg.code === 0 && reg.data?.token) return reg.data.token

  // 已存在但密码不同 → 直接改库(仅测试种子用途)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync('.AgentWorkShop/data/users.sqlite')
  db.prepare('update users set role=\'admin\', status=\'active\' where email=?').run(VISUAL_USER.email)
  db.close()
  login = await api('POST', '/api/users/login', {
    body: { email: VISUAL_USER.email, password: VISUAL_USER.password },
  })
  if (login.code === 0 && login.data?.token) return login.data.token
  throw new Error(`无法取得视觉走查账号 token: ${login.message}`)
}

/** 把账号提升为 admin(测试种子;生产数据不受影响,只改这一行) */
export async function promoteToAdmin() {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync('.AgentWorkShop/data/users.sqlite')
  db.prepare('update users set role=\'admin\' where email=?').run(VISUAL_USER.email)
  db.close()
}

export async function launch({ width = 1440, height = 900 } = {}) {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    // 重页面(echarts/three/phaser + 首帧 SSR 水合)在**负载较高的机器**上单次
    // Runtime.evaluate 可能超过 CDP 默认 180s → ProtocolError 直接把断言打断。
    // 这里放宽到 5 分钟:慢 ≠ 失败,断言本身仍各自带超时。
    protocolTimeout: 300_000,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
    ],
    defaultViewport: { width, height, deviceScaleFactor: UI_SCALE },
  })
}

/**
 * 打开一个已登录页面。
 * 主题必须同时写 cookie(SSR 首帧)与 localStorage(pinia 持久化),
 * 只写其一会导致首帧闪色 + antd cssinjs 不重注入(历史踩坑)。
 */
export async function openPage(browser, {
  token, dark = true, width = 1440, height = 900, deviceScaleFactor = UI_SCALE, touch,
} = {}) {
  const page = await browser.newPage()
  // 窄视口默认按**触摸设备**仿真:不这么做,Chromium 报告 pointer:fine →
  // 全局层 @media (pointer: coarse) 的 40px 触摸目标规则根本不生效,
  // 审计会把"桌面鼠标语境下的紧凑按钮"误判成"手机上点不中"(实测踩过)。
  const isTouch = touch ?? width <= 900
  await page.setViewport({
    width, height, deviceScaleFactor, isMobile: isTouch, hasTouch: isTouch,
  })
  if (token) {
    await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
  }
  await page.setCookie({
    name: 'aw-theme', value: dark ? 'dark' : 'light', domain: '127.0.0.1', path: '/',
  })
  await page.evaluateOnNewDocument((isDark) => {
    try {
      localStorage.setItem('app', JSON.stringify({
        isDark, sidebarCollapsed: false, accent: null, themeTouched: true,
      }))
    }
    catch { /* 页面跳转瞬间可能失败,跳过该帧 */ }
  }, dark)
  return page
}

/**
 * 导航到某页并**等到客户端真正水合完成**。
 *
 * 为什么不能只等 domcontentloaded + sleep:dev 模式下首个请求要现场编译客户端
 * 包(实测冷启动 >9s),此时页面只是 SSR 快照 —— 主题、断点、图表全都没接管。
 * 拿这种快照做视觉验收,会把"还没水合"误判成"设计有问题"(踩过一次)。
 *
 * 水合判据用 <html data-vp-tier>:它由 useResponsive 在客户端 watchEffect 里写入,
 * 出现即证明客户端 setup 已跑、响应式判据已生效。
 */
export async function gotoReady(page, path, { wait = 2500, timeout = 90000 } = {}) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(
    () => document.documentElement.dataset.vpTier !== undefined,
    { timeout, polling: 200 },
  )
  await sleep(wait)
  return page
}

/** 逐帧录屏器:采集 PNG 序列后交给 ffmpeg 合成 GIF(palette 优化) */
export function createRecorder(page, { dir, fps = 12, maxFrames = 400 }) {
  fs.mkdirSync(dir, { recursive: true })
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true })
  let n = 0
  let stopped = false
  const tick = async () => {
    if (stopped || n >= maxFrames) return
    const i = n++
    try {
      await page.screenshot({ path: path.join(dir, `f${String(i).padStart(5, '0')}.png`), type: 'png' })
    }
    catch { /* 页面跳转瞬间可能失败,跳过该帧 */ }
  }
  const timer = setInterval(tick, Math.round(1000 / fps))
  return {
    dir,
    frames: () => n,
    async stop() {
      stopped = true
      clearInterval(timer)
    },
    tick,
  }
}
