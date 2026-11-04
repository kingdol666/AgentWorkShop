#!/usr/bin/env node
/**
 * Project 层 G0–G6 证据归档器（G6 收口）。
 *
 * 顺序执行全部门禁命令，把 退出码/耗时/输出尾部 写入
 * docs/audit/evidence/2026-11-03-project-layer/gates/<G>/evidence.md + gates/index.json。
 * 在合并后的 main 上执行一次即形成最终验收证据包。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EVID = join(REPO, 'docs/audit/evidence/2026-11-03-project-layer')
const GATES = join(EVID, 'gates')
mkdirSync(GATES, { recursive: true })

const runLog = join(GATES, 'run.log')
writeFileSync(runLog, `# G0-G6 evidence run @ ${new Date().toISOString()}\n`)

/** gate → 命令映射（gate 文件按序聚合对应命令的证据） */
const GATE_OF = {
  'npm run typecheck': ['G0'],
  'npm run lint': ['G0'],
  'npm run test:unit': ['G1', 'G2', 'G3', 'G4'],
  'npm run build': ['G5'],
  'node scripts/ui/projects-smoke.mjs': ['G5'],
  'node scripts/ui/projects-interactions.mjs': ['G5'],
  'node scripts/e2e-line-governance.mjs': ['G6'],
  'node scripts/e2e-project-line-acceptance.mjs': ['G6'],
  'node scripts/e2e-project-rollback.mjs': ['G6'],
}

const GATE_DESC = {
  G0: '基线：typecheck / lint',
  G1: 'Schema/迁移/Repo（unit 全量）',
  G2: '安全 P0（unit 含 project-security-p0；Mimosa 独立扫描未完成，不宣称安全审计通过）',
  G3: 'Project 核心/派发/leader 工具/建频道提案（unit 全量）',
  G4: '成果/审批/审计事务化/write_intent/line grant/MAST（unit 全量）',
  G5: '构建 + UI smoke(6) + 交互矩阵(20)',
  G6: 'Live 全量：产线治理 E2E + 项目生产业务 E2E + 回滚演练',
}

function run(cmd, timeoutMs = 3_600_000) {
  return new Promise((resolveRun) => {
    const started = Date.now()
    console.log(`\n===== ${cmd} =====`)
    const parts = cmd.split(' ')
    let file
    let args
    if (parts[0] === 'npm') {
      file = process.execPath
      args = [join(REPO, 'node_modules/npm/bin/npx-cli.js'), ...parts.slice(1)]
    }
    else {
      file = parts[0] === 'node' ? process.execPath : parts[0]
      args = parts.slice(1)
    }
    const child = spawn(file, args, { cwd: REPO, windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const capture = (chunk) => {
      const text = chunk.toString()
      tail = `${tail}${text}`.slice(-24_000)
      process.stdout.write(text)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolveRun({ cmd, code: code ?? -1, ms: Date.now() - started, tail })
    })
  })
}

const results = []
for (const cmd of Object.keys(GATE_OF)) {
  const r = await run(cmd)
  results.push(r)
  appendFileSync(runLog, `\n===== ${cmd}\nexit=${r.code} ms=${r.ms}\n`)
  for (const gate of GATE_OF[cmd]) {
    const dir = join(GATES, gate)
    mkdirSync(dir, { recursive: true })
    const status = r.code === 0 ? 'PASS' : 'FAIL'
    appendFileSync(
      join(dir, 'evidence.md'),
      `\n## \`${cmd}\` — ${status} (${Math.round(r.ms / 1000)}s, exit=${r.code})\n\n\`\`\`\n${r.tail.trim().slice(-4000)}\n\`\`\`\n`,
    )
  }
}

// 每个 gate 文件补头部（聚合说明 + 关联命令证据）
for (const [gate, desc] of Object.entries(GATE_DESC)) {
  const p = join(GATES, gate, 'evidence.md')
  const body = existsSync(p) ? readFileSync(p, 'utf8') : '(本 gate 无独立命令；由关联命令聚合)'
  writeFileSync(p, `# ${gate} — ${desc}\n\n> 生成时间：${new Date().toISOString()}\n${body}`)
}

const index = {
  generatedAt: new Date().toISOString(),
  commands: results.map(r => ({ cmd: r.cmd, exit: r.code, ms: r.ms, pass: r.code === 0 })),
  totalFail: results.filter(r => r.code !== 0).length,
}
writeFileSync(join(GATES, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
console.log(`\n=== GATES evidence: fail=${index.totalFail}/${results.length} → ${GATES} ===`)
process.exitCode = index.totalFail > 0 ? 1 : 0
