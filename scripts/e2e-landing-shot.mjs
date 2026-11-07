import puppeteer from 'puppeteer-core'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVID = join(REPO, 'docs/audit/evidence/2026-11-07-e2e-landing')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({
  executablePath: process.env.AW_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files', '--force-color-profile=srgb'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 })
await page.goto(pathToFileURL(join(EVID, 'landing-page.html')).href, { waitUntil: 'domcontentloaded', timeout: 30000 })
await sleep(1500)
await page.screenshot({ path: join(EVID, 'landing-page-desktop.png') })
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
await sleep(1200)
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
console.log('mobile overflow:', overflow)
await page.screenshot({ path: join(EVID, 'landing-page-mobile.png') })
await browser.close()
console.log('landing shots done')
