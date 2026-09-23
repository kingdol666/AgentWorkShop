/**
 * OPC UA 写驱动(会话池复用 + 重试)
 * (由 server/services/workshop/dcw/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DcwWriteDriver, DcwWriteInput, DcwWriteResult } from './shared'
import { AppError } from '../../../../utils/errors'
import { classifyCommError, evictOpcUaConn, getOpcUaConn } from '../../daq/drivers'
import { reqNative } from './shared'

// ============================================================
// OPC UA 写驱动(写节点值 + 回读校验;会话池复用数采)
// ============================================================

export async function opcuaWrite(input: DcwWriteInput): Promise<DcwWriteResult> {
  const cfg = input.driverConfig
  if (!cfg.endpoint) throw new AppError(400, 'BAD_REQUEST', '缺少端点 endpoint(opc.tcp://…)')
  if (!cfg.nodeId) throw new AppError(400, 'BAD_REQUEST', '缺少节点 ID nodeId(ns=…;s=…)')
  const conn = await getOpcUaConn(cfg)
  // 会话死亡自愈:连续 3 次故障驱逐重建(与数采采样路径同策略)。此前纯写控节点
  // 会拿同一个死 session 反复失败,直到 10 分钟空闲 sweep 才可能重建。
  try {
    return await opcuaWriteOnce(conn, input)
  }
  catch (err) {
    conn.errors++
    if (conn.errors >= 3) void evictOpcUaConn(cfg)
    throw err
  }
}

export async function opcuaWriteOnce(conn: { session: import('node-opcua').ClientSession, errors: number }, input: DcwWriteInput): Promise<DcwWriteResult> {
  const cfg = input.driverConfig
  const opcua = reqNative('node-opcua') as typeof import('node-opcua')
  const node = opcua.coerceNodeId(String(cfg.nodeId))
  const writeResult = await conn.session.write({
    nodeId: node,
    attributeId: opcua.AttributeIds.Value,
    value: { value: { dataType: opcua.DataType.Double, value: input.eng } },
  }) as unknown as { statusCode?: { value: number } }
  const writeCode = writeResult.statusCode?.value ?? 0
  if (writeCode !== 0) {
    throw new Error(`写入状态异常: 0x${writeCode.toString(16)}`)
  }
  const dv = await conn.session.read({ nodeId: node, attributeId: opcua.AttributeIds.Value }) as unknown as { value?: { value?: number } }
  const back = typeof dv.value?.value === 'number' ? dv.value.value : Number(dv.value?.value)
  const ok = Number.isFinite(back) && Math.abs(back - input.eng) <= input.tolerance
  return {
    ok,
    message: ok
      ? `写入并回读一致:${input.eng},回读 ${Number(back.toFixed(4))}`
      : `回读偏差超容差:写 ${input.eng},回读 ${Number.isFinite(back) ? back.toFixed(4) : '非数值'}`,
    raw: input.eng,
    readback: Number.isFinite(back) ? back : null,
  }
}

export const opcUaDcwDriver: DcwWriteDriver = {
  kind: 'opcua',
  async available() {
    try {
      reqNative('node-opcua')
      return true
    }
    catch {
      return false
    }
  },
  async write(input) {
    try {
      return await opcuaWrite(input)
    }
    catch (err) {
      if (err instanceof AppError) throw err
      return { ok: false, message: `OPC UA 写入失败: ${classifyCommError(err)}`, raw: null, readback: null }
    }
  },
  async read(input) {
    try {
      const cfg = input.driverConfig
      if (!cfg.endpoint) throw new AppError(400, 'BAD_REQUEST', '缺少端点 endpoint(opc.tcp://…)')
      if (!cfg.nodeId) throw new AppError(400, 'BAD_REQUEST', '缺少节点 ID nodeId(ns=…;s=…)')
      const conn = await getOpcUaConn(cfg)
      const opcua = reqNative('node-opcua') as typeof import('node-opcua')
      const dv = await conn.session.read({ nodeId: opcua.coerceNodeId(String(cfg.nodeId)), attributeId: opcua.AttributeIds.Value }) as unknown as { value?: { value?: unknown }, status?: { value?: number }, statusCode?: { value?: number } }
      const code = dv.status?.value ?? dv.statusCode?.value ?? 0
      if (code !== 0) return { ok: false, message: `节点读取状态异常: 0x${code.toString(16)}`, eng: null, raw: null }
      const v = Number(dv.value?.value)
      if (!Number.isFinite(v)) return { ok: false, message: '节点值为非数值', eng: null, raw: null }
      return { ok: true, message: `读回 ${Number(v.toFixed(4))}`, eng: v, raw: v }
    }
    catch (err) {
      return { ok: false, message: `OPC UA 读取失败: ${classifyCommError(err)}`, eng: null, raw: null }
    }
  },
  async test(driverConfig) {
    try {
      if (!driverConfig.endpoint) return { ok: false, message: '缺少端点 endpoint(opc.tcp://…)' }
      if (!driverConfig.nodeId) return { ok: false, message: '缺少节点 ID nodeId(ns=…;s=…)' }
      const conn = await getOpcUaConn(driverConfig)
      const opcua = reqNative('node-opcua') as typeof import('node-opcua')
      const dv = await conn.session.read({ nodeId: opcua.coerceNodeId(String(driverConfig.nodeId)), attributeId: opcua.AttributeIds.Value }) as unknown as { status?: { value?: number }, statusCode?: { value?: number } }
      const code = dv.status?.value ?? dv.statusCode?.value ?? 0
      if (code !== 0) return { ok: false, message: `节点不可读: 0x${code.toString(16)}` }
      return { ok: true, message: `会话建立成功,写节点可访问(${String(driverConfig.nodeId)})` }
    }
    catch (err) {
      return { ok: false, message: classifyCommError(err) }
    }
  },
}
