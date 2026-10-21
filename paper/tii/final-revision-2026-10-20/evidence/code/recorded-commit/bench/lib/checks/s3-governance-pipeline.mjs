/**
 * s3-governance-pipeline —— 治理写控管线结构核查（静态层）：
 * 论文 §IV/Algorithm 1 的六阶段在 dcw-controller.ts 中的真实存在性与顺序性：
 *   可用门 → 闭环护栏(beforeWrite) → 软联锁(配方窗) → 编码写入(executeWrite:
 *   inverseTransform→回读→账本) → 审计埋点(dcw.write.)
 * 顺序性是关键：不是"有这些词"，而是按论文声明的次序出现。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { result } from '../util.mjs'

const meta = { id: 's3-governance-pipeline', title: '治理管线阶段顺序锚定', tier: 'static', dims: ['D2', 'D7'], weight: 2 }

function orderedIndexes(src, startAt, markers) {
  const idx = []
  let pos = startAt
  for (const m of markers) {
    const i = src.indexOf(m, pos)
    if (i < 0) return { ok: false, idx, missingAt: m }
    idx.push(i); pos = i + m.length
  }
  return { ok: true, idx }
}

export default [{
  meta,
  async run(ctx) {
    const src = readFileSync(join(ctx.REPO, 'server', 'services', 'workshop', 'dcw', 'dcw-controller.ts'), 'utf8')
    const evidence = []
    let chainsOk = 0

    // 链 A：write() 编排排（write 定义之后）：可用门→护栏→分层联锁(assertWithinLimits,
    //   泛化自旧配方软联锁:节点安全量程∩参数基准∩产品限界∩配方窗口,顺序不变)→运行时写→闭环入册→审计
    const writeDef = src.indexOf('async write(')
    if (writeDef > 0) {
      const chainA = orderedIndexes(src, writeDef, ['beforeWrite', 'assertWithinLimits', 'rt.write(', 'afterWrite', 'dcw.write.'])
      if (chainA.ok) { chainsOk++; evidence.push(`✔ write() 编排链顺序成立: ${['beforeWrite(护栏)', 'assertWithinLimits(四层联锁)', 'rt.write(执行)', 'afterWrite(闭环入册)', 'dcw.write.(审计)'].join(' → ')}`) }
      else evidence.push(`✘ write() 编排链在「${chainA.missingAt}」处断开`)
    } else evidence.push('✘ 未定位到 write() 定义')

    // 链 B：executeWrite() 执行排（定义之后）
    const execDef = src.indexOf('executeWrite(')
    if (execDef > 0) {
      const chainB = orderedIndexes(src, execDef, ['inverseTransform', 'readback', 'DcwWriteHistoryEntry'])
      if (chainB.ok) { chainsOk++; evidence.push(`✔ executeWrite() 执行链顺序成立: ${['inverseTransform(编码)', 'readback(回读)', 'DcwWriteHistoryEntry(账本)'].join(' → ')}`) }
      else evidence.push(`✘ executeWrite() 执行链在「${chainB.missingAt}」处断开`)
    } else evidence.push('✘ 未定位到 executeWrite()')

    // 附加锚点：回读容差与单入口
    const rt = readFileSync(join(ctx.REPO, 'server', 'services', 'workshop', 'dcw', 'dcw-runtime.ts'), 'utf8')
    if (/writeTolerance/.test(rt)) evidence.push('✔ 回读死区 writeTolerance() 存在（论文式(2)）')

    const score = chainsOk / 2
    return result(meta.id, meta, score === 1 ? 'pass' : score > 0 ? 'warn' : 'fail', score,
      { chainsOk, chainTotal: 2 },
      evidence, score === 1 ? '治理管线六阶段结构与顺序核实（Algorithm 1 的源码对应物）' : '管线结构不完整，论文 §IV 声称受影响')
  },
}]
