/** Capture frames of the animated scenario figure so the motion can be reviewed.
 *  Renders the HTML in screen media and screenshots the SVG at fixed times.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
let pw
try {
  pw = require('playwright')
}
catch {
  const p = process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/87287/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
  pw = require(p)
}

const NAME = 'fig11-agentteam-loop'
const browser = await pw.chromium.launch({ headless: true })
const page = await browser.newPage({
  viewport: { width: 1500, height: 760 },
  deviceScaleFactor: 1.6,
})
await page.goto(pathToFileURL(join(root, `${NAME}.html`)).href)
await page.emulateMedia({ media: 'screen' })
await page.evaluate(async () => {
  await document.fonts.ready
})

// The loop is 24 s. Sample once per beat so each step is visible somewhere.
const times = [0.5, 4.5, 8.5, 12.5, 16.5, 20.5]
for (const t of times) {
  await page.evaluate(async (ms) => {
    await new Promise(r => setTimeout(r, ms))
  }, 0)
  await page.evaluate((sec) => {
    for (const el of document.getAnimations()) {
      el.currentTime = sec * 1000
      el.pause()
    }
  }, t)
  await page.locator('svg').screenshot({ path: join(root, `${NAME}-frame-${String(t).replace('.', '_')}s.png`) })
  console.log('captured', t, 's')
}
await browser.close()
