/**
 * 插件扩展验证 C(omp 工具注入,协议层真机):
 * ①插件工具并入角色工具面 → ②真实 omp --mode rpc 子进程接受含插件工具的
 *   set_host_tools(协议层注入生效) → ③handleHostTool 分发到插件 handler。
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/_dbg-plugin-tools-inject.ts
 */
import { spawn } from 'node:child_process'
import { registerPluginTool, listPluginTools } from '../server/services/workshop/agents/plugin-tools'
import { hostToolsForRole, OmpRpcAgentImpl } from '../server/services/workshop/agents/omp-agent'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// ===== ① 插件工具注册(模拟插件 setup 的注册调用)=====
registerPluginTool('live-verify', {
  name: 'plugin_verify_probe',
  description: '插件验证探针:返回插件链路状态',
  parameters: { type: 'object', properties: { ping: { type: 'string' } } },
  handler: args => ({ text: `probe-ok:${String(args.ping ?? '')}` }),
})
check('插件工具注册进注册表', listPluginTools().has('plugin_verify_probe'))
check('hostToolsForRole(worker) 含插件工具', hostToolsForRole('worker').some(t => t.name === 'plugin_verify_probe'))

// ===== ② 真实 omp 子进程:set_host_tools 含插件工具 → 协议接受 =====
console.log('\n--- 真实 omp 子进程注入 ---')
{
  const tools = hostToolsForRole('worker')
  const child = spawn('omp', ['--mode', 'rpc'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buf = ''
  let sent = false
  let accepted: unknown = null
  const result = await new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 30_000)
    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        try {
          const frame = JSON.parse(line)
          if (frame.type === 'ready' && !sent) {
            sent = true
            // 注入含插件工具的工具面(与 omp-agent ensureClient 同一命令)
            child.stdin!.write(`${JSON.stringify({ id: 'req_tools', type: 'set_host_tools', tools })}\n`)
          }
          else if (frame.type === 'response' && frame.id === 'req_tools') {
            clearTimeout(timer)
            accepted = frame
            resolve(frame)
          }
        }
        catch { /* 非 JSON 行忽略 */ }
      }
    })
    child.on('exit', () => resolve(accepted ?? 'exit'))
  })
  child.kill()
  const resp = accepted as { success?: boolean } | null
  check('真实 omp 接受含插件工具的 set_host_tools', !!resp && resp.success === true, JSON.stringify(accepted).slice(0, 120))
  void result
}

// ===== ③ handleHostTool 分发(真实 OmpRpcAgentImpl 实例)=====
console.log('\n--- 分发执行 ---')
{
  const impl = new OmpRpcAgentImpl({ agentId: 'ag-verify', name: '验证员', role: 'worker', channelId: 'ch-v' })
  const handle = (impl as unknown as Record<string, (req: unknown) => Promise<{ text: string, isError?: boolean }>>).handleHostTool.bind(impl)
  const out = await handle({ toolName: 'plugin_verify_probe', toolCallId: 't1', arguments: { ping: 'e2e' } })
  check('handleHostTool 分发到插件 handler', out.text === 'probe-ok:e2e', out.text)
  await impl.dispose()
}

console.log(failures === 0 ? '\nTOOLS INJECT ALL PASS' : `\nTOOLS INJECT FAILED(${failures})`)
process.exit(failures === 0 ? 0 : 1)
