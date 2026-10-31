/**
 * 写后验证器(ACK 鉴定层,2026-10-08 生产化)—— recipe 整批下发的"参数真实生效"鉴定。
 *
 * 背景(用户铁律):下发后要观察**所有写控节点**是否真正返回 ack/response;没有回执或
 * 回执错误必须如实反馈给 Agent 并记 error。驱动层 ack 如实分级后(readback-verified /
 * transport-ack / unverified),本模块负责把"仅链路受理"的写补验到"设备证实":
 *   ① 命令失败(!ok)→ failed,不补验;
 *   ② 驱动内已回读一致(readback-verified)→ 直接 verified;
 *   ③ 其余(transport-ack/unverified)→ 经 readNow 独立回读,容差内 = verified;
 *      最多 VERIFY_ATTEMPTS 次、间隔 VERIFY_INTERVAL_MS;驱动不支持读 → 立即 unverified。
 *
 * 读回比对用**工程量目标值**(eng)与节点写容差(writeTolerance 同口径)——与驱动内
 * readbackAck 同一判据,但读回值已经由 executeRead 换算回物理量(applyTransform)。
 */
import type { WriteAckLevel, WriteVerifyOutcome } from '../../../../../shared/dcw-protocol'
import type { DcwNode } from '../dcw-node'

/** 补验次数与间隔(默认 3 次 × 2s;env AW_WRITE_VERIFY_* 可调,≤0 关闭补验直判 unverified) */
const VERIFY_ATTEMPTS = Math.max(1, Number(process.env.AW_WRITE_VERIFY_ATTEMPTS) || 3)
const VERIFY_INTERVAL_MS = Math.max(0, Number(process.env.AW_WRITE_VERIFY_INTERVAL_MS) || 2_000)

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 批次结果行需要的最小读能力面(controller.readNow 的结构子集,便于单测注入) */
export interface WriteVerifyReader {
  readNow(id: string): Promise<{ ok: boolean, value: number | null, message: string }>
}

/**
 * 对一次写结果做 ACK 鉴定(必要时补验)。
 * @param eng 工程量目标值(物理量);读回值同为物理量(已过 executeRead 标定换算)
 */
export async function verifyRecipeWrite(
  reader: WriteVerifyReader,
  node: Pick<DcwNode, 'id' | 'name' | 'driver' | 'decimals'>,
  eng: number,
  outcome: { ok: boolean, ack?: WriteAckLevel, readback: number | null, message: string },
  opts: { tolerance: number },
): Promise<WriteVerifyOutcome> {
  // ① 命令本身失败:无证实可言(failed)
  if (!outcome.ok) {
    return { verdict: 'failed', ack: 'unverified', attempts: 0, message: outcome.message }
  }
  const ack: WriteAckLevel = outcome.ack ?? (outcome.readback != null ? 'readback-verified' : 'transport-ack')
  // ② 驱动内已独立回读且一致:免补验
  if (ack === 'readback-verified') {
    return { verdict: 'verified', ack, attempts: 0, message: '设备回读证实' }
  }
  const configuredAttempts = process.env.AW_WRITE_VERIFY_ATTEMPTS
  if (configuredAttempts !== undefined && Number(configuredAttempts) <= 0) {
    return { verdict: 'unverified', ack, attempts: 0, message: '写后验证已配置关闭(AW_WRITE_VERIFY_ATTEMPTS≤0)' }
  }
  // ③ 补验:独立回读比对(驱动不支持读时 readNow 返回 ok:false + 不支持文案,立即收敛)
  let lastMsg = ''
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(VERIFY_INTERVAL_MS)
    let r: { ok: boolean, value: number | null, message: string }
    try {
      r = await reader.readNow(node.id)
    }
    catch (err) {
      r = { ok: false, value: null, message: err instanceof Error ? err.message : String(err) }
    }
    if (!r.ok) {
      // 不支持读取的驱动(如 mqtt)无补验通道:如实判 unverified,不空转重试
      lastMsg = r.message
      if (r.message.includes('不支持读取') || r.message.includes('不支持读')) break
      continue
    }
    if (r.value != null && Math.abs(r.value - eng) <= opts.tolerance) {
      return {
        verdict: 'verified',
        ack: 'readback-verified',
        attempts: attempt,
        message: `写后验证证实(第 ${attempt} 次回读 ${Number(r.value.toFixed(node.decimals))} 在容差内)`,
      }
    }
    lastMsg = `回读 ${r.value ?? '无读数'} ≠ 设定 ${eng}(容差 ${opts.tolerance})`
  }
  return {
    verdict: 'unverified',
    ack,
    attempts: VERIFY_ATTEMPTS,
    message: `设备侧未证实:${lastMsg || `节点「${node.name}」(${node.driver})无可用回读通道,仅链路受理`}`,
  }
}

/** 批次 ACK 汇总(三段口径:verified / unverified / failed;ok 但未证实计入 unverified) */
export function summarizeAck(results: Array<{ ok: boolean, verify?: { verdict: string } }>): { verified: number, unverified: number, failed: number, total: number } {
  const s = { verified: 0, unverified: 0, failed: 0, total: results.length }
  for (const r of results) {
    const v = r.verify?.verdict ?? (r.ok ? 'unverified' : 'failed')
    if (v === 'verified') s.verified++
    else if (v === 'failed') s.failed++
    else s.unverified++
  }
  return s
}
