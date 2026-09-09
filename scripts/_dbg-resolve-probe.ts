/** resolveOnPath 探针:验证增强 PATH 下 cursor-agent 可解析 */
import { resolveOnPath } from '../server/services/workshop/agents/adapters/line-spawn'

for (const cmd of ['cursor-agent', 'gemini', 'goose', 'copilot', 'crush', 'qwen']) {
  console.log(`${cmd} => ${resolveOnPath(cmd) ?? 'NOT FOUND'}`)
}
