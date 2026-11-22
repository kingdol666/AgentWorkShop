import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

test('the back-to-main control targets the nav layout and is localized', () => {
  const back = read('app/components/AppBackToMain.vue')
  assert.match(back, /to="\/"/, 'must link to the dashboard (default layout with sidebar)')
  assert.match(back, /data-testid="back-to-main"/)
  assert.match(back, /\$t\('common\.backToMain'\)/)
  for (const locale of ['i18n/locales/zh-CN.ts', 'i18n/locales/en.ts']) {
    const text = read(locale)
    assert.match(text, /backToMain:/, `${locale} must define backToMain`)
    assert.match(text, /backToMainTip:/, `${locale} must define backToMainTip`)
  }
})

test('the full-screen digital-twin chrome renders the back-to-main control', () => {
  const townPage = read('app/pages/town.vue')
  assert.match(townPage, /layout: 'town'/, 'town must stay on its standalone layout')
  // Loading and "no channel" states render neither TownView nor TownTopNav — the
  // page itself must still offer a way back (the reported desktop dead end).
  assert.match(townPage, /<AppBackToMain\s+v-if="!authReady \|\| !hasChannels \|\| !focusedChannelId"/)
  const townView = read('app/components/workshop/town/TownView.vue')
  assert.match(townView, /<TownTopNav/)
  const topNav = read('app/components/workshop/town/components/TownTopNav.vue')
  assert.match(topNav, /<AppBackToMain\s*\/>/, 'TownTopNav must render AppBackToMain')
})

test('the bare console layout renders the back-to-main control in its topbar', () => {
  const topbar = read('app/components/workshop/console/Topbar.vue')
  assert.match(topbar, /<AppBackToMain\s*\/>/, 'console Topbar must render AppBackToMain')
})

test('standalone console pages with their own chrome keep links to nav pages', () => {
  const project = read('app/pages/projects/[id].vue')
  assert.match(project, /navigateTo\('\/projects'\)/, 'project page must return to the projects center')
  assert.match(project, /navigateTo\('\/workshop'\)/, 'project page must return to the agent workbench')
})
