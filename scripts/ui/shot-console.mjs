/**
 * 控制台两页(workspace 多视图 + project 详情)定点截图 —— 布局改版前后对照用。
 *   AW_BASE=http://127.0.0.1:3002 node scripts/ui/shot-console.mjs --out .e2e-shots/gpt-baseline [--dark]
 *
 * 与 shots.mjs 的差异:ROUTES 不含动态路由(/workshop/w/:wsId、/projects/:id),
 * 这里先经 REST 取第一个 workspace / project 再进页面;每页等 ws 快照就绪再拍。
 */
import fs from 'node:fs'
import path from 'node:path'
import { launch, openPage, gotoReady } from './lib.mjs'

/** 控制台截图走 owner 账号(demo 数据都在 owner 名下;visual 账号看不到频道) */
async function ownerToken() {
  const res = await fetch(`${BASE}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }),
  })
  const json = await res.json().catch(() => null)
  return json?.data?.token ?? ''
}

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3021'
const OUT = arg('out', '.e2e-shots/console')
const DARK = argv.includes('--dark')
const WAIT = Number(arg('wait', 6000))
const VP = arg('vp', '1440x900')
const [WV, HV] = VP.split('x').map(Number)

async function firstId(kind, token) {
  const res = await fetch(`${BASE}/api/${kind === 'ws' ? 'workshop/workspaces' : 'workshop/projects'}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const json = await res.json().catch(() => null)
  const rows = json?.data?.items ?? json?.data ?? []
  const first = Array.isArray(rows)
    ? rows[0]
    : null
  return first?.id ?? null
}

fs.mkdirSync(OUT, { recursive: true })
const token = await ownerToken()
const browser = await launch({ width: WV, height: HV })
const wsId = await firstId('ws', token)
const projectId = await firstId('project', token)
console.log('wsId =', wsId, ' projectId =', projectId)

const targets = [{ file: 'projects-index', path: '/projects' }]
if (wsId) {
  targets.unshift(
    { file: 'ws-chat', path: `/workshop/w/${wsId}?view=chat` },
    { file: 'ws-sessions', path: `/workshop/w/${wsId}?view=sessions` },
    { file: 'ws-board', path: `/workshop/w/${wsId}?view=board` },
  )
}
if (projectId) targets.push({ file: 'project-detail', path: `/projects/${projectId}` })

for (const tgt of targets) {
  const page = await openPage(browser, { token, dark: DARK, width: WV, height: HV })
  try {
    await gotoReady(page, tgt.path, { wait: WAIT })
    await page.screenshot({ path: path.join(OUT, `${DARK ? 'dark' : 'light'}__${tgt.file}.png`) })
    console.log('saved', tgt.file)
  }
  catch (e) {
    console.error('FAIL', tgt.file, String(e?.message ?? e).slice(0, 160))
  }
  await page.close()
}
await browser.close()
