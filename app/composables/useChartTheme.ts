import { computed, ref, watch } from 'vue'

/**
 * 图表主题桥 —— ECharts(zrender)无法消费 CSS 变量与现代 color 语法,
 * 这里把 main.css 令牌读进 JS 侧主题色;单一来源 = main.css,
 * 页面/composable/组件一律禁止再硬编码图表 hex 色板。
 *
 * 双声部原则不变(useDashboardData 既有注释):
 *   亮 = Warm Editorial(--chart-1..5,把品牌绿当"墨"用)
 *   暗 = 控制室 tone(--accent + --tone-*-dot,把同一抹绿当"信号"用)
 *
 * zrender 只认 #hex/rgb()/rgba():带 alpha 的场合由 hexToRgba 在 JS 侧换算,
 * 不透传 color-mix() 等现代语法。
 */
const CHART_VARS = [
  '--ink',
  '--ink-soft',
  '--ink-faint',
  '--paper-raised',
  '--accent',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--tone-info-dot',
  '--tone-warning-dot',
  '--tone-retry-dot',
  '--tone-danger-dot',
] as const

/** 模块级单例:所有图表消费同一份令牌快照,主题切换统一失效重读 */
const vars = ref<Record<string, string>>({})
let installed = false

function readVars(): void {
  if (typeof document === 'undefined')
    return
  const style = getComputedStyle(document.documentElement)
  const next: Record<string, string> = {}
  for (const name of CHART_VARS) next[name] = style.getPropertyValue(name).trim()
  vars.value = next
}

/** #rgb/#rrggbb → rgba(r, g, b, a);解析失败原样返回(zrender 自行兜底) */
export function chartColorAlpha(color: string | undefined, alpha: number): string {
  const raw = (color ?? '').trim()
  let hex = ''
  if (/^#[0-9a-fA-F]{6}$/.test(raw))
    hex = raw.slice(1)
  else if (/^#[0-9a-fA-F]{3}$/.test(raw))
    hex = [1, 2, 3].map(i => raw.slice(i, i + 1).repeat(2)).join('')
  if (hex.length !== 6)
    return raw
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  const parts = ['rgba(', String(r), ', ', String(g), ', ', String(b), ', ', String(alpha), ')']
  return parts.join('')
}

export function useChartTheme() {
  const store = useAppStore()
  if (!installed && typeof window !== 'undefined') {
    installed = true
    readVars()
    watch(() => store.isDark, () => {
      // html.dark 类在 store 翻转的同一同步周期内更新,下一帧读到的即新令牌
      requestAnimationFrame(readVars)
    })
  }

  /** 图表色序:亮 = --chart-1..5;暗 = 控制室 tone 序 */
  const chartPalette = computed<string[]>(() => {
    const v = vars.value
    if (store.isDark) {
      return [v['--accent'], v['--tone-info-dot'], v['--tone-warning-dot'], v['--tone-retry-dot'], v['--tone-danger-dot']]
        .filter((c): c is string => !!c)
    }
    return ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5']
      .map(n => v[n])
      .filter((c): c is string => !!c)
  })

  /** 角色色:仪表盘既有 pal 消费形态(accent/cyan/amber/violet/danger) */
  const pal = computed(() => {
    const p = chartPalette.value
    return {
      accent: p[0] ?? '#35e0a0',
      cyan: p[1] ?? '#41c8f4',
      amber: p[2] ?? '#f6c453',
      violet: p[3] ?? '#a795ff',
      danger: p[4] ?? '#ff8080',
    }
  })

  const ink = computed(() => vars.value['--ink'] || undefined)
  const faint = computed(() => vars.value['--ink-faint'] || undefined)
  const dim = computed(() => chartColorAlpha(vars.value['--ink-soft'], 0.85))
  const split = computed(() => chartColorAlpha(vars.value['--ink-faint'], 0.16))
  const tipBg = computed(() => chartColorAlpha(vars.value['--paper-raised'], 0.96))

  return { chartPalette, pal, ink, faint, dim, split, tipBg }
}
