// Shared, Electron-free contract between the desktop shell and its titlebar.
// Keeping the values here lets unit tests assert the IPC surface without
// importing electron (which cannot load outside the Electron runtime).

export const TITLEBAR_HEIGHT = 40

export const CHROME_ACTIONS = Object.freeze(['minimize', 'toggle-maximize', 'close'])

export const CHROME_CHANNELS = Object.freeze({
  action: 'aw-chrome:action',
  hello: 'aw-chrome:hello',
  state: 'aw-chrome:state',
  status: 'aw-chrome:status',
  theme: 'aw-chrome:theme',
  title: 'aw-chrome:title',
  update: 'aw-chrome:update',
  updateState: 'aw-chrome:update-state',
})

export const CHROME_THEMES = Object.freeze(['dark', 'light'])

/** True for the three window-control actions; everything else is ignored. */
export function isChromeAction(value) {
  return typeof value === 'string' && CHROME_ACTIONS.includes(value)
}

/** Normalize a document title for the rail: drop the product suffix, clamp length.
 *  A bare product title carries no page information, so it is treated as empty. */
export function cleanPageTitle(raw) {
  if (typeof raw !== 'string') return ''
  const title = raw.replace(/\s+[·|-]\s+AgentWorkShop\s*$/i, '').replace(/\s+/g, ' ').trim()
  if (!title || /^AgentWorkShop$/i.test(title)) return ''
  return title.length > 48 ? `${title.slice(0, 47)}…` : title
}

/** The app mirrors its theme into an `aw-theme` cookie; anything else means dark. */
export function normalizeTheme(value) {
  return value === 'light' ? 'light' : 'dark'
}
