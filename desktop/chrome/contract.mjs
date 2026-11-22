// Shared, Electron-free contract between the desktop shell, its titlebar, the
// boot splash and the test suite. Keeping the values here lets unit tests
// assert the IPC surface without importing electron (which cannot load outside
// the Electron runtime).

export const TITLEBAR_HEIGHT = 40

export const CHROME_ACTIONS = Object.freeze(['minimize', 'toggle-maximize', 'close'])

export const CHROME_CHANNELS = Object.freeze({
  action: 'aw-chrome:action',
  hello: 'aw-chrome:hello',
  state: 'aw-chrome:state',
  status: 'aw-chrome:status',
  theme: 'aw-chrome:theme',
  title: 'aw-chrome:title',
  prefs: 'aw-chrome:prefs',
  update: 'aw-chrome:update',
  updateState: 'aw-chrome:update-state',
})

export const SPLASH_CHANNELS = Object.freeze({
  action: 'aw-splash:action',
  hello: 'aw-splash:hello',
  state: 'aw-splash:state',
})

export const SPLASH_ACTIONS = Object.freeze(['retry', 'open-logs', 'quit'])

export const CHROME_THEMES = Object.freeze(['dark', 'light'])

/** True for the three window-control actions; everything else is ignored. */
export function isChromeAction(value) {
  return typeof value === 'string' && CHROME_ACTIONS.includes(value)
}

/** True for the fixed splash actions; no other message reaches the main process. */
export function isSplashAction(value) {
  return typeof value === 'string' && SPLASH_ACTIONS.includes(value)
}

/** Normalize a document title for the rail: drop the product suffix, clamp length.
 *  A bare product title carries no page information, so it is treated as empty. */
export function cleanPageTitle(raw) {
  if (typeof raw !== 'string') return ''
  const title = raw.replace(/\s+[·|-]\s+AgentWorkShop\s*$/i, '').replace(/\s+/g, ' ').trim()
  if (!title || /^AgentWorkShop$/i.test(title)) return ''
  return title.length > 48 ? `${title.slice(0, 47)}…` : title
}

/** The app mirrors its theme into an `aw-theme` cookie; anything else means dark. */
export function normalizeTheme(value) {
  return value === 'light' ? 'light' : 'dark'
}

// Boot stages drive both the splash copy and the real boot order. Progress is
// monotonic; the splash never invents a percentage the backend has not reached.
export const BOOT_STAGES = Object.freeze([
  Object.freeze({ id: 'prepare', title: '准备运行环境', detail: '校验安装载荷与用户数据目录', progress: 10 }),
  Object.freeze({ id: 'data', title: '初始化工作区', detail: '创建数据目录并检查数据库结构', progress: 28 }),
  Object.freeze({ id: 'service', title: '启动本机服务', detail: '启动 Nitro、API 与插件宿主', progress: 52 }),
  Object.freeze({ id: 'workshop', title: '装配智能体工作台', detail: '恢复 Channel、Session 与任务状态', progress: 78 }),
  Object.freeze({ id: 'ready', title: '工作台已就绪', detail: '正在进入主界面', progress: 100 }),
])

export function bootStage(id) {
  return BOOT_STAGES.find(stage => stage.id === id) ?? BOOT_STAGES[0]
}

/** Ids of the four steps rendered as a checklist (ready is the completed rail). */
export const SPLASH_STEPS = Object.freeze(BOOT_STAGES.filter(stage => stage.id !== 'ready').map(stage => stage.id))

// Tray settings. Defaults are the safe, least-surprising behavior for a
// desktop app that owns a local backend: closing hides instead of killing the
// running workshop, and updates keep checking in the background.
export const DEFAULT_SETTINGS = Object.freeze({
  closeToTray: true,
  launchAtLogin: false,
  startHidden: false,
  trayNotifications: true,
  autoCheckUpdates: true,
})

export const SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS))

/** Coerce persisted JSON into the exact boolean settings surface. Unknown keys
 *  are dropped so a hand-edited settings file cannot add privileged behavior. */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const settings = {}
  for (const key of SETTINGS_KEYS) {
    settings[key] = typeof source[key] === 'boolean' ? source[key] : DEFAULT_SETTINGS[key]
  }
  return settings
}
