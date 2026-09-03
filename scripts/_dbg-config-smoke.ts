/**
 * 配置链冒烟:env(AW_* + 历史别名)覆盖 → config.yml → zod 默认。
 * 运行: AW_MEMORY_PRIMER_TOKENS=222 DAQ_FRAME_RETENTION_H=999 BACKUP_KEEP=3 \
 *       RETENTION_DISABLED=1 AWSHOP_LOG_LEVEL=debug npx tsx ... scripts/_dbg-config-smoke.ts
 */
import { loadConfig } from '../app/config'

const c = loadConfig()
const rows: Array<[string, unknown, unknown]> = [
  ['memory.primer_tokens (env 222)', c.memory.primer_tokens, 222],
  ['memory.inject_total (默认 500)', c.memory.inject_total, 500],
  ['daq.frameRetentionH (别名 999)', c.daq.frameRetentionH, 999],
  ['backup.keep (env AW_BACKUP_KEEP 3)', c.backup.keep, 3],
  ['retention.disabled (别名 RETENTION_DISABLED=1 → true)', c.retention.disabled, true],
  ['log.level (别名 AWSHOP_LOG_LEVEL=debug)', c.log.level, 'debug'],
  ['omp.compact_threshold (默认 0.7)', c.omp.compact_threshold, 0.7],
  ['security.hitl_timeout_ms (默认 180000)', c.security.hitl_timeout_ms, 180000],
  ['dcw.rollback_cooldown_ms (默认 300000)', c.dcw.rollback_cooldown_ms, 300000],
  ['workshop.idle_grace_ms (默认 120000)', c.workshop.idle_grace_ms, 120000],
  ['retention.audit_days (默认 90)', c.retention.audit_days, 90],
]
let failed = 0
for (const [name, got, want] of rows) {
  const ok = got === want
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} → ${String(got)}`)
  if (!ok) failed++
}
process.exit(failed === 0 ? 0 : 1)
