/**
 * 信号生成策略库 —— 模拟真实物理设备数据的核心。
 *
 * 设计:每信号独立策略 + 故障注入 + 标定;tick(now) 纯推进内部状态,无 IO。
 * 一阶惯性工艺闭环抄自主项目 scripts/dev-plc-simulator.mjs 已验证的动力学:
 *   PV' = PV + (SP − PV)·(1 − e^(−dt/τ)) + 噪声·sqrt(dt·2)
 */
import type { SignalDef, SignalStrategy } from '../../shared/types'

/** 简易安全表达式求值:只允许数字/四则/括号/常用函数,变量用 [信号名] 引用 */
export function evalExpression(expr: string, vars: Record<string, number>): number {
  // 展开 [name] → (value);未知信号按 0 处理
  const expanded = expr.replace(/\[([^\[\]]+)\]/g, (_, name) => {
    const v = vars[String(name).trim()]
    return `(${Number.isFinite(v) ? v : 0})`
  })
  // 白名单字符校验:数字/运算符/括号/点/空格/科学计数 e
  if (!/^[-+*/%().\d\s,e]*$/.test(expanded)) throw new Error(`表达式含非法字符: ${expr}`)
  const body = `
    const { abs, min, max, round, floor, ceil, sqrt, pow, sin, cos, tan, log, exp, PI } = Math;
    return (${expanded});
  `
  const fn = new Function('Math', body)
  const v = fn(Math)
  if (!Number.isFinite(v)) throw new Error(`表达式结果非有限数: ${expr}`)
  return v
}

