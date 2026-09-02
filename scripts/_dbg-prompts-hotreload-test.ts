/**
 * prompts 热重载 + 目录优先级实测(对真实 ~/.AgentWorkShop/prompts 操作,测完恢复)。
 * 用法:npx tsx --tsconfig .nuxt/tsconfig.shared.json scripts/_dbg-prompts-hotreload-test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const homeConfigRoot = join(homedir(), '.AgentWorkShop')
const homePrompts = join(homeConfigRoot, 'prompts')
const TARGET = 'mode-goal.md'
const MARKER = `HOTRELOAD-MARKER-${Date.now()}`
const targetFile = join(homePrompts, TARGET)

const proj = mkdtempSync(join(tmpdir(), 'aw-hr-proj-'))
mkdirSync(join(proj, '.AgentWorkShop', 'prompts'), { recursive: true })

const NAME = 'mode-goal' // renderPrompt 入参为 prompt 名(loader 内部拼 .md)

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const { promptsDir, renderPrompt } = await import('@/server/services/workshop/prompts/loader')
const bumpMtime = (file: string) => {
  const t = new Date(Date.now() + 5)
  utimesSync(file, t, t)
}

// ===== 场景 1:Home 兜底目录 + 修改即热重载 =====
console.log('━━━ 场景 1:~/.AgentWorkShop/prompts(Home 兜底)+ 修改即热重载 ━━━')
process.chdir(homedir())
const resolved1 = promptsDir()
check('解析到 Home prompts 目录', resolved1 === homePrompts, resolved1)
check('目标文件存在', existsSync(targetFile))

const original = readFileSync(targetFile, 'utf8')
try {
  const before = renderPrompt(NAME, {})
  writeFileSync(targetFile, original + '\n' + MARKER)
  bumpMtime(targetFile)
  const after = renderPrompt(NAME, {})
  check('修改后热重载(渲染含新标记,无需重启)', after.includes(MARKER) && before !== after,
    `before=${before.length}ch after=${after.length}ch`)
  writeFileSync(targetFile, original)
  bumpMtime(targetFile)
  const restored = renderPrompt(NAME, {})
  check('恢复原文件后渲染还原', restored === before)
}
finally {
  writeFileSync(targetFile, original)
}

// ===== 场景 2:项目内 ./.AgentWorkShop/prompts 优先 + 独立热重载 =====
console.log('━━━ 场景 2:项目内 ./.AgentWorkShop/prompts 优先 ━━━')
process.chdir(proj)
writeFileSync(join(proj, '.AgentWorkShop', 'prompts', TARGET), 'PROJECT-LOCAL GOAT PROMPT v1')
const resolved2 = promptsDir()
check('解析到项目内 prompts 目录', resolved2 === join(proj, '.AgentWorkShop', 'prompts'), resolved2)
const projV1 = renderPrompt(NAME, {})
check('渲染取自项目文件(而非 Home)', projV1.includes('PROJECT-LOCAL GOAT PROMPT v1'))
writeFileSync(join(proj, '.AgentWorkShop', 'prompts', TARGET), 'PROJECT-LOCAL GOAT PROMPT v2')
bumpMtime(join(proj, '.AgentWorkShop', 'prompts', TARGET))
const projV2 = renderPrompt(NAME, {})
check('项目文件修改同样热重载', projV2.includes('v2') && !projV2.includes('v1'))

// ===== 场景 3:双目录隔离(切回 Home 不受项目文件影响)=====
process.chdir(homedir())
const homeRender = renderPrompt(NAME, {})
check('切回 Home 目录渲染不受项目文件影响', !homeRender.includes('PROJECT-LOCAL'))

rmSync(proj, { recursive: true, force: true })
console.log(failures === 0 ? '\nHOTRELOAD + PRIORITY ALL PASS' : `\n${failures} FAILED`)
if (failures > 0) process.exit(1)
