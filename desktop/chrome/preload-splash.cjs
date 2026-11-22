// Sandboxed preload for the boot splash. It exposes only the fixed splash
// surface; the renderer never receives ipcRenderer itself.
const { contextBridge, ipcRenderer } = require('electron')

// Keep in sync with contract.mjs (sandboxed preloads cannot import local ESM).
const CHANNELS = {
  action: 'aw-splash:action',
  hello: 'aw-splash:hello',
  state: 'aw-splash:state',
}

function subscribe(channel, callback) {
  const handler = (_event, payload) => {
    try {
      callback(payload)
    }
    catch {
      // A splash listener must never take down the boot window.
    }
  }
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('awSplash', {
  action: name => ipcRenderer.send(CHANNELS.action, name),
  hello: () => ipcRenderer.send(CHANNELS.hello),
  onState: callback => subscribe(CHANNELS.state, callback),
})
