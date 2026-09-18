import {
  defineConfig,
  presetAttributify,
  presetIcons,
  presetTypography,
  presetUno,
  transformerDirectives,
  transformerVariantGroup,
} from 'unocss'

// UnoCSS 配置：与 Ant Design Vue 共存，主题色经 CSS 变量与 config.yml 对齐。
// preset-icons 让 `i-tabler-xxx` 等 class 在任意模板/插槽中直接渲染图标。
export default defineConfig({
  presets: [
    presetUno(),
    // ⚠️ prefixedOnly:只有 `u:` 开头的属性才当工具类。
    //
    // 不加这个开关时,attributify 会去扫描模板里的**原始文本**,把 Vue 的事件绑定
    // 当成属性工具类:本项目有 64 处 `@blur` / `@change` / `@resize` / `@focus`…
    // 于是 `@blur="mentionOpen = false"` 被解析成 blur 工具类,产物里多出
    // `[blur="..."]` 这种垃圾选择器,以及
    //   box-shadow: calc(var(--un-ring-offset-shadow), * -1) var(--un-ring-shadow), …
    // —— 一个**语法都不合法**的值,postcss 直接报 lexical error(实测构建告警)。
    //
    // 本项目模板**没有任何**无前缀 attributify 用法(实测 grep `="~` 与裸工具类属性均为 0),
    // 所以收紧为 prefixedOnly 是零代价的:既消掉告警,也消掉一整类误判。
    presetAttributify({ prefixedOnly: true }),
    presetIcons({
      scale: 1.2,
      warn: true,
    }),
    presetTypography(),
  ],
  transformers: [
    transformerDirectives(),
    transformerVariantGroup(),
  ],
  theme: {
    colors: {
      primary: 'var(--color-primary)',
    },
  },
  shortcuts: {
    'flex-center': 'flex items-center justify-center',
    'flex-between': 'flex items-center justify-between',
    'flex-col-center': 'flex flex-col items-center justify-center',
  },
})
