/**
 * 一次性检查:dcw_read 进入 hostToolsForRole 工具面(worker/lead)。
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/_dbg-dcw-read-toolface.ts
 */
import { hostToolsForRole } from '../server/services/workshop/agents/omp-agent'

for (const role of ['worker', 'lead'] as const) {
  const names = hostToolsForRole(role).map(t => t.name)
  const hit = names.includes('dcw_read')
  console.log(`${role}: dcw_read ${hit ? '在工具面' : '缺失!'}(${names.length} 个工具)`)
  if (role === 'worker' && !hit) process.exit(1)
}
console.log('TOOLFACE PASS')
