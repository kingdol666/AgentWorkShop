import { app, BrowserWindow, WebContentsView, dialog, ipcMain, Menu, net, session, Tray, nativeImage, nativeTheme, Notification, shell as electronShell } from 'electron'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAppUrl, startSidecar } from './sidecar.mjs'
import { checkForUpdate, discardUpdate, downloadUpdate, inspectUpdate, probeUpdateConnection, verifyDownloadedUpdate, UPDATE_REPO } from './update.mjs'
import { createSystemUpdateTransport, manualProxyRules, pinnedFetch } from './update-network.mjs'
import { INSTALL_CONFIRMATION, launchInstallHelper, readInstallResult, runConfirmedInstall } from './install-update.mjs'
import {
  CHROME_CHANNELS,
  UPDATE_CENTER_CHANNELS,
  SPLASH_CHANNELS,
  TITLEBAR_HEIGHT,
  bootStage,
  cleanPageTitle,
  isChromeAction,
  isDesktopPageSender,
  isSplashAction,
  isUpdateCenterAction,
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
const updatesDir = join(profile, 'updates')
const titlebarFile = join(here, 'chrome', 'titlebar.html')
const updateCenterFile = join(here, 'chrome', 'update-center.html')
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
let webBrandVisible = true
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
let updateJob = null
let updateCenter
let systemUpdateTransport
let proxySettingError = null
let updateProbe = { status: 'idle', route: 'unknown' }
let installNotice = null
let updateState = { status: 'idle', version: null, progress: null, received: 0, total: null, speed: null, eta: null, error: null, errorStage: null, notice: null, notes: '' }

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
  sendUpdateState()
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

async function syncBrandFromPage() {
  const contents = contentView?.webContents
  if (!contents || contents.isDestroyed()) return
  try {
    const visible = await contents.executeJavaScript(`(() => {
      const nodes = document.querySelectorAll('[data-aw-shell-brand]')
      return [...nodes].some(node => {
        if (node.closest('[inert], [aria-hidden="true"]')) return false
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < innerWidth
          && rect.bottom > 0 && rect.top < innerHeight && getComputedStyle(node).visibility === 'visible'
      })
    })()`)
    if (contents !== contentView?.webContents || webBrandVisible === visible) return
    webBrandVisible = visible === true
    sendToChrome(CHROME_CHANNELS.brand, webBrandVisible)
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
  // Source-only display override; a packaged build always compares its real version.
  const test = app.isPackaged ? undefined : process.env.AW_UPDATE_TEST_VERSION?.trim()
  if (test && /^\d+\.\d+\.\d+$/.test(test)) return test
  // 源码直启(electron desktop/main.mjs)时 app.getVersion() 回退到 Electron 运行时自身版本
  // (如 45.4.1),不是应用版本 —— 源码模式必须以 backend package.json 为准;打包版才是真版本。
  if (app.isPackaged) return app.getVersion()
  try {
    return JSON.parse(readFileSync(join(backend, 'package.json'), 'utf8')).version || app.getVersion()
  }
  catch {
    return app.getVersion()
  }
}

function updateRepo() {
  if (app.isPackaged) return UPDATE_REPO
  return process.env.AW_UPDATE_REPO?.trim() || UPDATE_REPO
}

function writeStatus() {
  const diagnosticSettings = { ...settings }
  delete diagnosticSettings.updateProxy
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
    settings: diagnosticSettings,
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

function updatePayload() {
  return {
    ...updateState,
    notice: updateState.notice ?? installNotice,
    currentVersion: currentVersion(),
    proxyMode: settings.updateProxyMode,
    manualProxy: settings.updateProxy,
    proxySettingError,
    autoCheckUpdates: settings.autoCheckUpdates,
    probe: updateProbe,
    theme,
    canInstall: app.isPackaged && process.platform === 'win32',
    busy: Boolean(updateJob),
  }
}

function sendUpdateState() {
  sendToChrome(CHROME_CHANNELS.updateState, {
    status: updateState.status,
    version: updateState.version,
    progress: updateState.progress,
    error: updateState.error,
  })
  if (updateCenter && !updateCenter.isDestroyed()) {
    updateCenter.webContents.send(UPDATE_CENTER_CHANNELS.state, updatePayload())
  }
}

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch }
  sendUpdateState()
  if ('status' in patch) refreshTray()
}

function startUpdateJob(kind) {
  if (updateJob || stopping) return null
  const job = { kind, controller: new AbortController(), interruption: null }
  updateJob = job
  return job
}

function finishUpdateJob(job) {
  if (updateJob !== job) return
  updateJob = null
  sendUpdateState()
}

async function updateNetwork(signal) {
  const mode = settings.updateProxyMode
  const proxy = mode === 'manual' ? settings.updateProxy : null
  if (mode === 'direct') return { signal, fetchImpl: pinnedFetch, route: 'direct' }
  systemUpdateTransport ??= (async () => {
    const isolated = session.fromPartition('aw-updater-network', { cache: false })
    const proxyConfig = mode === 'manual'
      ? { mode: 'fixed_servers', proxyRules: manualProxyRules(proxy), proxyBypassRules: '' }
      : { mode: 'system' }
    await isolated.setProxy(proxyConfig)
    await isolated.closeAllConnections()
    const { fetchImpl } = createSystemUpdateTransport({ net, session: isolated })
    return {
      fetchImpl: mode === 'manual'
        ? async (url, init) => {
          const rule = await isolated.resolveProxy(url)
          const scheme = { http: 'PROXY', https: 'HTTPS', socks5: 'SOCKS5' }[proxy.protocol]
          const endpoint = proxyConfig.proxyRules.split('://')[1]
          if (rule.trim().toLowerCase() !== `${scheme} ${endpoint}`.toLowerCase()) {
            throw Object.assign(new Error('manual proxy route unavailable'), { code: 'ERR_UPDATE_PROXY_ROUTE' })
          }
          init.signal?.throwIfAborted()
          return fetchImpl(url, init)
        }
        : fetchImpl,
      resolveProxy: mode === 'system' ? url => isolated.resolveProxy(url) : null,
      route: mode === 'manual' ? 'manual' : 'system',
    }
  })().catch((err) => {
    systemUpdateTransport = undefined
    throw err
  })
  return { signal, ...await systemUpdateTransport }
}

function updateError(err, fallback) {
  const code = String(err?.code ?? err?.cause?.code ?? '')
  if (code === 'UPDATE_RATE_LIMITED') return 'GitHub 更新接口暂时限流，请稍后再试。系统代理线路未被切换。'
  if (/PROXY.*AUTH|407/.test(code)) return '系统代理需要认证，请检查 Windows 代理设置。'
  if (/PROXY|TUNNEL/.test(code)) return '无法通过代理访问更新服务，请检查代理设置。'
  if (err?.name === 'TimeoutError' || /TIMED?OUT|TIMEOUT/.test(code)) return '更新连接超时，可以重试或检查代理。'
  if (/ENOSPC/.test(code)) return '磁盘空间不足，请清理空间后重试。'
  if (/SHA[- ]?256|checksum/i.test(String(err?.message))) return '更新包完整性校验失败，未执行安装。'
  return fallback
}

const emptyTransfer = { progress: null, received: 0, total: null, speed: null, eta: null }

function restoredTransfer(saved) {
  if (saved.status === 'ready') {
    updateInstaller = saved
    return { status: 'ready', received: saved.bytes, total: saved.bytes, progress: 100 }
  }
  if (saved.status === 'paused') {
    return { status: 'paused', received: saved.received, total: saved.total ?? null,
      progress: saved.total ? Math.min(99, Math.floor(100 * saved.received / saved.total)) : null }
  }
  return { status: 'available' }
}

async function checkUpdate({ manual = false } = {}) {
  if (!manual && ['available', 'paused', 'ready', 'error'].includes(updateState.status) && updateRelease) return
  const job = startUpdateJob('check')
  if (!job) return
  const previous = updateState
  setUpdateState({ status: 'checking', error: null, errorStage: null, notice: null })
  try {
    const network = await updateNetwork(job.controller.signal)
    const result = await checkForUpdate({ currentVersion: currentVersion(), repo: updateRepo(), ...network })
    job.controller.signal.throwIfAborted()
    if (result.status === 'available') {
      const saved = await inspectUpdate(result.release, { dir: updatesDir, ...network })
      job.controller.signal.throwIfAborted()
      const newlyAvailable = updateRelease?.version !== result.release.version
      updateRelease = result.release
      updateInstaller = null
      setUpdateState({ ...emptyTransfer, version: result.release.version, notes: result.release.notes, ...restoredTransfer(saved) })
      if (!manual && newlyAvailable && saved.status !== 'ready') notify('发现新版本', `AgentWorkShop v${result.release.version} 可在桌面更新中心下载。`)
    }
    else {
      updateRelease = null
      updateInstaller = null
      setUpdateState({ ...emptyTransfer, status: 'current', version: null, notes: '' })
    }
  }
  catch (err) {
    if (!stopping) {
      // A failed metadata check must not hide a previously verified installer.
      setUpdateState({ ...previous, status: updateRelease ? previous.status : 'error', errorStage: 'check',
        error: updateError(err, '无法检查更新，请测试连接后重试。') })
    }
  }
  finally {
    finishUpdateJob(job)
  }
}

async function beginDownload() {
  if (!updateRelease || !['available', 'paused', 'error'].includes(updateState.status)) return
  const job = startUpdateJob('download')
  if (!job) return
  const release = updateRelease
  const began = Date.now()
  let last = began
  let lastBytes = updateState.received
  let speed = 0
  updateInstaller = null
  setUpdateState({ status: 'downloading', error: null, errorStage: null, notice: null, speed: null, eta: null })
  try {
    const network = await updateNetwork(job.controller.signal)
    const result = await downloadUpdate(release, {
      dir: updatesDir,
      ...network,
      onProgress: (received, total, detail) => {
        if (job.controller.signal.aborted) return
        const now = Date.now()
        const reset = received < lastBytes || detail?.restarted
        const elapsed = now - last
        if (!reset && elapsed < 250 && (!total || received !== total)) return
        const rate = elapsed > 0 ? Math.max(0, (received - lastBytes) * 1000 / elapsed) : 0
        speed = reset ? 0 : speed ? 0.75 * speed + 0.25 * rate : rate
        last = now
        lastBytes = received
        setUpdateState({ received, total: total || null, progress: total ? Math.min(99, Math.floor(received * 100 / total)) : null,
          speed: speed > 0 ? speed : null, eta: total && speed > 0 ? Math.max(0, (total - received) / speed) : null,
          ...(reset ? { notice: '服务器无法续传，已重新开始下载。' } : {}) })
      },
      onVerify: () => setUpdateState({ status: 'verifying', speed: null, eta: null }),
    })
    job.controller.signal.throwIfAborted()
    updateInstaller = result
    setUpdateState({ status: 'ready', received: result.bytes, total: result.bytes, progress: 100, speed: null, eta: null, notice: null })
  }
  catch (err) {
    if (job.interruption === 'cancel') {
      try {
        await discardUpdate(release, { dir: updatesDir })
        setUpdateState({ ...emptyTransfer, status: 'available', notice: '已取消下载。' })
      }
      catch {
        setUpdateState({ status: 'error', errorStage: 'download', error: '无法清理更新缓存，请重试。' })
      }
    }
    else if (!stopping) {
      const saved = await inspectUpdate(release, { dir: updatesDir }).catch(() => ({ status: 'none' }))
      const transfer = restoredTransfer(saved)
      if (job.interruption === 'pause') {
        setUpdateState({ ...emptyTransfer, ...transfer, notice: saved.status === 'none' ? '已暂停。此连接没有可续传的数据，下次将从头下载。' : '已暂停。' })
      }
      else {
        setUpdateState({ ...emptyTransfer, ...transfer, status: 'error', errorStage: 'download',
          error: updateError(err, '更新下载未完成，可以重试或测试连接。') })
      }
    }
  }
  finally {
    finishUpdateJob(job)
  }
}

async function interruptDownload(kind) {
  if (updateJob?.kind === 'download') {
    if (!updateJob.interruption) {
      updateJob.interruption = kind
      updateJob.controller.abort()
    }
    return
  }
  if (kind !== 'cancel' || !updateRelease || !['paused', 'error'].includes(updateState.status)) return
  const job = startUpdateJob('discard')
  if (!job) return
  sendUpdateState()
  try {
    await discardUpdate(updateRelease, { dir: updatesDir })
    setUpdateState({ ...emptyTransfer, status: 'available', notice: '已取消下载。', error: null, errorStage: null })
  }
  catch {
    setUpdateState({ status: 'error', errorStage: 'download', error: '无法清理更新缓存，请重试。' })
  }
  finally {
    finishUpdateJob(job)
  }
}

async function testUpdateConnection() {
  const job = startUpdateJob('probe')
  if (!job) return
  updateProbe = { status: 'testing', route: 'unknown' }
  sendUpdateState()
  try {
    const network = await updateNetwork(job.controller.signal)
    const routes = new Set()
    const { fetchImpl, resolveProxy } = network
    const probeFetch = resolveProxy
      ? async (url, options) => {
        const rule = await Promise.race([resolveProxy(url).catch(() => ''), wait(3_000, '', { ref: false })])
        for (const entry of rule.split(';').map(value => value.trim().toUpperCase())) {
          if (entry === 'DIRECT') routes.add('direct')
          else if (/^(?:PROXY|HTTPS?|SOCKS[45]?|QUIC)\s/.test(entry)) routes.add('proxy')
        }
        return fetchImpl(url, options)
      }
      : fetchImpl
    const result = await probeUpdateConnection({ repo: updateRepo(), ...network, fetchImpl: probeFetch })
    const route = routes.size > 1 ? 'mixed' : routes.values().next().value ?? network.route ?? 'unknown'
    updateProbe = { status: 'ok', route, elapsedMs: result.elapsedMs }
  }
  catch (err) {
    updateProbe = { status: 'error', route: 'unknown', error: updateError(err, '无法连接 GitHub 更新通道，请检查网络或代理。') }
  }
  finally {
    finishUpdateJob(job)
  }
}

async function installUpdate() {
  if (!app.isPackaged || process.platform !== 'win32' || updateState.status !== 'ready' || !updateInstaller || !updateRelease || restarting) return
  const job = startUpdateJob('install')
  if (!job) return
  sendUpdateState()
  let stage = 'confirm'
  let stopped = false
  try {
    const consent = {
      type: 'question',
      title: '安装更新',
      message: `安装 AgentWorkShop v${updateRelease.version} 并重启？`,
      detail: '安装会停止本机服务，可能中断正在执行的作业。请保存工作；也可以稍后再安装。',
      ...INSTALL_CONFIRMATION,
    }
    await runConfirmedInstall({
      confirm: () => updateCenter && !updateCenter.isDestroyed()
        ? dialog.showMessageBox(updateCenter, consent)
        : showMessageBox(consent),
      verify: async () => {
        stage = 'verify'
        if (stopping || restarting) throw new Error('Desktop is not ready for update')
        installNotice = null
        setUpdateState({ status: 'installing', error: null, errorStage: null, notice: null })
        await verifyDownloadedUpdate(updateRelease, updateInstaller, { signal: job.controller.signal })
      },
      stop: async () => {
        stage = 'stop'
        if (stopping || restarting) throw new Error('Desktop is not ready for update')
        const instance = sidecar
        if (instance) {
          sidecarGeneration++
          try {
            await instance.stop({ gracefulOnly: true })
          }
          catch (err) {
            watchSidecarClosed(sidecarGeneration, instance)
            throw err
          }
          sidecar = undefined
          stopped = true
        }
        setServiceState('offline')
        job.controller.signal.throwIfAborted()
      },
      launch: async () => {
        stage = 'launch'
        await launchInstallHelper({ profile, installer: updateInstaller.path, executable: process.execPath })
        quit()
      },
    })
  }
  catch {
    const error = stage === 'verify'
      ? '无法确认更新包的完整性，请重新下载。'
      : stage === 'stop'
        ? '本机服务未确认停止，更新包已保留，请稍后重试。'
        : '未能启动更新安装，请稍后重试。'
    if (stage === 'verify' && !stopping) {
      updateInstaller = null
      await discardUpdate(updateRelease, { dir: updatesDir }).catch(() => {})
      setUpdateState({ ...emptyTransfer, status: 'error', errorStage: 'download', error })
    }
    else if (!stopping) {
      setUpdateState({ status: 'ready', errorStage: 'install', error })
    }
  }
  finally {
    finishUpdateJob(job)
    if (stopped && !stopping) void restartBackend({ confirm: false })
  }
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
  sendUpdateState()
  refreshTray()
  writeStatus()
  const label = TRAY_SETTINGS.find(item => item.key === key)?.label ?? key
  notify('设置已更新', `${label}：${settings[key] ? '开启' : '关闭'}`)
}

function openUpdateCenter() {
  if (stopping) return
  if (updateCenter && !updateCenter.isDestroyed()) {
    updateCenter.show()
    updateCenter.focus()
    return
  }
  const browser = new BrowserWindow({
    title: 'AgentWorkShop · 桌面设置与更新',
    width: 870, height: 700, minWidth: 390, minHeight: 490,
    backgroundColor: theme === 'dark' ? '#070c14' : '#f5f5f5',
    show: false,
    autoHideMenuBar: true,
    icon: join(here, 'build', 'icon.png'),
    webPreferences: {
      preload: join(here, 'chrome', 'update-center-preload.cjs'),
      partition: 'aw-update-ui',
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, webviewTag: false, devTools: false,
    },
  })
  updateCenter = browser
  harden(browser.webContents, { chrome: true })
  browser.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  browser.webContents.session.setPermissionCheckHandler(() => false)
  browser.once('ready-to-show', () => {
    if (!stopping && !browser.isDestroyed()) browser.show()
  })
  browser.on('closed', () => {
    if (updateCenter === browser) updateCenter = undefined
  })
  void browser.loadFile(updateCenterFile).catch(() => {
    if (!browser.isDestroyed()) browser.destroy()
    notify('桌面更新', '无法打开更新界面。')
  })
}

function changeUpdateProxy(value) {
  if (updateJob) {
    sendUpdateState()
    return
  }
  const next = value === 'system' || value === 'direct'
    ? { ...settings, updateProxyMode: value }
    : { ...settings, updateProxyMode: 'manual', updateProxy: value.config }
  try {
    settings = saveSettings(settingsFile, next)
    updateProbe = { status: 'idle', route: 'unknown' }
    systemUpdateTransport = undefined
    proxySettingError = null
    sendUpdateState()
    writeStatus()
  }
  catch {
    proxySettingError = '桌面设置未保存，请检查本机目录权限。'
    sendUpdateState()
  }
}

function changeUpdateSetting(key, value) {
  try {
    settings = saveSettings(settingsFile, { ...settings, [key]: value })
    if (settings.autoCheckUpdates) scheduleUpdates()
    else stopUpdates()
    setUpdateState({ notice: null })
    writeStatus()
    refreshTray()
  }
  catch {
    setUpdateState({ notice: '桌面设置未保存，请检查本机目录权限。' })
  }
}

function handleUpdateCenterAction(action, value) {
  if (stopping) return
  if (!isUpdateCenterAction(action, value)) {
    if (action === 'set-proxy') {
      proxySettingError = '请输入有效的主机和端口，不要填入网址或凭据。'
      sendUpdateState()
    }
    return
  }
  switch (action) {
    case 'check':
      void checkUpdate({ manual: true })
      break
    case 'download':
      void beginDownload()
      break
    case 'pause':
      void interruptDownload('pause')
      break
    case 'cancel':
      void interruptDownload('cancel')
      break
    case 'install':
      void installUpdate()
      break
    case 'test-connection':
      void testUpdateConnection()
      break
    case 'set-proxy':
      changeUpdateProxy(value)
      break
    case 'set-auto-check':
      changeUpdateSetting('autoCheckUpdates', value)
      break
  }
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
    case 'open-update-center':
      openUpdateCenter()
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
    sendToChrome(CHROME_CHANNELS.brand, webBrandVisible)
    sendPrefs()
    sendUpdateState()
  })
  ipcMain.on(CHROME_CHANNELS.update, (event, action) => {
    if (action === 'open-center' && isDesktopPageSender(event, shell?.webContents, pathToFileURL(titlebarFile).href)) {
      openUpdateCenter()
    }
  })
  ipcMain.on(UPDATE_CENTER_CHANNELS.hello, (event) => {
    if (isDesktopPageSender(event, updateCenter?.webContents, pathToFileURL(updateCenterFile).href)) sendUpdateState()
  })
  ipcMain.on(UPDATE_CENTER_CHANNELS.action, (event, action, value) => {
    if (isDesktopPageSender(event, updateCenter?.webContents, pathToFileURL(updateCenterFile).href)) handleUpdateCenterAction(action, value)
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
  stopUpdates()
  updateJob?.controller.abort()
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
  void readInstallResult(profile).then((result) => {
    if (result && result !== 'installed' && !stopping) {
      installNotice = '上次更新未报告成功。请检查当前版本，必要时重新下载或安装。'
      sendUpdateState()
    }
  })
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
  contentView.webContents.on('did-finish-load', () => {
    void syncThemeFromPage()
    void syncBrandFromPage()
  })

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
    if (allowQuit) return
    event.preventDefault()
    if (settings.closeToTray) hideToTray()
    else quit()
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
    webBrandVisible = true
    writeStatus()
    refreshTray()
  })

  await browser.loadFile(join(here, 'chrome', 'titlebar.html'))
  await contentView.webContents.loadURL(origin)
  await refreshTheme()
  await syncThemeFromPage()
  await syncBrandFromPage()
  layout()
  themeTimer = setInterval(() => {
    void syncThemeFromPage()
    void syncBrandFromPage()
  }, 2_000)
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
  if (restarting || stopping || updateJob?.kind === 'install') return
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
  if (restarting || stopping || updateJob?.kind === 'install') return
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
