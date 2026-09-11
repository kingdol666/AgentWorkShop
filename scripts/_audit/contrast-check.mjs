/**
 * 对比度核算(WCAG 2.1) —— 校验"微标签用色"是否达 AA。
 * 用法:node scripts/_audit/contrast-check.mjs
 */
const hex = (h) => {
  const s = h.replace('#', '')
  return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255)
}
const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const lum = (h) => {
  const [r, g, b] = hex(h).map(lin)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

/** 背景取"该文字实际落上的表面" */
const CASES = [
  // 亮阶:文字层
  ['亮 · --ink 于暖纸', '#0c0a09', '#f6f4f1', 4.5],
  ['亮 · --ink-soft 于暖纸', '#4b463f', '#f6f4f1', 4.5],
  ['亮 · --ink-faint 于暖纸(文字最淡档)', '#6f6860', '#f6f4f1', 4.5],
  ['亮 · --ink-faint 于 raised', '#6f6860', '#fffefc', 4.5],
  ['亮 · --focus-ring 于暖纸(焦点环落点)', '#3f6094', '#f6f4f1', 3],
  // 暗阶:文字层
  ['暗 · --ink-faint 于暗面板(文字最淡档)', '#8fa0b5', '#111a28', 4.5],
  ['暗 · --focus-ring 于暗画布', '#6fb3ff', '#0a101a', 3],
  // 回归护栏:装饰令牌**故意**不达 AA —— 记录在案,防止它被重新用作 color
  ['亮 · --ink-fainter 仅装饰(不要求达标)', '#a29a90', '#f6f4f1', 0],
  ['暗 · --ink-fainter 仅装饰(不要求达标)', '#5f6e84', '#111a28', 0],
]

let bad = 0
for (const [name, fg, bg, need] of CASES) {
  const r = ratio(fg, bg)
  const ok = r >= need
  if (!ok) bad++
  console.log(`  ${ok ? '✔' : '✘'} ${name.padEnd(34)} ${r.toFixed(2)}:1  (阈值 ${need}:1)`)
}
console.log(`\n${bad === 0 ? '全部达标' : `${bad} 项未达标`}`)
process.exit(bad === 0 ? 0 : 1)
