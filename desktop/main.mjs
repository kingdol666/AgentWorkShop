import { app, BrowserWindow, WebContentsView, dialog, ipcMain, Menu, session } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAppUrl, startSidecar } from './sidecar.mjs'
import { checkForUpdate, downloadUpdate, buildInstallHelper, INSTALL_HELPER_SCRIPT, UPDATE_REPO } from './update.mjs'
import {
  CHROME_CHANNELS,
  TITLEBAR_HEIGHT,
  cleanPageTitle,
  isChromeAction,
  normalizeTheme,
} from './chrome/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const backend = app.isPackaged ? join(process.resourcesPath, 'backend') : resolve(here, '..')
const node = app.isPackaged
  ? join(process.resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  : process.env.AW_DESKTOP_NODE_BIN || 'node'
const { desktopHome } = await import(pathToFileURL(join(backend, 'shared', 'config', 'home.mjs')).href)
const home = desktopHome()
const profile = join(home, 'electron')
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
app.setAppUserModelId('com.agentworkshop.desktop')

let shell
let contentView
let startup
let sidecar
let stopping = false
let allowQuit = false
let log
let pageTitle = ''
let theme = 'dark'
let serviceState = 'connecting'
let themeTimer
const UPDATE_INTERVAL_MS = 30 * 60 * 1000
let updateTimer
let updateRelease = null
let updateInstaller = null
let updateBusy = false
let updateState = { status: 'idle', version: null, progress: 0, error: null, notes: '' }

function sendToChrome(channel, payload) {
  if (!shell || shell.webContents.isDestroyed()) return
  shell.webContents.send(channel, payload)
}

function windowState() {
  return {
    maximized: shell?.isMaximized() ?? false,
    focused: shell?.isFocused() ?? true,
    platform: process.platform,
  }
}

function layout() {
  if (!shell || !contentView) return
  const { width, height } = shell.getContentBounds()
  contentView.setBounds({
    x: 0,
    y: TITLEBAR_HEIGHT,
    width: Math.max(0, width),
    height: Math.max(0, height - TITLEBAR_HEIGHT),
  })
}

function applyTheme(value) {
  const next = normalizeTheme(value)
  if (next === theme) return
  theme = next
  sendToChrome(CHROME_CHANNELS.theme, theme)
}

// The web build keeps its theme on <html class="dark"> and mirrors it into the
// aw-theme cookie only after a preference change. Read the DOM on load and on a
// slow poll so a fresh profile (no cookie) still matches the actual page.
async function syncThemeFromPage() {
  if (!contentView || contentView.webContents.isDestroyed()) return
  try {
    const dark = await contentView.webContents.executeJavaScript('document.documentElement.classList.contains("dark")', true)
    applyTheme(dark ? 'dark' : 'light')
  }
  catch {
    // The page may still be navigating; the next tick will retry.
  }
}

async function refreshTheme() {
  let value
  try {
    const cookies = await session.defaultSession.cookies.get({ name: 'aw-theme' })
    value = cookies[0]?.value
  }
  catch {
    value = undefined
  }
  applyTheme(value)
}

function currentVersion() {
  // Test-only override so an installed build can exercise the full update UI
  // against the public release without publishing a second version.
  const test = process.env.AW_UPDATE_TEST_VERSION?.trim()
  if (test && /^\d+\.\d+\.\d+$/.test(test)) return test
  const version = app.getVersion()
  if (version && version !== '0.0.0') return version
  try {
    return JSON.parse(readFileSync(join(backend, 'package.json'), 'utf8')).version || version
  }
  catch {
    return version
  }
}

function updateRepo() {
  if (app.isPackaged) return UPDATE_REPO
  return process.env.AW_UPDATE_REPO?.trim() || UPDATE_REPO
}

function sendUpdateState() {
  sendToChrome(CHROME_CHANNELS.updateState, {
    status: updateState.status,
    version: updateState.version,
    progress: updateState.progress,
    error: updateState.error,
    notes: updateState.notes,
  })
}

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch }
  sendUpdateState()
}

