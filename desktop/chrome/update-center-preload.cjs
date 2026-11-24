// Sandboxed preload for the local desktop update center. The renderer gets only
// the small command/state surface it needs; ipcRenderer never crosses the bridge.
const { contextBridge, ipcRenderer } = require('electron')

const CHANNELS = Object.freeze({
  action: 'aw-update-center:action',
  hello: 'aw-update-center:hello',
  state: 'aw-update-center:state',
})

const ACTIONS = new Set([
  'check',
  'download',
  'pause',
  'cancel',
  'install',
  'test-connection',
])

function validManualProxy(value) {
  if (!value || value.mode !== 'manual' || !value.config || typeof value.config !== 'object') return false
  const { protocol, host, port } = value.config
  return ['http', 'https', 'socks5'].includes(protocol)
    && typeof host === 'string' && host.length > 0 && host.length <= 253
    && /^[a-z\d.:[\]-]+$/i.test(host)
    && Number.isInteger(port) && port >= 1 && port <= 65535
}

function validAction(action, value) {
  if (action === 'set-proxy') return value === 'system' || value === 'direct' || validManualProxy(value)
  if (action === 'set-auto-check') return typeof value === 'boolean'
  return ACTIONS.has(action) && value === undefined
}

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {}
  const handler = (_event, payload) => {
    try {
      callback(payload)
    }
    catch {
      // A renderer listener must never take down the update center.
    }
  }
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('awUpdateCenter', {
  action: (action, value) => {
    if (!validAction(action, value)) return false
    ipcRenderer.send(CHANNELS.action, action, value)
    return true
  },
  hello: () => ipcRenderer.send(CHANNELS.hello),
  onState: callback => subscribe(CHANNELS.state, callback),
})
