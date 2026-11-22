// Sandboxed preload for the desktop title rail. Only the fixed channel
// surface is exposed; the renderer never receives ipcRenderer itself.
const { contextBridge, ipcRenderer } = require('electron')

// Keep in sync with contract.mjs (sandboxed preloads cannot import local ESM).
const CHANNELS = {
  action: 'aw-chrome:action',
  hello: 'aw-chrome:hello',
  state: 'aw-chrome:state',
  status: 'aw-chrome:status',
  theme: 'aw-chrome:theme',
  title: 'aw-chrome:title',
  update: 'aw-chrome:update',
  updateState: 'aw-chrome:update-state',
}

function subscribe(channel, callback) {
  const handler = (_event, payload) => {
    try {
      callback(payload)
    }
    catch {
      // A titlebar listener must never take down the window controls.
    }
  }
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('awChrome', {
  platform: process.platform,
  action: name => ipcRenderer.send(CHANNELS.action, name),
  hello: () => ipcRenderer.send(CHANNELS.hello),
  updateAction: name => ipcRenderer.send(CHANNELS.update, name),
  onState: callback => subscribe(CHANNELS.state, callback),
  onStatus: callback => subscribe(CHANNELS.status, callback),
  onTheme: callback => subscribe(CHANNELS.theme, callback),
  onTitle: callback => subscribe(CHANNELS.title, callback),
  onUpdate: callback => subscribe(CHANNELS.updateState, callback),
})
