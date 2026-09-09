/**
 * goose 探针(node spawn 版:绕开 MSYS 环境变量路径转换伪影)。
 * 运行:ZHIPU_API_KEY=... node scripts/_dbg-goose-probe.mjs
 */
import { spawn } from 'node:child_process'

const key = process.env.ZHIPU_API_KEY
if (!key) throw new Error('export ZHIPU_API_KEY first')

const env = {
  ...process.env,
  GOOSE_MODE: 'auto',
  GOOSE_CONTEXT_STRATEGY: 'summarize',
  GOOSE_DISABLE_SESSION_NAMING: 'true',
  GOOSE_PROVIDER: 'openai',
  GOOSE_MODEL: 'glm-5.3-flash',
  OPENAI_API_KEY: key,
  OPENAI_HOST: 'https://open.bigmodel.cn',
  OPENAI_BASE_PATH: '/api/coding/paas/v4/chat/completions',
}
const child = spawn('goose', ['run', '--output-format', 'stream-json', '-t', 'reply with exactly: ok'], { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (d) => { out += d })
child.stderr.on('data', (d) => process.stderr.write(String(d)))
child.on('exit', (code) => {
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try { console.log(JSON.stringify(JSON.parse(t)).slice(0, 600)) } catch { console.log('[raw]', t.slice(0, 160)) }
  }
  console.log('exit', code)
  process.exit(0)
})