/** 高斯噪声(Box-Muller) */
export function gauss(): number {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const clamp = (v: number, min?: number, max?: number) =>
  Math.min(Math.max(v, min ?? -Infinity), max ?? Infinity)

/** 应用故障注入:返回 { value, faulted } */
function applyFaults(sig: SignalDef, raw: number, now: number): { value: number, faulted: boolean } {
  const f = sig.faults
  if (!f) return { value: raw, faulted: false }
  const rt = sig.runtime!
  let value = raw
  let faulted = false
  if (f.stuckAt) {
    // 卡值:冻结在上一拍值;首拍(hist 为空)放行,否则永远 0
    if (rt.hist && rt.hist.length > 0) {
      value = rt.value
      faulted = true
    }
  }
  if (f.spike) {
    if (rt.spikeUntil && now < rt.spikeUntil) {
      const range = (sig.max ?? 100) - (sig.min ?? 0)
      value = clamp(value + range * f.spike.overshoot, sig.min, sig.max)
      faulted = true
    }
    else if (Math.random() < f.spike.probability) {
      rt.spikeUntil = now + f.spike.durationMs
    }
  }
  if (f.drift) {
    value = value + f.drift.perTick
    faulted = true
  }
  return { value, faulted }
}

/** 推进单个信号一拍:返回新值(已含故障+标定);hist 由此维护(cap 60) */
export function tickSignal(sig: SignalDef, now: number): number {
  const rt = sig.runtime!
  const prev = rt.value
  // 首拍 dt=0(只初始化,不推进时间);后续按真实间隔
  const dt = rt.lastTick === undefined ? 0 : Math.max(now - rt.lastTick, 0)
  rt.lastTick = now
  const s: SignalStrategy = sig.strategy
  let raw = 0
  switch (s.kind) {
    case 'constant':
    case 'manual':
      raw = s.value
      break
    case 'sine':
      raw = s.base + s.amp * Math.sin((2 * Math.PI * now) / Math.max(s.periodMs, 1))
      break
    case 'random-walk': {
      if (rt.cursor === undefined) rt.cursor = s.start
      rt.cursor = clamp(rt.cursor + gauss() * s.step, s.min, s.max)
      raw = rt.cursor
      break
    }
    case 'ramp': {
      if (rt.cursor === undefined) rt.cursor = 0
      rt.cursor += dt
      const duration = Math.max(s.durationMs, 1)
      let p = rt.cursor / duration
      if (p >= 1) {
        if (s.loop) { rt.cursor = 0; p = 0 }
        else p = 1
      }
      raw = s.start + (s.end - s.start) * p
      break
    }
    case 'first-order': {
      // PV' = PV + (SP − PV)·(1 − e^(−dt/τ)) + 噪声·sqrt(dt·2)
      const alpha = 1 - Math.exp(-dt / Math.max(s.tauMs, 1))
      raw = prev + (s.sp - prev) * alpha + gauss() * s.noise * Math.sqrt((dt / 1000) * 2)
      break
    }
    case 'expression':
      // 变量注入在调用方(node.ts)通过 strategy 预替换;此处裸表达式引用 runtime.cursor
      raw = evalExpression(s.expr, {})
      break
  }
  // stuckAt 冻结:非首拍直接返回上一拍值(不推进、不覆盖)
  if (sig.faults?.stuckAt && rt.hist && rt.hist.length > 0) {
    rt.hist.push(rt.value)
    if (rt.hist.length > 60) rt.hist.shift()
    return rt.value
  }
  const { value } = applyFaults(sig, raw, now)
  // 标定:输出 = value × scale + offset(与主项目 DataTransform 同约定)
  const out = value * (sig.scale ?? 1) + (sig.offset ?? 0)
  const dec = sig.decimals ?? 3
  rt.value = Number(out.toFixed(dec))
  rt.hist!.push(rt.value)
  if (rt.hist!.length > 60) rt.hist!.shift()
  return rt.value
}

/** 表达式策略:由 node.ts 注入其他信号变量后求值 */
export function tickExpressionSignal(sig: SignalDef, vars: Record<string, number>, now: number): number {
  const rt = sig.runtime!
  rt.lastTick = now
  const raw = evalExpression(sig.strategy.kind === 'expression' ? sig.strategy.expr : '0', vars)
  const { value } = applyFaults(sig, raw, now)
  const out = value * (sig.scale ?? 1) + (sig.offset ?? 0)
  rt.value = Number(out.toFixed(sig.decimals ?? 3))
  rt.hist!.push(rt.value)
  if (rt.hist!.length > 60) rt.hist!.shift()
  return rt.value
}

// ============================================================
// hook 策略:用户自定义数据产生器(代码动态注入)
// ============================================================

/** 编译缓存:code → Function(配置对象被替换后自然失效,WeakMap 不驻留) */
const hookCache = new WeakMap<object, (ctx: Record<string, unknown>) => unknown>()

function compileHook(sig: SignalDef): (now: number, dt: number, prev: number, state: Record<string, unknown>, vars: Record<string, number>, min: number, max: number, rand: () => number) => unknown {
  const s = sig.strategy as { kind: 'hook', code: string }
  const cached = hookCache.get(s)
  if (cached) return cached as never
  if (typeof s.code !== 'string' || s.code.length > 20_000) throw new Error('hook.code 缺失或超长(>20k)')
  // producer 函数体:return 数据即可;禁 import/process/require(本地模拟工具的护栏)
  if (/\b(import|require|process|globalThis)\b/.test(s.code)) throw new Error('hook.code 含禁用标识符(import/require/process/globalThis)')
  const fn = new Function('now', 'dt', 'prev', 'state', 'vars', 'min', 'max', 'rand', `"use strict";\n${s.code}`) as never
  hookCache.set(s, fn)
  return fn
}

/**
 * hook 策略推进:每拍调用 producer;timegapMs 节流(未到间隔保持上一拍输出)。
 * 返回 number → 标量;{points:[…]} → vector 帧;{png,width,height} → image 帧。
 * producer 体内可直接引用 now/dt/prev/state/vars/min/max/rand(参数解构作用域)。
 */
export function tickHookSignal(sig: SignalDef, vars: Record<string, number>, now: number): number {
  const rt = sig.runtime!
  const s = sig.strategy as { kind: 'hook', code: string, timegapMs?: number, state?: Record<string, unknown> }
  rt.lastTick = now
  if (!s.state) s.state = {}
  const gap = Math.max(s.timegapMs ?? 0, 0)
  if (gap > 0 && typeof rt.cursor === 'number' && now - rt.cursor < gap) {
    return rt.value // 节流窗内:保持上一拍
  }
  rt.cursor = now
  const fn = compileHook(sig)
  const dt = rt.prevTick ? Math.max(now - rt.prevTick, 0) : 0
  rt.prevTick = now
  const out = fn(now, dt, rt.value, s.state, vars, sig.min ?? 0, sig.max ?? 100, Math.random) as unknown
  if (typeof out === 'number' && Number.isFinite(out)) {
    const { value } = applyFaults(sig, out, now)
    rt.value = Number((value * (sig.scale ?? 1) + (sig.offset ?? 0)).toFixed(sig.decimals ?? 3))
  }
  else if (out && typeof out === 'object') {
    const o = out as { points?: unknown, png?: unknown, width?: unknown, height?: unknown, value?: unknown }
    if (Array.isArray(o.points)) {
      rt.vector = (o.points as unknown[]).map(Number).filter(Number.isFinite).slice(0, 4096)
      const avg = rt.vector.reduce((a, b) => a + b, 0) / Math.max(rt.vector.length, 1)
      rt.value = Number(avg.toFixed(sig.decimals ?? 3))
    }
    else if (typeof o.png === 'string') {
      rt.image = { png: o.png, width: Number(o.width ?? 0) || 0, height: Number(o.height ?? 0) || 0 }
      rt.value = Number(o.value ?? rt.value ?? 0)
    }
    else if (Number.isFinite(Number(o.value))) {
      rt.value = Number(Number(o.value).toFixed(sig.decimals ?? 3))
    }
  }
  rt.hist!.push(rt.value)
  if (rt.hist!.length > 60) rt.hist!.shift()
  return rt.value
}

/**
 * 外部写回灌(协议写到达时统一入口):first-order 改 sp(闭环),其余策略改目标值;
 * manual/constant 立即落到 runtime.value(DCW 写后同址回读一致依赖此语义)。
 * out 为「输出域」物理值(主项目 DCW 写入 raw × scale + offset)。
 */
export function applyWriteback(sig: SignalDef, out: number): void {
  if (!sig.runtime) sig.runtime = { value: 0, hist: [] }
  if (sig.strategy.kind === 'first-order') sig.strategy.sp = out
  else if (sig.strategy.kind === 'manual' || sig.strategy.kind === 'constant') sig.strategy.value = out
  // 其余策略(sine/random-walk/ramp/expression):外部写仅立即生效到当前值,下一拍回到策略曲线
  sig.runtime.value = Number(out.toFixed(sig.decimals ?? 3))
}
