import { app, BrowserWindow, dialog } from 'electron'
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAppUrl, startSidecar } from './sidecar.mjs'

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

let window
let startup
let sidecar
let stopping = false
let allowQuit = false
let log

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

async function open() {
  const logs = join(home, 'logs')
  mkdirSync(logs, { recursive: true })
  log = createWriteStream(join(logs, 'desktop-server.log'), { flags: 'a' })
  log.on('error', err => console.error('Desktop log:', err.message))
  sidecar = await startSidecar({ node, backend, home, log })
  if (stopping) return
  const browser = new BrowserWindow({
    width: 1440,
    height: 950,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'AgentWorkShop',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false },
  })
  window = browser
  const contents = browser.webContents
  const restrict = (event, url) => {
    if (!isAppUrl(url, sidecar.origin)) event.preventDefault()
  }
  contents.on('will-navigate', restrict)
  contents.on('will-redirect', restrict)
  contents.on('will-attach-webview', event => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  contents.session.setPermissionCheckHandler(() => false)
  await contents.session.setProxy({ mode: 'direct' })
  browser.once('ready-to-show', () => browser.show())
  browser.once('closed', () => {
    window = undefined
  })
  void sidecar.closed.then(() => {
    if (stopping) return
    window?.destroy()
    console.error('Desktop server supervisor stopped')
    quit()
  })
  await browser.loadURL(sidecar.origin)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.on('window-all-closed', quit)
  app.on('before-quit', (event) => {
    if (allowQuit) return
    event.preventDefault()
    quit()
  })
  void app.whenReady().then(() => {
    if (stopping) return
    startup = open()
    void startup.catch((err) => {
      console.error(err)
      if (!stopping) dialog.showErrorBox('AgentWorkShop', `无法启动桌面服务。\n${err.message}\n日志目录：${join(home, 'logs')}`)
      quit()
    })
  })
}
