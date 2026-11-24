import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  BOOT_STAGES,
  DEFAULT_SETTINGS,
  SPLASH_ACTIONS,
  SPLASH_CHANNELS,
  SPLASH_STEPS,
  bootStage,
  isSplashAction,
  normalizeSettings,
} from '../desktop/chrome/contract.mjs'
import { loadSettings, saveSettings } from '../desktop/chrome/settings.mjs'
import { buildTrayMenuModel } from '../desktop/chrome/tray-menu.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = path => readFileSync(join(root, path), 'utf8')

test('splash IPC only accepts the fixed retry/open-logs/quit actions', () => {
  assert.deepEqual([...SPLASH_ACTIONS], ['retry', 'open-logs', 'quit'])
  for (const action of SPLASH_ACTIONS) assert.equal(isSplashAction(action), true)
  for (const action of ['', 'reload', 'retry ', 'quit-all', undefined, null, 1]) {
    assert.equal(isSplashAction(action), false)
  }
  assert.equal(SPLASH_CHANNELS.state, 'aw-splash:state')
  assert.equal(SPLASH_CHANNELS.hello, 'aw-splash:hello')
  assert.equal(SPLASH_CHANNELS.action, 'aw-splash:action')
})

test('boot stages are ordered, monotonic and match the splash checklist', () => {
  assert.deepEqual(BOOT_STAGES.map(stage => stage.id), ['prepare', 'data', 'service', 'workshop', 'ready'])
  assert.deepEqual([...SPLASH_STEPS], ['prepare', 'data', 'service', 'workshop'])
  let previous = 0
  for (const stage of BOOT_STAGES) {
    assert.ok(stage.progress > previous, `${stage.id} progress must increase`)
    assert.ok(stage.title.length > 0)
    previous = stage.progress
  }
  assert.equal(BOOT_STAGES.at(-1)?.progress, 100)
  assert.equal(bootStage('service').id, 'service')
  assert.equal(bootStage('unknown').id, 'prepare')
})

test('settings normalization keeps the exact boolean surface and defaults', () => {
  assert.deepEqual(normalizeSettings(undefined), { ...DEFAULT_SETTINGS })
  assert.deepEqual(normalizeSettings({ closeToTray: false, launchAtLogin: true }), {
    ...DEFAULT_SETTINGS,
    closeToTray: false,
    launchAtLogin: true,
  })
  assert.deepEqual(normalizeSettings({
    closeToTray: 'yes',
    launchAtLogin: 1,
    startHidden: null,
    trayNotifications: false,
    autoCheckUpdates: false,
    privilegedMode: true,
  }), {
    ...DEFAULT_SETTINGS,
    trayNotifications: false,
    autoCheckUpdates: false,
  })
  assert.equal(DEFAULT_SETTINGS.closeToTray, true)
  assert.equal(DEFAULT_SETTINGS.startHidden, false)
})

test('settings round-trip atomically and corrupt files fall back to defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-desktop-settings-'))
  try {
    const file = join(dir, 'nested', 'settings.json')
    const saved = saveSettings(file, {
      ...DEFAULT_SETTINGS,
      closeToTray: false,
      launchAtLogin: true,
      privilegedMode: true,
    })
    assert.equal(Object.hasOwn(saved, 'privilegedMode'), false)
    assert.deepEqual(loadSettings(file), {
      ...DEFAULT_SETTINGS,
      closeToTray: false,
      launchAtLogin: true,
    })
    assert.match(readFileSync(file, 'utf8'), /\n$/)
    writeFileSync(file, '{ not valid json', 'utf8')
    assert.deepEqual(loadSettings(file), { ...DEFAULT_SETTINGS })
    assert.deepEqual(loadSettings(join(dir, 'missing.json')), { ...DEFAULT_SETTINGS })
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tray menu exposes service state, maintenance actions and settings', () => {
  const settings = normalizeSettings({ startHidden: true, trayNotifications: false })
  const model = buildTrayMenuModel({
    settings,
    service: 'online',
    port: 51234,
    version: '0.17.5',
    windowVisible: true,
    update: { status: 'idle', version: null, progress: 0 },
  })
  const ids = model.filter(item => item.id).map(item => item.id)
  assert.deepEqual(ids, [
    'open',
    'reload',
    'service-status',
    'restart-service',
    'open-update-center',
    'check-update',
    'open-home',
    'open-logs',
    'diagnostics',
    'settings',
    'quit',
  ])
  const status = model.find(item => item.id === 'service-status')
  assert.equal(status?.enabled, false)
  assert.match(status?.label ?? '', /运行中/)
  assert.match(status?.label ?? '', /127\.0\.0\.1:51234/)
  const settingsMenu = model.find(item => item.id === 'settings')
  assert.deepEqual(settingsMenu?.submenu?.map(item => item.id), [
    'setting:closeToTray',
    'setting:launchAtLogin',
    'setting:startHidden',
    'setting:trayNotifications',
    'setting:autoCheckUpdates',
  ])
  assert.equal(settingsMenu?.submenu?.find(item => item.id === 'setting:startHidden')?.checked, true)
  assert.equal(settingsMenu?.submenu?.find(item => item.id === 'setting:trayNotifications')?.checked, false)
  assert.match(model.find(item => item.id === 'quit')?.label ?? '', /0\.17\.5/)

  const hidden = buildTrayMenuModel({ settings, service: 'offline', port: null, version: '', windowVisible: false, update: { status: 'available', version: '0.17.6' } })
  assert.equal(hidden.find(item => item.id === 'open')?.label, '显示主窗口')
  assert.match(hidden.find(item => item.id === 'service-status')?.label ?? '', /已断开/)
  assert.match(hidden.find(item => item.id === 'check-update')?.label ?? '', /0\.17\.6/)
  assert.equal(hidden.find(item => item.id === 'reload')?.enabled, false)
  assert.equal(hidden.find(item => item.id === 'restart-service')?.enabled, false)
})

