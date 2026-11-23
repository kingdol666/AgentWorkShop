import { app, BrowserWindow, WebContentsView, dialog, ipcMain, Menu, session, Tray, nativeImage, nativeTheme, Notification, shell as electronShell } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAppUrl, startSidecar } from './sidecar.mjs'
import { checkForUpdate, downloadUpdate, buildInstallHelper, INSTALL_HELPER_SCRIPT, UPDATE_REPO } from './update.mjs'
import {
  CHROME_CHANNELS,
  SPLASH_CHANNELS,
  TITLEBAR_HEIGHT,
  bootStage,
  cleanPageTitle,
  isChromeAction,
  isSplashAction,
  normalizeTheme,
} from './chrome/contract.mjs'
import { loadSettings, saveSettings } from './chrome/settings.mjs'
import { buildTrayMenuModel, TRAY_SETTING_KEYS, TRAY_SETTINGS } from './chrome/tray-menu.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const backend = app.isPackaged ? join(process.resourcesPath, 'backend') : resolve(here, '..')
const node = app.isPackaged
  ? join(process.resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  : process.env.AW_DESKTOP_NODE_BIN || 'node'
const { desktopHome } = await import(pathToFileURL(join(backend, 'shared', 'config', 'home.mjs')).href)
const home = desktopHome()
const profile = join(home, 'electron')
const settingsFile = join(profile, 'settings.json')
const statusFile = join(profile, 'desktop-status.json')
const logsDir = join(home, 'logs')
mkdirSync(profile, { recursive: true })
mkdirSync(logsDir, { recursive: true })
app.setPath('userData', profile)
app.setAppUserModelId('com.agentworkshop.desktop')

let settings = loadSettings(settingsFile)
let shell
let contentView
let splashWindow
let startup
let sidecar
let sidecarGeneration = 0
let restarting = false
let stopping = false
let allowQuit = false
let log
let tray
let hideNoticeShown = false
let pageTitle = ''
let theme = 'dark'
let serviceState = 'connecting'
let statusPhase = 'booting'
let lastStartupError = null
let bootStartedAt = Date.now()
let splashState = null
let themeTimer
const startedAt = new Date().toISOString()
const UPDATE_INTERVAL_MS = 30 * 60 * 1000
const MIN_SPLASH_MS = 2_000
let updateTimer
let updateStartTimer
let updateRelease = null
let updateInstaller = null
let updateBusy = false
let updateState = { status: 'idle', version: null, progress: 0, error: null, notes: '' }

function sendToChrome(channel, payload) {
  if (!shell || shell.webContents.isDestroyed()) return
  shell.webContents.send(channel, payload)
}

function sendPrefs() {
  sendToChrome(CHROME_CHANNELS.prefs, { closeToTray: settings.closeToTray })
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

function writeStatus() {
  const snapshot = {
    schema: 1,
    product: 'AgentWorkShop',
    pid: process.pid,
    version: currentVersion(),
    phase: statusPhase,
    bootStage: splashState?.phase ?? null,
    service: serviceState,
    port: sidecar?.port ?? null,
    origin: sidecar?.origin ?? null,
    windowVisible: Boolean(shell && !shell.isDestroyed() && shell.isVisible()),
    windowFocused: Boolean(shell && !shell.isDestroyed() && shell.isFocused()),
    trayCreated: Boolean(tray && !tray.isDestroyed()),
    settings,
    startedAt,
    updatedAt: new Date().toISOString(),
    lastError: lastStartupError,
  }
  try {
    writeFileSync(statusFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  }
  catch (err) {
    console.error('[desktop] could not write status:', err.message)
  }
}

function setServiceState(next) {
  serviceState = next
  sendToChrome(CHROME_CHANNELS.status, serviceState)
  refreshTray()
  writeStatus()
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
  refreshTray()
}

let updateChecking = false
async function checkUpdate({ manual = false } = {}) {
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
      if (manual) notify('发现新版本', `AgentWorkShop v${result.release.version} 可在标题栏安装。`)
    }
    else {
      updateRelease = null
      setUpdateState({ status: 'idle', version: null, progress: 0, error: null, notes: '' })
      if (manual) notify('已是最新版本', `当前版本 v${currentVersion()}`)
    }
  }
  catch (err) {
    console.error('[update] check failed:', err.message)
    if (!['downloading', 'ready'].includes(updateState.status)) setUpdateState({ status: 'idle' })
    if (manual) notify('检查更新失败', err.message)
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
    await showMessageBox({
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
  const options = {
    type: 'question',
    title: '安装更新',
    message: `安装 AgentWorkShop v${updateRelease.version} 并重启？`,
    detail: (updateRelease.notes || '更新完成后应用会自动重启。').slice(0, 1_200),
    buttons: ['重启并安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
  }
  const choice = process.env.AW_UPDATE_AUTOINSTALL === '1'
    ? { response: 0 }
    : await showMessageBox(options)
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
  if (process.env.AW_UPDATE_CHECK === '0' || updateTimer || !settings.autoCheckUpdates) return
  updateStartTimer = setTimeout(() => void checkUpdate(), 4_000)
  updateStartTimer.unref()
  updateTimer = setInterval(() => void checkUpdate(), UPDATE_INTERVAL_MS)
  updateTimer.unref()
}

function stopUpdates() {
  clearTimeout(updateStartTimer)
  clearInterval(updateTimer)
  updateStartTimer = undefined
  updateTimer = undefined
}

function showMessageBox(options) {
  const parent = shell && !shell.isDestroyed() && shell.isVisible() ? shell : undefined
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
}

function notify(title, content) {
  if (!settings.trayNotifications) return
  try {
    if (Notification.isSupported()) {
      const notification = new Notification({
        title,
        body: content,
        icon: join(here, 'build', 'icon.png'),
        silent: true,
      })
      notification.on('click', () => showMain())
      notification.show()
      return
    }
  }
  catch {
    // Fall through to the tray balloon on systems without toast support.
  }
  if (tray && !tray.isDestroyed()) {
    try {
      tray.displayBalloon({ title, content, iconType: 'info', noSound: true })
    }
    catch {
      // Notifications are best-effort; never break the shell for a balloon.
    }
  }
}

function showMain() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.show()
    splashWindow.focus()
    return
  }
  if (!shell || shell.isDestroyed()) return
  if (shell.isMinimized()) shell.restore()
  shell.show()
  shell.focus()
  statusPhase = 'ready'
  writeStatus()
  refreshTray()
}

function hideToTray() {
  if (!shell || shell.isDestroyed()) return
  shell.hide()
  statusPhase = 'hidden'
  writeStatus()
  refreshTray()
  if (!hideNoticeShown) {
    hideNoticeShown = true
    notify('AgentWorkShop 仍在运行', '已最小化到托盘，本机服务继续运行。双击托盘图标可恢复窗口。')
  }
}

function trayImage() {
  // 托盘用裸字标(无铭牌底板):深色任务栏给信号绿,浅色任务栏给深玉绿。
  // 32 px 源图由 Windows 按 DPI 缩放,16/24 px 槽位仍保持笔画清晰。
  const file = nativeTheme.shouldUseDarkColors ? 'tray-dark.png' : 'tray-light.png'
  const image = nativeImage.createFromPath(join(here, 'build', file))
  if (image.isEmpty()) return nativeImage.createEmpty()
  return image
}

let trayThemeBound = false

function bindTrayTheme() {
  if (trayThemeBound) return
  trayThemeBound = true
  nativeTheme.on('updated', () => {
    if (tray && !tray.isDestroyed()) tray.setImage(trayImage())
  })
}

function trayMenuItem(descriptor) {
  if (descriptor.type === 'separator') return { type: 'separator' }
  const item = { label: descriptor.label, enabled: descriptor.enabled !== false }
  if (descriptor.type === 'checkbox') {
    item.type = 'checkbox'
    item.checked = Boolean(descriptor.checked)
    item.click = () => handleTrayAction(descriptor.id)
  }
  else if (Array.isArray(descriptor.submenu)) {
    item.submenu = descriptor.submenu.map(trayMenuItem)
  }
  else {
    item.click = () => handleTrayAction(descriptor.id)
  }
  return item
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return
  const model = buildTrayMenuModel({
    settings,
    service: serviceState,
    port: sidecar?.port,
    version: currentVersion(),
    windowVisible: Boolean(shell && !shell.isDestroyed() && shell.isVisible()),
    update: updateState,
  })
  tray.setContextMenu(Menu.buildFromTemplate(model.map(trayMenuItem)))
  const service = serviceState === 'online'
    ? '本机服务运行中'
    : serviceState === 'offline' ? '本机服务已断开' : '正在启动本机服务'
  tray.setToolTip(`AgentWorkShop v${currentVersion()} · ${service}`)
}

function createTray() {
  if (tray && !tray.isDestroyed()) return
  tray = new Tray(trayImage())
  tray.on('click', () => showMain())
  tray.on('double-click', () => showMain())
  bindTrayTheme()
  refreshTray()
  writeStatus()
}

function openHome() {
  void electronShell.openPath(home).catch(err => console.error('[desktop] open home:', err.message))
}

function openLogs() {
  mkdirSync(logsDir, { recursive: true })
  void electronShell.openPath(logsDir).catch(err => console.error('[desktop] open logs:', err.message))
}

function reloadContent() {
  if (!contentView || contentView.webContents.isDestroyed()) return
  contentView.webContents.reload()
}

async function showDiagnostics() {
  const text = [
    `版本：v${currentVersion()}`,
    `本机服务：${serviceState === 'online' ? `运行中 · 127.0.0.1:${sidecar?.port ?? '?'}` : serviceState === 'offline' ? '已断开' : '启动中'}`,
    `数据目录：${home}`,
    `日志目录：${logsDir}`,
    `运行状态：${statusPhase}`,
    `关闭行为：${settings.closeToTray ? '最小化到托盘' : '退出应用'}`,
    `开机自动启动：${settings.launchAtLogin ? '开启' : '关闭'}${app.isPackaged ? '' : '（源码模式不写入系统）'}`,
    `启动后最小化：${settings.startHidden ? '开启' : '关闭'}`,
    `自动检查更新：${settings.autoCheckUpdates ? '开启' : '关闭'}`,
  ].join('\n')
  const result = await showMessageBox({
    type: 'info',
    title: 'AgentWorkShop 诊断',
    message: '桌面运行诊断',
    detail: text,
    buttons: ['打开数据目录', '打开日志目录', '关闭'],
    defaultId: 2,
    cancelId: 2,
  })
  if (result.response === 0) openHome()
  if (result.response === 1) openLogs()
}

function applyLoginItem() {
  if (!app.isPackaged) return false
  try {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, path: process.execPath, args: [] })
    return true
  }
  catch (err) {
    console.error('[desktop] login item:', err.message)
    return false
  }
}

function toggleSetting(key) {
  if (!TRAY_SETTING_KEYS.includes(key)) return
  const next = { ...settings, [key]: !settings[key] }
  try {
    settings = saveSettings(settingsFile, next)
  }
  catch (err) {
    console.error('[desktop] save settings:', err.message)
    notify('设置未保存', err.message)
    return
  }
  if (key === 'launchAtLogin') {
    const applied = applyLoginItem()
    if (!applied && settings.launchAtLogin) {
      notify('开机自启动', '源码模式不写入系统登录项；安装版会立即生效。')
    }
  }
  if (key === 'autoCheckUpdates') {
    if (settings.autoCheckUpdates) scheduleUpdates()
    else stopUpdates()
  }
  sendPrefs()
  refreshTray()
  writeStatus()
  const label = TRAY_SETTINGS.find(item => item.key === key)?.label ?? key
  notify('设置已更新', `${label}：${settings[key] ? '开启' : '关闭'}`)
}

function manualUpdateAction() {
  if (updateState.status === 'ready') {
    showMain()
    void installUpdate()
    return
  }
  if (updateState.status === 'downloading') {
    showMain()
    return
  }
  if (updateState.status === 'available') {
    showMain()
    notify('发现新版本', `AgentWorkShop v${updateState.version} 可在标题栏安装。`)
    return
  }
  void checkUpdate({ manual: true })
}

function handleTrayAction(id) {
  if (typeof id !== 'string') return
  if (id.startsWith('setting:')) {
    toggleSetting(id.slice('setting:'.length))
    return
  }
  switch (id) {
    case 'open':
      showMain()
      break
    case 'reload':
      reloadContent()
      break
    case 'restart-service':
      void restartBackend()
      break
    case 'check-update':
      manualUpdateAction()
      break
    case 'open-home':
      openHome()
      break
    case 'open-logs':
      openLogs()
      break
    case 'diagnostics':
      void showDiagnostics()
      break
    case 'quit':
      quit()
      break
    default:
      break
  }
}

function registerChromeIpc() {
  ipcMain.on(CHROME_CHANNELS.action, (event, action) => {
    if (!shell || event.sender !== shell.webContents || !isChromeAction(action)) return
    if (action === 'minimize') shell.minimize()
    else if (action === 'toggle-maximize') {
      if (shell.isMaximized()) shell.unmaximize()
      else shell.maximize()
    }
    else if (settings.closeToTray) hideToTray()
    else shell.close()
  })
  ipcMain.on(CHROME_CHANNELS.hello, (event) => {
    if (event.sender !== shell?.webContents) return
    sendToChrome(CHROME_CHANNELS.state, windowState())
    sendToChrome(CHROME_CHANNELS.status, serviceState)
    sendToChrome(CHROME_CHANNELS.theme, theme)
    sendToChrome(CHROME_CHANNELS.title, pageTitle)
    sendPrefs()
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
  statusPhase = 'quitting'
  writeStatus()
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

function splashPayload() {
  return {
    ...splashState,
    version: currentVersion(),
    logPath: logsDir,
  }
}

function sendSplashState() {
  if (!splashWindow || splashWindow.isDestroyed() || !splashState) return
  splashWindow.webContents.send(SPLASH_CHANNELS.state, splashPayload())
}

function resetSplashState() {
  bootStartedAt = Date.now()
  splashState = {
    phase: 'prepare',
    title: bootStage('prepare').title,
    detail: bootStage('prepare').detail,
    progress: bootStage('prepare').progress,
    startedAt: bootStartedAt,
    trace: [],
    error: null,
    leaving: false,
  }
}

function setBootStage(id) {
  const stage = bootStage(id)
  const at = Date.now() - bootStartedAt
  splashState = {
    ...(splashState ?? {}),
    phase: stage.id,
    title: stage.title,
    detail: stage.detail,
    progress: Math.max(splashState?.progress ?? 0, stage.progress),
    startedAt: bootStartedAt,
    error: null,
    leaving: false,
    trace: [...(splashState?.trace ?? []), { at, text: stage.title }].slice(-6),
  }
  sendSplashState()
  writeStatus()
}

function setSplashError(err) {
  const message = String(err?.message || err || '未知错误').slice(0, 800)
  lastStartupError = message
  splashState = {
    ...(splashState ?? {}),
    phase: 'error',
    title: '启动失败',
    detail: '本机服务未能就绪',
    error: message,
    startedAt: bootStartedAt,
    leaving: false,
    trace: [...(splashState?.trace ?? []), { at: Date.now() - bootStartedAt, text: '启动失败' }].slice(-6),
  }
  statusPhase = 'error'
  sendSplashState()
  writeStatus()
  refreshTray()
}

function createSplash() {
  resetSplashState()
  const browser = new BrowserWindow({
    width: 660,
    height: 440,
    center: true,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: '#070c14',
    title: 'AgentWorkShop',
    icon: join(here, 'build', 'icon.png'),
    webPreferences: {
      preload: join(here, 'chrome', 'preload-splash.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: false,
    },
  })
  splashWindow = browser
  harden(browser.webContents, { chrome: true })
  browser.webContents.on('did-finish-load', () => sendSplashState())
  browser.once('ready-to-show', () => {
    if (!stopping) browser.show()
  })
  browser.on('closed', () => {
    if (splashWindow === browser) splashWindow = undefined
    if (!stopping && !shell) quit()
  })
  void browser.loadFile(join(here, 'chrome', 'splash.html')).catch((err) => {
    console.error('[desktop] splash:', err.message)
    const fallback = splashWindow
    splashWindow = undefined
    if (fallback && !fallback.isDestroyed()) fallback.destroy()
  })
}

function registerSplashIpc() {
  ipcMain.on(SPLASH_CHANNELS.hello, (event) => {
    if (event.sender !== splashWindow?.webContents) return
    sendSplashState()
  })
  ipcMain.on(SPLASH_CHANNELS.action, (event, action) => {
    if (event.sender !== splashWindow?.webContents || !isSplashAction(action)) return
    if (action === 'retry') void retryStartup()
    else if (action === 'open-logs') openLogs()
    else quit()
  })
}

async function settleSplash() {
  const remaining = MIN_SPLASH_MS - (Date.now() - bootStartedAt)
  if (remaining > 0) await wait(remaining)
}

function destroySplash() {
  const browser = splashWindow
  splashWindow = undefined
  if (browser && !browser.isDestroyed()) browser.destroy()
}

async function revealMain() {
  setBootStage('ready')
  await settleSplash()
  if (stopping) return
  if (settings.startHidden) {
    statusPhase = 'hidden'
    destroySplash()
    notify('AgentWorkShop 已在托盘运行', '本机服务已就绪。双击托盘图标打开主窗口。')
    writeStatus()
    refreshTray()
  }
  else {
    if (shell && !shell.isDestroyed()) {
      shell.show()
      shell.focus()
      contentView?.webContents.focus()
    }
    statusPhase = 'ready'
    splashState = { ...splashState, leaving: true }
    sendSplashState()
    await wait(300)
    destroySplash()
    writeStatus()
    refreshTray()
  }
  scheduleUpdates()
  scheduleTestAutoquit()
  scheduleTestTrayMenu()
}

function scheduleTestAutoquit() {
  const raw = Number(process.env.AW_DESKTOP_TEST_AUTOQUIT_MS)
  if (!Number.isFinite(raw) || raw <= 0) return
  const timer = setTimeout(() => {
    console.log(`[desktop:test] auto quit after ${raw}ms`)
    quit()
  }, raw)
  timer.unref()
}

function scheduleTestTrayMenu() {
  const raw = Number(process.env.AW_DESKTOP_TEST_TRAY_MENU_MS)
  if (!Number.isFinite(raw) || raw <= 0) return
  const timer = setTimeout(() => {
    if (tray && !tray.isDestroyed()) tray.popUpContextMenu()
  }, raw)
  timer.unref()
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
  browser.on('close', (event) => {
    if (allowQuit || !settings.closeToTray) return
    event.preventDefault()
    hideToTray()
  })
  browser.on('show', () => {
    if (statusPhase === 'hidden') statusPhase = 'ready'
    writeStatus()
    refreshTray()
  })
  browser.on('hide', () => {
    if (!stopping && statusPhase === 'ready') statusPhase = 'hidden'
    writeStatus()
    refreshTray()
  })
  browser.on('closed', () => {
    clearInterval(themeTimer)
    themeTimer = undefined
    stopUpdates()
    shell = undefined
    contentView = undefined
    writeStatus()
    refreshTray()
  })

  await browser.loadFile(join(here, 'chrome', 'titlebar.html'))
  await contentView.webContents.loadURL(origin)
  await refreshTheme()
  await syncThemeFromPage()
  layout()
  themeTimer = setInterval(() => void syncThemeFromPage(), 2_000)
  themeTimer.unref()
}

function ensureLog() {
  if (log) return log
  log = createWriteStream(join(logsDir, 'desktop-server.log'), { flags: 'a' })
  log.on('error', err => console.error('Desktop log:', err.message))
  return log
}

function watchSidecarClosed(generation, instance) {
  void instance.closed.then(() => {
    if (stopping || generation !== sidecarGeneration) return
    sidecar = undefined
    setServiceState('offline')
    console.error('Desktop server supervisor stopped')
    if (splashWindow) {
      setSplashError(new Error('本机服务在初始化后意外停止。'))
      return
    }
    void showMessageBox({
      type: 'error',
      title: '本机服务已停止',
      message: '本地服务意外退出。',
      detail: '可以重启本地服务，或退出应用。数据已保存在本机。',
      buttons: ['重启本地服务', '退出应用'],
      defaultId: 0,
      cancelId: 1,
    }).then((choice) => {
      if (choice.response === 0) void restartBackend({ confirm: false })
      else quit()
    })
  })
}

async function open() {
  ensureLog()
  resetSplashState()
  try {
    setBootStage('prepare')
    sidecarGeneration += 1
    const generation = sidecarGeneration
    sidecar = await startSidecar({
      node,
      backend,
      home,
      log,
      onStage: (stage) => {
        if (!stopping && generation === sidecarGeneration) setBootStage(stage)
      },
    })
    if (stopping) return
    watchSidecarClosed(generation, sidecar)
    setServiceState('online')
    setBootStage('workshop')
    await createShell(sidecar.origin)
    if (stopping) return
    await revealMain()
  }
  catch (err) {
    lastStartupError = String(err?.message || err)
    console.error(err)
    try {
      await sidecar?.stop()
    }
    catch (stopError) {
      console.error(stopError)
    }
    sidecar = undefined
    if (shell && !shell.isDestroyed()) shell.destroy()
    setSplashError(err)
    throw err
  }
}

async function retryStartup() {
  if (stopping || restarting) return
  restarting = true
  try {
    await startup?.catch(() => {})
    if (sidecar) {
      const previous = sidecar
      sidecar = undefined
      sidecarGeneration += 1
      await previous.stop().catch(() => {})
    }
    if (shell && !shell.isDestroyed()) shell.destroy()
    resetSplashState()
    sendSplashState()
    startup = open()
    await startup.catch(() => {})
  }
  finally {
    restarting = false
  }
}

async function restartBackend({ confirm = true } = {}) {
  if (restarting || stopping) return
  if (confirm) {
    const choice = await showMessageBox({
      type: 'question',
      title: '重启本地服务',
      message: '重启本机服务会短暂中断当前任务，确定继续？',
      detail: 'Channel、Session 与已保存的数据不会丢失。',
      buttons: ['重启服务', '取消'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice.response !== 0) return
  }
  restarting = true
  const previous = sidecar
  sidecarGeneration += 1
  setServiceState('connecting')
  try {
    if (previous) await previous.stop()
    sidecar = undefined
    ensureLog()
    const next = await startSidecar({ node, backend, home, log })
    if (stopping) {
      await next.stop()
      return
    }
    sidecar = next
    watchSidecarClosed(sidecarGeneration, next)
    if (contentView && !contentView.webContents.isDestroyed()) await contentView.webContents.loadURL(next.origin)
    setServiceState('online')
    statusPhase = shell?.isVisible() ? 'ready' : 'hidden'
    writeStatus()
    refreshTray()
    notify('本机服务已重启', `监听 127.0.0.1:${next.port}`)
  }
  catch (err) {
    console.error(err)
    sidecar = undefined
    setServiceState('offline')
    await showMessageBox({
      type: 'error',
      title: '重启失败',
      message: '本地服务未能重新启动。',
      detail: `${err.message}\n日志目录：${logsDir}`,
      buttons: ['确定'],
    })
  }
  finally {
    restarting = false
    writeStatus()
    refreshTray()
  }
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    showMain()
  })
  app.on('activate', () => showMain())
  app.on('window-all-closed', quit)
  app.on('before-quit', (event) => {
    if (allowQuit) return
    event.preventDefault()
    quit()
  })
  app.on('will-quit', () => {
    if (tray && !tray.isDestroyed()) tray.destroy()
    tray = undefined
  })
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    applyLoginItem()
    registerChromeIpc()
    registerSplashIpc()
    watchTheme()
    createTray()
    writeStatus()
    createSplash()
    if (stopping) return
    startup = open()
    void startup.catch(() => {
      // The splash already shows the error and offers retry/open-logs/quit.
    })
  })
}
