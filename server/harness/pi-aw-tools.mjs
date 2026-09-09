/**
 * AW AgentWorkShop — pi 扩展:把平台 host tools 注册为 pi 自定义工具。
 *
 * 由 PiAgentImpl 以 -e 加载;工具清单由 impl 每回合写入 AW_PI_TOOLS_FILE 指向的
 * JSON 文件(hostToolsForRole 同源),本扩展同步读取后逐个 registerTool;
 * execute 经平台 HTTP 回程(aw-mcp-bridge 同款协议,x-aw-agent-token 鉴权)。
 * 零依赖:仅 node 内置模块。
 */
import { readFileSync } from 'node:fs'

export default function (pi) {
  const file = process.env.AW_PI_TOOLS_FILE
  const base = process.env.AW_BASE_URL
  const agentId = process.env.AW_AGENT_ID
  const token = process.env.AW_AGENT_TOKEN
  if (!file || !base || !agentId) return
  let tools
  try {
    tools = JSON.parse(readFileSync(file, 'utf-8'))
  }
  catch {
    return
  }
  if (!Array.isArray(tools)) return
  for (const t of tools) {
    if (!t || typeof t.name !== 'string') continue
    pi.registerTool({
      name: t.name,
      label: t.label ?? t.name,
      description: t.description ?? '',
      // host-tools.json 的 parameters 即 JSON Schema 对象
      parameters: t.parameters ?? { type: 'object', properties: {} },
      async execute(_toolCallId, params) {
        try {
          const r = await fetch(`${base}/api/workshop/agent-tools/invoke`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-aw-agent-token': token ?? '' },
            body: JSON.stringify({ agentId, tool: t.name, args: params ?? {} }),
          })
          const j = await r.json().catch(() => ({}))
          const result = j?.data?.result
          const text = result?.text ?? (j?.message ? `错误: ${j.message}` : JSON.stringify(j).slice(0, 2000))
          return { content: [{ type: 'text', text }], details: {} }
        }
        catch (err) {
          return { content: [{ type: 'text', text: `工具调用失败: ${err instanceof Error ? err.message : String(err)}` }], details: {} }
        }
      },
    })
  }
}
