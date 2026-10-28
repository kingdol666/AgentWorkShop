/**
 * 2026-10-28 多专家审查整改 P0:
 *  P0-1 Modbus 字节序三序一致(ABCD/CDAB/DCBA)且写读互逆;
 *  P0-2 掩码凭据不得回写(入口单点剔除)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'

const { decodeRegisters } = await import('../server/services/workshop/daq/drivers/modbus-tcp')
const { encodeWords } = await import('../server/services/workshop/dcw/drivers/shared')
const { maskDriverConfigSecrets, stripMaskedSecrets, MASKED_SECRET } = await import('../shared/daq-protocol')

/** 12.5f = 0x41 48 00 00(A=0x41,B=0x48,C=0x00,D=0x00) */
const F125 = 12.5
const REGS = {
  ABCD: [0x4148, 0x0000],
  CDAB: [0x0000, 0x4148],
  DCBA: [0x0000, 0x4841],
  BADC: [0x4841, 0x0000],
} as const

test('P0-1:decodeRegisters 三序按标准字节布局解出 12.5', () => {
  assert.equal(decodeRegisters([...REGS.ABCD], 'float32', 'big'), F125)
  assert.equal(decodeRegisters([...REGS.CDAB], 'float32', 'wordSwap'), F125)
  assert.equal(decodeRegisters([...REGS.DCBA], 'float32', 'little'), F125)
})

test('P0-1:旧缺陷回归 —— DCBA 设备寄存器走 little 不再解成 1e-41 量级', () => {
  const v = decodeRegisters([...REGS.DCBA], 'float32', 'little')
  assert.equal(v, F125)
  // 旧实现([hi(w1),lo(w1),hi(w0),lo(w0)].reverse())会得到 0x00004148 ≈ 2.3e-41
  assert.ok(Math.abs(v) > 1, `解得 ${v},仍是位序错乱的极小值`)
})

test('P0-1:encodeWords 与 decodeRegisters 在三序×float32/int32/uint32 上互逆', () => {
  const cases: Array<{ type: 'float32' | 'int32' | 'uint32', value: number }> = [
    { type: 'float32', value: 12.5 },
    { type: 'float32', value: -3.75 },
    { type: 'int32', value: -123456 },
    { type: 'int32', value: 987654 },
    { type: 'uint32', value: 4000000000 },
    { type: 'uint32', value: 7 },
  ]
  for (const order of ['big', 'wordSwap', 'little'] as const) {
    for (const c of cases) {
      const words = encodeWords(c.value, c.type, order)
      assert.equal(words.length, 2, `${order}/${c.type} 应编码为 2 个寄存器`)
      const back = decodeRegisters(words, c.type, order)
      assert.equal(back, c.value, `${order}/${c.type}/${c.value}`)
    }
  }
})

test('P0-1:int16 不受字节序影响(单寄存器)', () => {
  for (const order of ['big', 'wordSwap', 'little'] as const) {
    assert.equal(decodeRegisters([encodeWords(-1234, 'int16', order)[0]!], 'int16', order), -1234)
  }
})

test('P0-2:出向脱敏与入向剔除同源,掩码绝不覆盖真实凭据', () => {
  // 测试替身:运行时拼接,避免源码里出现"像真凭据"的字面量
  const secret = ['test', 'fixture', 'value'].join('-')
  const rotated = ['rotated', 'fixture', 'value'].join('-')
  const real = { host: '10.0.0.5', password: secret, apiKey: 'k-123', unitId: 1 }
  const masked = maskDriverConfigSecrets(real)
  assert.equal(masked.password, MASKED_SECRET)
  assert.equal(masked.apiKey, MASKED_SECRET)
  assert.equal(masked.host, '10.0.0.5')

  // 整包回写(GET 投影原样 PATCH):掩码键被剔除,真实凭据保持不变
  const patch = stripMaskedSecrets(masked)
  assert.equal(patch.password, undefined)
  assert.equal(patch.apiKey, undefined)
  assert.equal(patch.host, '10.0.0.5')

  // 新明文照常写入
  const updated = stripMaskedSecrets({ password: rotated, host: '10.0.0.6' })
  assert.equal(updated.password, rotated)
  assert.equal(updated.host, '10.0.0.6')

  // 非敏感键即使值恰为掩码串也不误伤(掩码哨兵只对敏感键生效)
  const literal = stripMaskedSecrets({ note: MASKED_SECRET })
  assert.equal(literal.note, MASKED_SECRET)
})
