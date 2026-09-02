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
)
