/**
 * line-spawn 聚焦探针:验证 codex(.cmd shim)经受控包装拉起并可 stdio 通信。
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/_dbg-line-spawn.ts
 */
import { spawnLineProcess } from '../server/services/workshop/agents/adapters/line-spawn'

async function main(): Promise<void> {
  console.log('── spawn codex --version(.cmd shim 经 cmd.exe 包装)──')
  const child = spawnLineProcess('codex', ['--version'], {})
  let out = ''
  child.stdout?.setEncoding('utf-8')
  child.stdout?.on('data', (d: string) => {
    out += d
  })
  const code = await new Promise<number | null>((resolve) => {
    child.on('exit', c => resolve(c))
    child.on('error', (e) => {
      console.log('spawn error:', e.message)
      resolve(-1)
    })
  })
  console.log('exit=', code, 'stdout=', out.trim())
  if (code !== 0 || !out.includes('codex')) {
    console.log('FAIL')
    process.exit(1)
  }
  console.log('PASS')
  process.exit(0)
}

void main()