let updateChecking = false
async function checkUpdate() {
  if (updateChecking || updateBusy) return
  if (['downloading', 'ready'].includes(updateState.status)) return
  updateChecking = true
  try {
    const result = await checkForUpdate({ currentVersion: currentVersion(), repo: updateRepo() })
    if (result.status === 'available') {
      updateRelease = result.release
      setUpdateState({
        status: 'available',
        version: result.release.version,
        progress: 0,
        error: null,
        notes: result.release.notes,
      })
    }
    else {
      updateRelease = null
      setUpdateState({ status: 'idle', version: null, progress: 0, error: null, notes: '' })
    }
  }
  catch (err) {
    console.error('[update] check failed:', err.message)
    if (!['downloading', 'ready'].includes(updateState.status)) setUpdateState({ status: 'idle' })
  }
  finally {
    updateChecking = false
  }
}

async function beginDownload() {
  if (!updateRelease || updateBusy) return
  updateBusy = true
  setUpdateState({ status: 'downloading', version: updateRelease.version, progress: 0, error: null })
  try {
    const dir = join(tmpdir(), 'agentworkshop-update', updateRelease.version)
    mkdirSync(dir, { recursive: true })
    let lastAt = 0
    const result = await downloadUpdate(updateRelease, {
      dir,
      onProgress: (received, total) => {
        const progress = Math.max(0, Math.min(100, Math.floor((received * 100) / Math.max(1, total))))
        const now = Date.now()
        if (progress >= 100 || now - lastAt >= 250) {
          lastAt = now
          setUpdateState({ progress })
        }
      },
    })
    updateInstaller = result.path
    setUpdateState({ status: 'ready', progress: 100, error: null })
  }
  catch (err) {
    console.error('[update] download failed:', err.message)
    setUpdateState({ status: 'error', error: err.message })
  }
  finally {
    updateBusy = false
  }
}

