/**
 * s2-paper-consistency —— 论文-代码一致性核查（静态层）：
 * 论文（paper/tii）中声称的每一个常量/机制锚点，必须在源码中逐一找到。
 * 这是"论文真实性"的机器证据：任何一条找不到都意味着论文或代码有一方失真。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { result } from '../util.mjs'

const meta = { id: 's2-paper-consistency', title: '论文-代码常量一致性', tier: 'static', dims: ['D0', 'D2'], weight: 2 }

// 锚点清单：label / 相对文件 / 匹配模式 / 论文出处
const ANCHORS = [
  ['sweep 并发配额 64', 'server/services/workshop/daq/daq-controller.ts', /SWEEP_MAX_CONCURRENCY\s*=\s*64/, '§III-B2'],
  ['sweep 周期 250ms', 'server/services/workshop/daq/daq-controller.ts', /setInterval\([\s\S]{0,120}?250/, '§III-B2'],
  ['回退重检周期 30s', 'server/services/workshop/dcw/recipe-rollback-manager.ts', /RECHECK_MS\s*=\s*30_000/, '§IV-D'],
  ['自动回退链上限 K=2', 'server/services/workshop/dcw/recipe-rollback-manager.ts', /MAX_AUTO_ROLLBACKS\s*=\s*2/, '§IV-D / 不变式 I3'],
  ['越限判定阈值 B=3', 'server/services/workshop/dcw/recipe-rollback-manager.ts', /BREACH_THRESHOLD\s*=\s*3/, '§IV-D'],
  ['记忆 RRF k=60', 'server/services/workshop/runtime/memory.ts', /RRF_K\s*=\s*60/, '§V-A'],
  ['记忆 MMR λ=0.7', 'server/services/workshop/runtime/memory.ts', /MMR_LAMBDA\s*=\s*0\.7/, '§V-A'],
  ['记忆权重 0.5/0.3/0.2', 'server/services/workshop/runtime/memory.ts', /W_RELEVANCE\s*=\s*0\.5[\s\S]{0,120}W_IMPORTANCE\s*=\s*0\.2/, '§V-A 式(3)'],
  ['上下文压缩阈值 70%', 'app/config/schema.ts', /compact_threshold[\s\S]{0,120}\.default\(0\.7\)/, '§V-A'],
  ['记录过期接管 30min', 'app/config/schema.ts', /rollback_stale_ms[\s\S]{0,120}1_800_000/, '§IV-B'],
  ['WS 推送上限 60s', 'server/services/workshop/daq/daq-runtime.ts', /PUBLISH_INTERVAL_MAX\s*=\s*60_000/, '§III-B1'],
  ['报警滞回 2% 量程', 'server/services/workshop/daq/daq-node.ts', /\(this\.max - this\.min\)\s*\*\s*0\.02/, '§III-B3'],
  ['报警 warn 带 8% 量程', 'server/services/workshop/daq/daq-node.ts', /\(this\.max - this\.min\)\s*\*\s*0\.08/, '§III-B3'],
  ['去抖 3 连续帧', 'server/services/workshop/daq/daq-node.ts', /stateCandN/, '§III-B3'],
  ['写控账本条目类型', 'server/services/workshop/dcw/dcw-controller.ts', /DcwWriteHistoryEntry/, '§IV-B 阶段5'],
  ['回读死区公式', 'server/services/workshop/dcw/dcw-runtime.ts', /writeTolerance/, '§IV 式(2)'],
  ['AEP 协议版本 v1', 'shared/workshop-protocol.ts', /AEP_VERSION\s*=\s*1/, '§III-E'],
  ['调度空闲退避上限 8s', 'server/services/workshop/runtime/scheduler-loop.ts', /IDLE_TICK_CAP_MS\s*=\s*8000/, '§V-B'],
  ['数控网关扫描周期 500ms', 'server/services/workshop/dcw/dcw-controller.ts', /SWEEP_MS\s*=\s*500/, '§III'],
  ['停滞看门狗 300s', 'server/services/workshop/runtime/scheduler-loop.ts', /300_?000/, '§V-B'],
]

export default [{
  meta,
  async run(ctx) {
    const cache = new Map()
    const read = (rel) => {
      if (!cache.has(rel)) {
        try { cache.set(rel, readFileSync(join(ctx.REPO, rel), 'utf8')) } catch { cache.set(rel, '') }
      }
      return cache.get(rel)
    }
    const found = [], missing = []
    for (const [label, rel, re, ref] of ANCHORS) {
      (re.test(read(rel)) ? found : missing).push(`${label}（${rel} · 论文 ${ref}）`)
    }
    const score = found.length / ANCHORS.length
    return result(meta.id, meta, score === 1 ? 'pass' : score >= 0.85 ? 'warn' : 'fail', score,
      { anchors: ANCHORS.length, found: found.length, missing: missing.length },
      [...found.map(s => `✔ ${s}`), ...missing.map(s => `✘ 未找到: ${s}`)],
      score === 1 ? '论文全部常量锚点在源码中核实' : '存在论文-代码失真项，必须修复后再投稿')
  },
}]
