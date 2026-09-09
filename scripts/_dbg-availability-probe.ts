/** 可用性探测全览:模拟 GET /api/workshop/harnesses 的核心输出 */
import { checkHarnessAvailability } from '../server/services/workshop/agents/harness-availability'
import { harnessMetas } from '../server/services/workshop/agents/registry'

async function main(): Promise<void> {
  for (const m of harnessMetas()) {
    const a = await checkHarnessAvailability(m.id)
    console.log(`${a.id.padEnd(10)} available=${String(a.available).padEnd(5)} inprocess=${String(a.inprocess).padEnd(5)} path=${a.resolvedPath ?? a.error ?? '-'}`)
  }
}
void main()