async function installUpdate() {
  if (!app.isPackaged || process.platform !== 'win32') {
    await dialog.showMessageBox(shell, {
      type: 'info',
      title: '自动更新',
      message: '自动安装仅支持 Windows 安装版',
      detail: '当前运行为开发/源码模式。请使用安装版，或在源码目录重新构建。',
    })
    return
  }
  if (!updateInstaller || !existsSync(updateInstaller)) {
    setUpdateState({ status: 'error', error: '更新包不存在，请重新下载' })
    return
  }
  const choice = process.env.AW_UPDATE_AUTOINSTALL === '1'
    ? { response: 0 }
    : await dialog.showMessageBox(shell, {
        type: 'question',
        title: '安装更新',
        message: `安装 AgentWorkShop v${updateRelease.version} 并重启？`,
        detail: (updateRelease.notes || '更新完成后应用会自动重启。').slice(0, 1_200),
        buttons: ['重启并安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
  if (choice.response !== 0) return
  const installer = updateInstaller
  const exe = process.execPath
  // The app stops its sidecar first; the detached helper waits for our files to
  // unlock, runs the NSIS installer silently, then starts the updated executable.
  const helperScript = join(tmpdir(), 'agentworkshop-update-helper.vbs')
  writeFileSync(helperScript, INSTALL_HELPER_SCRIPT, 'ascii')
  const helper = buildInstallHelper({ installer, executable: exe, scriptPath: helperScript, env: process.env })
  spawn(helper.file, helper.args, { detached: true, stdio: 'ignore', windowsHide: true, env: helper.env }).unref()
  quit()
}

function scheduleUpdates() {
  if (process.env.AW_UPDATE_CHECK === '0' || updateTimer) return
  setTimeout(() => void checkUpdate(), 4_000).unref()
  updateTimer = setInterval(() => void checkUpdate(), UPDATE_INTERVAL_MS)
  updateTimer.unref()
}

function registerChromeIpc() {
  ipcMain.on(CHROME_CHANNELS.action, (event, action) => {
    if (!shell || event.sender !== shell.webContents || !isChromeAction(action)) return
    if (action === 'minimize') shell.minimize()
    else if (action === 'toggle-maximize') {
      if (shell.isMaximized()) shell.unmaximize()
      else shell.maximize()
    }
    else { shell.close() }
  })
  ipcMain.on(CHROME_CHANNELS.hello, (event) => {
    if (event.sender !== shell?.webContents) return
    sendToChrome(CHROME_CHANNELS.state, windowState())
    sendToChrome(CHROME_CHANNELS.status, serviceState)
    sendToChrome(CHROME_CHANNELS.theme, theme)
    sendToChrome(CHROME_CHANNELS.title, pageTitle)
    sendUpdateState()
  })
  ipcMain.on(CHROME_CHANNELS.update, (event, action) => {
    if (!shell || event.sender !== shell.webContents || action !== 'activate') return
    if (updateState.status === 'available') void beginDownload()
    else if (updateState.status === 'ready') void installUpdate()
    else if (updateState.status === 'error') void checkUpdate()
  })
}

function watchTheme() {
  void refreshTheme()
  session.defaultSession.cookies.on('changed', (_event, cookie) => {
    if (cookie.name === 'aw-theme') void refreshTheme()
  })
}

function quit() {
  if (stopping) return
  stopping = true
  void (async () => {
    try {
      await startup?.catch(() => {})
      await sidecar?.stop()
    }
    catch (err) {
      console.error(err)
      dialog.showErrorBox('AgentWorkShop', '后台服务未确认停止。请查看桌面服务日志。')
    }
    finally {
      log?.end()
      allowQuit = true
      app.quit()
    }
  })()
}

function harden(contents, { origin, chrome = false }) {
  const restrict = (event, url) => {
    if (chrome || !isAppUrl(url, origin)) event.preventDefault()
  }
  contents.on('will-navigate', restrict)
  contents.on('will-redirect', restrict)
  contents.on('will-attach-webview', event => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

async function createShell(origin) {
  const browser = new BrowserWindow({
    width: 1440,
    height: 950,
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#070c14',
    title: 'AgentWorkShop',
    icon: join(here, 'build', 'icon.png'),
    webPreferences: {
      preload: join(here, 'chrome', 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: false,
    },
  })
  shell = browser
  harden(browser.webContents, { origin, chrome: true })

  contentView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: true,
    },
  })
  contentView.setBackgroundColor('#070c14')
  harden(contentView.webContents, { origin })
  contentView.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  contentView.webContents.session.setPermissionCheckHandler(() => false)
  await contentView.webContents.session.setProxy({ mode: 'direct' })

  contentView.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault()
    pageTitle = cleanPageTitle(title)
    sendToChrome(CHROME_CHANNELS.title, pageTitle)
  })
  contentView.webContents.on('did-finish-load', () => void syncThemeFromPage())

  browser.contentView.addChildView(contentView)
  layout()

  for (const event of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    browser.on(event, () => {
      layout()
      sendToChrome(CHROME_CHANNELS.state, windowState())
    })
  }
  browser.on('focus', () => sendToChrome(CHROME_CHANNELS.state, windowState()))
  browser.on('blur', () => sendToChrome(CHROME_CHANNELS.state, windowState()))
  browser.on('closed', () => {
    clearInterval(themeTimer)
    themeTimer = undefined
    clearInterval(updateTimer)
    updateTimer = undefined
    shell = undefined
    contentView = undefined
  })

  await browser.loadFile(join(here, 'chrome', 'titlebar.html'))
  await contentView.webContents.loadURL(origin)
  await refreshTheme()
  await syncThemeFromPage()
  layout()
  browser.show()
  contentView.webContents.focus()
  scheduleUpdates()
  themeTimer = setInterval(() => void syncThemeFromPage(), 2_000)
  themeTimer.unref()
}

async function open() {
  const logs = join(home, 'logs')
  mkdirSync(logs, { recursive: true })
  log = createWriteStream(join(logs, 'desktop-server.log'), { flags: 'a' })
  log.on('error', err => console.error('Desktop log:', err.message))
  sidecar = await startSidecar({ node, backend, home, log })
  if (stopping) return
  serviceState = 'online'
  await createShell(sidecar.origin)
  if (stopping) return
  void sidecar.closed.then(() => {
    if (stopping) return
    serviceState = 'offline'
    sendToChrome(CHROME_CHANNELS.status, serviceState)
    shell?.destroy()
    console.error('Desktop server supervisor stopped')
    quit()
  })
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (shell?.isMinimized()) shell.restore()
    shell?.show()
    shell?.focus()
  })
  app.on('window-all-closed', quit)
  app.on('before-quit', (event) => {
    if (allowQuit) return
    event.preventDefault()
    quit()
  })
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    registerChromeIpc()
    watchTheme()
    if (stopping) return
    startup = open()
    void startup.catch((err) => {
      console.error(err)
      if (!stopping) dialog.showErrorBox('AgentWorkShop', `无法启动桌面服务。\n${err.message}\n日志目录：${join(home, 'logs')}`)
      quit()
    })
  })
}
