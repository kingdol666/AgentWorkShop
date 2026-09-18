import puppeteer from 'puppeteer-core'
import { CHROME, sleep } from './lib.mjs'
import fs from 'node:fs'

fs.mkdirSync('.e2e-shots/admin', { recursive: true })
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--no-proxy-server'], defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 2 } })
const p = await b.newPage()
const errs = []
p.on('pageerror', e => errs.push(String(e.message).slice(0, 140)))
await p.goto('http://127.0.0.1:4010/', { waitUntil: 'networkidle0', timeout: 60000 })
await sleep(6000)
const info = await p.evaluate(() => ({ title: document.title, text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 260), nodes: document.querySelectorAll('*').length }))
console.log('sim UI:', JSON.stringify(info))
console.log('errs:', errs.length, errs.slice(0, 3))
await p.screenshot({ path: '.e2e-shots/admin/00-plc-simulator.png' })
await b.close()
