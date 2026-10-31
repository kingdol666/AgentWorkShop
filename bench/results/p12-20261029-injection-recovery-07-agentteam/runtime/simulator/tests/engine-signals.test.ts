/**
 * 信号引擎自测 —— 生成策略数学 + 标定 + 故障注入(纯函数,不依赖运行中的模拟器)。
 */
import { tickSignal, evalExpression, applyWriteback } from '../src/server/engine/signals'
import { encodeRegisters, decodeRegisters, crc16 } from '../src/server/engine/registers'
import type { SignalDef } from '../src/shared/types'

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
function sigOf(partial: Partial<SignalDef>): SignalDef {
  const base: SignalDef = {
    id: 't',
    name: 't',
    strategy: { kind: 'constant', value: 0 },
    runtime: { value: 0, hist: [] },
  }
  return { ...base, ...partial }
}

// ── 策略 ──
{
  const s = sigOf({ strategy: { kind: 'constant', value: 42.5 } })
  check('constant', tickSignal(s, 1000) === 42.5)
}
{
  const s = sigOf({ strategy: { kind: 'sine', base: 50, amp: 10, periodMs: 2000 } })
  const v1 = tickSignal(s, 0)
  const v2 = tickSignal(s, 500)
  const v3 = tickSignal(s, 1000)
  check('sine 相位推进', v1 === 50 && v2 === 60 && Math.abs(v3 - 50) < 1e-9, `${v1},${v2},${v3}`)
}
{
  const s = sigOf({ strategy: { kind: 'random-walk', start: 50, step: 1, min: 0, max: 100 } })
  let inRange = true
  for (let i = 0; i < 500; i++) {
    const v = tickSignal(s, i * 100)
    if (v < 0 || v > 100) inRange = false
  }
  check('random-walk 钳位 [0,100]', inRange)
}
{
  const s = sigOf({ strategy: { kind: 'ramp', start: 0, end: 100, durationMs: 1000, loop: false } })
  tickSignal(s, 0)
  const mid = tickSignal(s, 500)
  const end = tickSignal(s, 1500)
  check('ramp 爬坡 + 终点保持', Math.abs(mid - 50) < 1 && end === 100, `mid=${mid.toFixed(1)} end=${end}`)
}
{
  // 一阶惯性:PV 向 SP 收敛(τ=1000ms,dt=500ms → 每拍前进 ~39%)
  const s = sigOf({ strategy: { kind: 'first-order', initial: 20, tauMs: 1000, sp: 100, noise: 0 } })
  let v = 0
  for (let i = 0; i < 30; i++) v = tickSignal(s, i * 500)
  check('first-order 收敛至 SP', Math.abs(v - 100) < 0.5, `after 15s pv=${v.toFixed(2)}`)
}
{
  // 外部写回灌:first-order.sp 更新 → PV 收敛到新 SP(DCW 闭环核心)
  const s = sigOf({ strategy: { kind: 'first-order', initial: 20, tauMs: 500, sp: 20, noise: 0 } })
  applyWriteback(s, 180)
  let v = 0
  for (let i = 0; i < 30; i++) v = tickSignal(s, i * 300)
  check('writeback → first-order 收敛新 SP', Math.abs(v - 180) < 0.5, `pv=${v.toFixed(2)} sp=${(s.strategy as { sp: number }).sp}`)
}
{
  const s = sigOf({ strategy: { kind: 'manual', value: 0 } })
  applyWriteback(s, 66.5)
  check('writeback → manual 立即生效', s.runtime!.value === 66.5)
}
{
  // 标定:输出 = value × scale + offset
  const s = sigOf({ strategy: { kind: 'constant', value: 100 }, scale: 0.1, offset: 5 })
  check('标定 scale/offset', tickSignal(s, 1000) === 15)
}

// ── 表达式 ──
{
  check('表达式引用 [变量]', Math.abs(evalExpression('[t1] * 2 + 1', { t1: 10 }) - 21) < 1e-9)
  let threw = false
  try { evalExpression('[a]; require("fs")', {}) } catch { threw = true }
  check('表达式白名单拒绝注入', threw)
}

// ── 故障注入 ──
{
  const s = sigOf({ strategy: { kind: 'sine', base: 50, amp: 10, periodMs: 1000 }, faults: { stuckAt: true } })
  tickSignal(s, 0)
  const v1 = tickSignal(s, 100)
  const v2 = tickSignal(s, 250)
  const v3 = tickSignal(s, 400)
  check('stuckAt 卡值', v1 === v2 && v2 === v3, `${v1},${v2},${v3}`)
}
{
  const s = sigOf({ strategy: { kind: 'constant', value: 50 }, min: 0, max: 100, faults: { spike: { probability: 1, durationMs: 5000, overshoot: 0.3 } } })
  tickSignal(s, 0)
  const v = tickSignal(s, 100)
  check('spike 尖峰越限(强制触发)', v === 80, `value=${v}`)
}

// ── 寄存器编码(与主项目 decodeRegisters 对称) ──
{
  const words = encodeRegisters(182.0, 'float32', 'big')
  check('float32 big 编码', words.length === 2 && words[0] === 0x4336 && words[1] === 0x0000, words.map(w => w.toString(16)).join(','))
  check('编码↔解码 对称', Math.abs(decodeRegisters(words, 'float32', 'big') - 182.0) < 1e-6)
  for (const bo of ['big', 'little', 'wordSwap']) {
    const w = encodeRegisters(-123.456, 'float32', bo)
    check(`float32 ${bo} 对称`, Math.abs(decodeRegisters(w, 'float32', bo) + 123.456) < 1e-3)
  }
  const w16 = encodeRegisters(-5, 'int16', 'big')
  check('int16 编码↔解码', decodeRegisters(w16, 'int16', 'big') === -5)
}

// ── CRC16(RTU raw 模式) ──
{
  // 标准 Modbus 校验帧:01 03 00 00 00 02 → CRC C4 0B
  const buf = Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x02])
  const crc = crc16(buf)
  check('CRC16 标准向量', crc === 0x0BC4, `0x${crc.toString(16)}`)
}

console.log(`\nengine 自测: ${passed} passed / ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
