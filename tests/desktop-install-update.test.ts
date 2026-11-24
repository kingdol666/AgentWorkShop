import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { INSTALL_CONFIRMATION, INSTALL_HELPER_SCRIPT, runConfirmedInstall } from '../desktop/install-update.mjs'
import { isDesktopPageSender, isUpdateCenterAction, normalizeManualProxy, normalizeSettings } from '../desktop/chrome/contract.mjs'

const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8')

test('closing or deferring the native confirmation cannot verify, stop or launch', async () => {
  assert.equal(INSTALL_CONFIRMATION.defaultId, INSTALL_CONFIRMATION.cancelId)
  for (const choice of [undefined, { response: 1 }, { response: -1 }]) {
    const unexpected = () => assert.fail('no post-consent action may run')
    assert.equal(await runConfirmedInstall({ confirm: () => choice, verify: unexpected, stop: unexpected, launch: unexpected }), false)
  }
  assert.doesNotMatch(main, /AW_UPDATE_AUTOINSTALL/)
})

test('confirmed install verifies and stops in order; a failed step prevents execution', async () => {
  for (const failure of ['verify', 'stop', 'none']) {
    const calls: string[] = []
    const step = (name: string) => () => {
      calls.push(name)
      if (name === failure) throw new Error(name)
    }
    const run = runConfirmedInstall({ confirm: () => ({ response: 0 }), verify: step('verify'), stop: step('stop'), launch: step('launch') })
    if (failure === 'none') assert.equal(await run, true)
    else await assert.rejects(run, new RegExp(failure))
    assert.deepEqual(calls, failure === 'verify' ? ['verify'] : failure === 'stop' ? ['verify', 'stop'] : ['verify', 'stop', 'launch'])
  }
})

test('WSH waits for the owned parent process and fails closed before NSIS or restarting', () => {
  assert.match(INSTALL_HELPER_SCRIPT, /For attempt = 1 To 120/)
  assert.match(INSTALL_HELPER_SCRIPT, /Win32_Process WHERE ProcessId=/)
  assert.match(INSTALL_HELPER_SCRIPT, /If ownerCount <> 0 Then Finish "wait-failed", 1[\s\S]+exitCode = sh.Run/)
  assert.match(INSTALL_HELPER_SCRIPT, /If exitCode <> 0 Then Finish "installer-failed", 1[\s\S]+sh.Run.*AW_UPDATE_EXE/)
})

test('desktop settings preserve the old flags and only accept fixed system or direct mode', () => {
  assert.equal(normalizeSettings({ closeToTray: false }).closeToTray, false)
  assert.equal(normalizeSettings({}).updateProxyMode, 'system')
  assert.equal(normalizeSettings({ updateProxyMode: 'direct' }).updateProxyMode, 'direct')
  assert.equal(normalizeSettings({ updateProxyMode: 'https://example.invalid' }).updateProxyMode, 'system')
  assert.equal(isUpdateCenterAction('set-proxy', 'direct'), true)
  assert.equal(isUpdateCenterAction('set-proxy', { endpoint: 'http://example.invalid' }), false)
  assert.equal(isUpdateCenterAction('download', '/fake/file'), false)
  assert.equal(isUpdateCenterAction('set-auto-check', 'true'), false)
  assert.equal(isUpdateCenterAction('install', undefined), true)
})

test('desktop settings accept a bounded manual proxy without credentials or arbitrary paths', () => {
  assert.deepEqual(normalizeManualProxy({ protocol: 'socks5', host: '127.0.0.1', port: 1080 }), {
    protocol: 'socks5', host: '127.0.0.1', port: 1080,
  })
  assert.deepEqual(normalizeManualProxy({ protocol: 'http', host: 'user:pass@proxy', port: 8080 }), {
    protocol: 'http', host: '', port: 8080,
  })
  assert.equal(normalizeSettings({ updateProxyMode: 'manual', updateProxy: { protocol: 'http', host: 'proxy.local', port: 8080 } }).updateProxyMode, 'manual')
  assert.equal(isUpdateCenterAction('set-proxy', {
    mode: 'manual', config: { protocol: 'http', host: 'proxy.local', port: 8080 },
  }), true)
  assert.equal(isUpdateCenterAction('set-proxy', {
    mode: 'manual', config: { protocol: 'http', host: 'http://proxy.local/path', port: 8080 },
  }), false)
})

test('update IPC allows only the exact local top-level document', () => {
  const url = 'file:///app/chrome/update-center.html'
  const mainFrame = { url }
  const contents = { mainFrame }
  assert.equal(isDesktopPageSender({ sender: contents, senderFrame: mainFrame }, contents, url), true)
  assert.equal(isDesktopPageSender({ sender: contents, senderFrame: { url } }, contents, url), false)
  assert.equal(isDesktopPageSender({ sender: {}, senderFrame: mainFrame }, contents, url), false)
  mainFrame.url = 'https://example.invalid/'
  assert.equal(isDesktopPageSender({ sender: contents, senderFrame: mainFrame }, contents, url), false)
})