test('update center keeps active jobs cancellable without exposing normal operations', () => {
  const html = read('desktop/chrome/update-center.html')
  assert.match(html, /next\.busy === true/)
  assert.match(html, /const canPause = status === 'downloading'/)
  assert.match(html, /const canCancel = \['downloading', 'verifying'\]\.includes\(status\)/)
  assert.match(html, /!busy && \(status === 'paused' \|\| retryDownload\)/)
  assert.match(html, /settingsControls\.forEach\(control => \{ control\.disabled = busy \}\)/)
  assert.match(html, /const canDownload = !busy && \['available', 'paused'\]\.includes\(status\)/)
  assert.match(html, /status === 'ready'/)

  const busy = buildTrayMenuModel({
    settings: normalizeSettings({}),
    service: 'online',
    port: 51234,
    version: '0.17.5',
    windowVisible: true,
    update: { status: 'downloading', busy: true, progress: 20 },
  })
  assert.equal(busy.find(item => item.id === 'open-update-center')?.enabled, true)
  assert.equal(busy.find(item => item.id === 'check-update')?.enabled, false)
})

test('splash document is self-contained, accessible and reduced-motion aware', () => {
  const html = read('desktop/chrome/splash.html')
  assert.match(html, /Content-Security-Policy[^>]+default-src 'none'/)
  assert.match(html, /window\.awSplash/)
  for (const action of SPLASH_ACTIONS) assert.match(html, new RegExp(`data-action="${action}"`))
  for (const step of SPLASH_STEPS) assert.match(html, new RegExp(`data-step="${step}"`))
  assert.match(html, /role="progressbar"/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, /prefers-reduced-motion/)
  assert.match(html, /data-phase="prepare"/)
  assert.match(html, /data-leaving="false"/)
  assert.match(html, /id="failure"/)
  assert.match(html, /id="trace"|class="lines"/)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.doesNotMatch(html, /onclick=/i)
  assert.doesNotMatch(html, /<script[^>]+src=/i)
  assert.doesNotMatch(html, /<link[^>]+href=/i)
})

test('splash preload exposes only the fixed splash surface', () => {
  const preload = read('desktop/chrome/preload-splash.cjs')
  assert.match(preload, /contextBridge\.exposeInMainWorld\('awSplash'/)
  assert.match(preload, /ipcRenderer\.send\(CHANNELS\.action/)
  assert.match(preload, /onState:/)
  assert.doesNotMatch(preload, /exposeInMainWorld\('electron'/)
  for (const channel of Object.values(SPLASH_CHANNELS)) assert.match(preload, new RegExp(channel))
})

test('main process boots the splash before the backend and closes to the tray', () => {
  const main = read('desktop/main.mjs')
  assert.match(main, /import \{[^}]*Tray[^}]*nativeImage[^}]*Notification[^}]*\} from 'electron'/)
  assert.match(main, /createTray\(\)/)
  assert.match(main, /createSplash\(\)\s*\n\s*if \(stopping\) return\s*\n\s*startup = open\(\)/)
  assert.match(main, /browser\.on\('close', \(event\) => \{/)
  assert.match(main, /settings\.closeToTray/)
  assert.match(main, /hideToTray\(\)/)
  assert.match(main, /settings\.startHidden/)
  assert.match(main, /AppUserModelId|setAppUserModelId/)
  assert.match(main, /setLoginItemSettings/)
  assert.match(main, /saveSettings\(settingsFile/)
  assert.match(main, /desktop-status\.json/)
  assert.match(main, /trayCreated/)
  assert.match(main, /windowVisible/)
  assert.match(main, /MIN_SPLASH_MS/)
  assert.match(main, /setSplashError/)
  assert.match(main, /retryStartup/)
  assert.match(main, /AW_DESKTOP_TEST_AUTOQUIT_MS/)
  assert.match(main, /AW_DESKTOP_TEST_TRAY_MENU_MS/)
  assert.match(main, /bootStage: splashState\?\.phase/)
  assert.match(main, /event\.sender !== splashWindow\?\.webContents/)
  assert.match(main, /app\.on\('window-all-closed', quit\)/)
})

test('titlebar close label follows the close-to-tray preference', () => {
  const html = read('desktop/chrome/titlebar.html')
  assert.match(html, /api\.onPrefs/)
  assert.match(html, /关闭到托盘/)
  const preload = read('desktop/chrome/preload.cjs')
  assert.match(preload, /onPrefs:/)
})

test('sidecar reports real boot stages and the bound port', () => {
  const sidecar = read('desktop/sidecar.mjs')
  assert.match(sidecar, /onStage = \(\) => \{\}/)
  assert.match(sidecar, /stage\('data'\)/)
  assert.match(sidecar, /stage\('service'\)/)
  assert.match(sidecar, /port: binding\.port, pid: child\.pid/)
})

test('npm payload and installer file allowlist include the new desktop surface', () => {
  const pkg = JSON.parse(read('package.json'))
  for (const entry of [
    'desktop/chrome/settings.mjs',
    'desktop/chrome/tray-menu.mjs',
    'desktop/chrome/splash.html',
    'desktop/chrome/preload-splash.cjs',
  ]) {
    assert.ok(pkg.files.includes(entry), `missing npm file entry: ${entry}`)
  }
  const build = read('desktop/build.mjs')
  assert.match(build, /chrome\/\*\*\/\*/)
})
