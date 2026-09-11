import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  // 项目级规则覆盖
  {
    rules: {
      'vue/multi-word-component-names': 'off',
      '@stylistic/semi': ['error', 'never'],
    },
  },
  // 类型声明文件:payload 泛型透传必须 any,豁免
  {
    files: ['**/*.d.mts', '**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // 一次性审计/调试脚本(_dbg-*):短平快风格,不入主链路,豁免风格规则
  {
    ignores: ['scripts/_dbg-*.mjs'],
  },
  // 审计取证脚本(scripts/_audit/**):为 docs/audit/*.md 的结论提供可复现证据,
  // 写成密集单行是刻意选择(单文件自包含、便于对照报告逐条运行),不是产品代码。
  // 因此只豁免风格类规则,语义/正确性规则(no-undef / no-unused-vars 等)仍然生效。
  {
    files: ['scripts/_audit/**/*.{mjs,ts}'],
    rules: {
      '@stylistic/max-statements-per-line': 'off',
      '@stylistic/brace-style': 'off',
      'no-empty': 'off',
    },
  },
)
