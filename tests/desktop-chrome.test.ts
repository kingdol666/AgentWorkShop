import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CHROME_ACTIONS,
  CHROME_CHANNELS,
  TITLEBAR_HEIGHT,
  cleanPageTitle,
  isChromeAction,
  normalizeTheme,
} from '../desktop/chrome/contract.mjs'
import { desktopHome } from '../shared/config/home.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = path => readFileSync(join(root, path), 'utf8')

test('desktop shares the web/CLI home by default', () => {
  assert.equal(desktopHome({}), join(homedir(), '.AgentWorkShop'))
  assert.equal(desktopHome({ AW_HOME: 'D:/aw-home' }), resolve('D:/aw-home'))
  assert.equal(desktopHome({ AW_HOME: 'D:/aw-home', AW_DESKTOP_HOME: 'D:/desktop-home' }), resolve('D:/desktop-home'))
})

test('desktop chrome contract accepts only the three window actions', () => {
  assert.deepEqual([...CHROME_ACTIONS], ['minimize', 'toggle-maximize', 'close'])
  for (const action of CHROME_ACTIONS) assert.equal(isChromeAction(action), true)
  for (const action of ['', 'maximize', 'minimize ', 'close-all', undefined, null, 1]) {
    assert.equal(isChromeAction(action), false)
  }
  assert.equal(TITLEBAR_HEIGHT, 40)
  assert.equal(CHROME_CHANNELS.update, 'aw-chrome:update')
  assert.equal(CHROME_CHANNELS.updateState, 'aw-chrome:update-state')
})

test('page titles drop the product suffix and stay bounded', () => {
  assert.equal(cleanPageTitle('仪表盘 · AgentWorkShop'), '仪表盘')
  assert.equal(cleanPageTitle('AML 与孪生 - AgentWorkShop'), 'AML 与孪生')
  assert.equal(cleanPageTitle('  '), '')
  assert.equal(cleanPageTitle(undefined), '')
  assert.equal(cleanPageTitle('AgentWorkShop'), '')
  assert.equal(cleanPageTitle('x'.repeat(80)), `${'x'.repeat(47)}…`)
})

test('theme normalization defaults to dark', () => {
  assert.equal(normalizeTheme('light'), 'light')
  assert.equal(normalizeTheme('dark'), 'dark')
  assert.equal(normalizeTheme(undefined), 'dark')
  assert.equal(normalizeTheme('system'), 'dark')
})

test('titlebar markup exposes accessible, bounded window controls', () => {
  const html = read('desktop/chrome/titlebar.html')
  for (const action of CHROME_ACTIONS) assert.match(html, new RegExp(`data-action="${action}"`))
  for (const label of ['最小化', '最大化', '关闭到托盘']) assert.match(html, new RegExp(`aria-label="${label}"`))
  assert.match(html, /Content-Security-Policy[^>]+default-src 'none'/)
  assert.match(html, /-webkit-app-region: drag/)
  assert.match(html, /-webkit-app-region: no-drag/)
  assert.match(html, /window\.awChrome/)
  assert.match(html, /id="update"/)
  assert.match(html, /api\.updateAction\('activate'\)/)
  assert.match(html, /data-theme='light'/)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.doesNotMatch(html, /onclick=/i)
})

test('preload keeps the IPC surface on the shared channel contract', () => {
  const preload = read('desktop/chrome/preload.cjs')
  assert.match(preload, /contextBridge\.exposeInMainWorld\('awChrome'/)
  assert.match(preload, /ipcRenderer\.send\(CHANNELS\.action/)
  assert.match(preload, /updateAction:/)
  assert.match(preload, /onUpdate:/)
  assert.doesNotMatch(preload, /exposeInMainWorld\('electron'/)
  assert.doesNotMatch(preload, /nodeIntegration:\s*true/)
  for (const channel of Object.values(CHROME_CHANNELS)) assert.match(preload, new RegExp(channel))
})

test('main process uses a frameless window with a separate content view', () => {
  const main = read('desktop/main.mjs')
  assert.match(main, /BrowserWindow/)
  assert.match(main, /WebContentsView/)
  assert.match(main, /frame: false/)
  assert.match(main, /sandbox: true/)
  assert.match(main, /contextIsolation: true/)
  assert.match(main, /nodeIntegration: false/)
  assert.match(main, /TITLEBAR_HEIGHT/)
  assert.match(main, /join\(here, 'chrome', 'preload\.cjs'\)/)
  assert.match(main, /join\(here, 'chrome', 'titlebar\.html'\)/)
  assert.match(main, /join\(here, 'build', 'icon\.png'\)/)
  assert.match(main, /event\.sender !== shell\.webContents/)
  assert.match(main, /setWindowOpenHandler/)
  assert.match(main, /from '\.\/update\.mjs'/)
  assert.match(main, /checkForUpdate/)
  assert.match(main, /CHROME_CHANNELS\.update/)
  assert.doesNotMatch(main, /BaseWindow/)
})

test('packaging ships the chrome assets and the app icon', () => {
  const build = read('desktop/build.mjs')
  assert.match(build, /chrome\/\*\*\/\*/)
  assert.match(build, /icon: 'build\/icon\.ico'/)
  assert.match(build, /'chrome'/)
  const pkg = JSON.parse(read('package.json'))
  for (const entry of [
    'desktop/chrome/titlebar.html',
    'desktop/chrome/preload.cjs',
    'desktop/chrome/contract.mjs',
    'desktop/update.mjs',
    'desktop/build/icon.png',
    'desktop/build/icon.ico',
  ]) {
    assert.ok(pkg.files.includes(entry), `missing npm file entry: ${entry}`)
  }
  assert.ok(statSync(join(root, 'desktop/build/icon.png')).size > 1000)
  const ico = readFileSync(join(root, 'desktop/build/icon.ico'))
  assert.equal(ico.readUInt16LE(0), 0)
  assert.equal(ico.readUInt16LE(2), 1)
  assert.ok(ico.readUInt16LE(4) >= 6)
  const png = readFileSync(join(root, 'desktop/build/icon.png'))
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
})
