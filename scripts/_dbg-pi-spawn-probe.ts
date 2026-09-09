/** pi spawn 短 prompt 复现(定位 cmd 包装问题) */
import { spawnLineProcess } from '../server/services/workshop/agents/adapters/line-spawn'

const key = process.env.ZHIPU_API_KEY ?? ''
const ext = 'D:/codes/ABO/AgentWorkShop/server/harness/pi-aw-tools.mjs'
const variants: Array<[string, string[]]> = [
  ['version', ['--version']],
  ['no-ext-no-key', ['-p', '--mode', 'json', '--provider', 'zhipu', '--model', 'glm-5.3-flash', 'reply with exactly: ok']],
  ['with-ext', ['-p', '--mode', 'json', '--provider', 'zhipu', '--model', 'glm-5.3-flash', '-e', ext, 'reply with exactly: ok']],
  ['with-key', ['-p', '--mode', 'json', '--provider', 'zhipu', '--model', 'glm-5.3-flash', '-e', ext, '--api-key', key, 'reply with exactly: ok']],
]
const which = process.argv[2] ?? 'version'
const [label, args] = variants.find(v => v[0] === which) ?? variants[0]!
console.log(`== variant: ${label} ==`)
const child = spawnLineProcess('pi', args, {
  cwd: process.cwd(),
  env: { AW_PI_TOOLS_FILE: 'D:/codes/ABO/AgentWorkShop/.AgentWorkShop/harness-config/pi/aw-tools-probe.json' },
})
child.stdin?.end()
let o = ''
let e = ''
child.stdout?.on('data', (d) => {
  o += d
})
child.stderr?.on('data', (d) => {
  e += d
})
child.on('exit', (c) => {
  console.log('exit', c)
  console.log('out-tail:', o.slice(-400))
  console.log('err:', e.slice(0, 400))
  process.exit(0)
})
