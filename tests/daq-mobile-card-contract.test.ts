/**
 * 数采工作面契约(第二轮 E6/E7)。
 * 告警只允许一个确认面;390 档不得再渲染 1154px 宽表,改由只读节点卡承载。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const panel = readFileSync(join(ROOT, 'app/components/daq/DaqNodePanel.vue'), 'utf-8')
const mobile = readFileSync(join(ROOT, 'app/components/daq/DaqNodeMobileList.vue'), 'utf-8')
const css = readFileSync(join(ROOT, 'app/pages/daq/daq-page.css'), 'utf-8')

test('节点面板不再渲染第二份未确认报警卡', () => {
  assert.equal(panel.includes('alarm-panel'), false)
  assert.equal(panel.includes('\'ack\''), false)
  assert.match(panel, /DaqNodeMobileList/)
})

test('手机卡使用全量过滤结果,不复用桌面虚拟窗口', () => {
  assert.match(panel, /mobileNodes: DaqNodeLive\[\]/)
  assert.match(panel, /:nodes="mobileNodes"/)
  assert.equal(/:nodes="visibleNodes"/.test(panel), false)
})

test('手机节点卡提供只读读数与节点详情入口', () => {
  assert.match(mobile, /data-testid="daq-node-mobile-card"/)
  assert.match(mobile, /\/daq\/\$\{n\.id\}/)
  assert.match(mobile, /n\.value/)
  assert.match(mobile, /n\.unit/)
})

test('900 档隐藏桌面表、显示节点卡,筛选可折叠', () => {
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.daq-node-table \{ display: none; \}/)
  assert.match(css, /\.daq-node-mobile \{ display: block; \}/)
  assert.match(css, /\.flt-toggle/)
  assert.match(panel, /filtersOpen/)
})
