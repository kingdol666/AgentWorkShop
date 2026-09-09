/** spawnLineProcess 直接探针:crush 短 prompt(定位 cmd 包装路径问题) */
import { spawnLineProcess } from '../server/services/workshop/agents/adapters/line-spawn'

const key = process.env.ZHIPU_API_KEY ?? ''
const child = spawnLineProcess('crush', ['run', '-q', '-m', 'zhipu/glm-5.3-flash', 'reply with exactly: ok'], {
  cwd: process.cwd(),
  env: { AW_AGENT_ID: 'probe', AW_AGENT_TOKEN: 'probe', AW_BASE_URL: 'http://127.0.0.1:59999', AW_CRUSH_API_KEY: key },
})
let out = ''
let err = ''
child.stdout?.on('data', (d) => {
  out += d
})
child.stderr?.on('data', (d) => {
  err += d
})
child.on('exit', (code) => {
  console.log('exit', code)
  console.log('stdout:', out.slice(0, 400))
  console.log('stderr:', err.slice(0, 400))
  process.exit(0)
})
