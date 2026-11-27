/** Exercise the existing memory API through its rendered UI. Requires an isolated instance and fixture title. */
import assert from 'node:assert/strict'
import { gotoReady, launch, openPage } from './lib.mjs'

const token = process.env.AW_TOKEN
const title = process.env.AW_UI_MEMORY_TITLE
if (!token || !title) throw new Error('Set AW_TOKEN and AW_UI_MEMORY_TITLE for an isolated acceptance instance')

const browser = await launch({ width: 390, height: 844 })
try {
  const page = await openPage(browser, { token, width: 390, height: 844, deviceScaleFactor: 1 })
  const writes = []
  page.on('request', (request) => {
    if (!['GET', 'HEAD'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/workshop/memory/')) {
      writes.push(request.method())
    }
  })
  await gotoReady(page, '/memory')
  assert.equal(new URL(page.url()).pathname, '/memory')
  const input = '.aw-memory-page .search-input input, .aw-memory-page input.search-input'
  await page.waitForSelector(input, { visible: true })
  await page.type(input, title)
  await page.click('[data-testid="memory-search"]')
  const record = await page.waitForFunction((value) => {
    return Array.from(document.querySelectorAll('.memory-list .record-link')).find((button) => {
      if (button.textContent.trim() !== value) return false
      const title = button.querySelector('.memory-list-title')
      const rect = button.getBoundingClientRect()
      return title && title.scrollWidth <= title.clientWidth + 1 && rect.width > 0
        && rect.left >= 0 && rect.right <= innerWidth + 1
    })
  }, {}, title)
  await record.asElement().click()
  await page.waitForSelector('.ant-drawer-open .content', { visible: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
  assert.equal(await page.$eval('.ant-drawer-open .ant-drawer-content-wrapper', el => el.getBoundingClientRect().width <= innerWidth + 1), true)

  async function clickInView(selector) {
    await page.waitForSelector(selector, { visible: true })
    await page.$eval(selector, el => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
    const target = await page.waitForFunction((query) => {
      for (const button of document.querySelectorAll(query)) {
        const r = button.getBoundingClientRect()
        const x = r.left + r.width / 2
        const y = r.top + r.height / 2
        if (r.width > 0 && r.height > 0 && button.contains(document.elementFromPoint(x, y))) return { x, y }
      }
      return null
    }, {}, selector)
    const { x, y } = await target.jsonValue()
    await page.mouse.click(x, y)
  }

  await clickInView('.ant-drawer-open button.ant-btn-dangerous')
  await clickInView('.ant-popover:not(.ant-popover-hidden) .ant-popconfirm-buttons button:not(.ant-btn-primary)')
  await page.waitForSelector('.ant-popover:not(.ant-popover-hidden) .ant-popconfirm-buttons', { hidden: true })
  assert.deepEqual(writes, [], 'Cancel must not write')
  assert.equal(await page.$eval('.ant-drawer-open .ant-drawer-title', el => el.textContent.trim()), title)
  console.log('PASS: memory search, real detail, narrow drawer, cancel sends no writes')
}
finally {
  await browser.close()
}
